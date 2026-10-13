---
type: Subsystem Reference
title: Standards alignment, catalog and tag suggestions
description: How the design tool tags items with state standards (WA 2026 and CCSS 2010 crosswalk, NGSS), how the generated catalog is built and searched, the scheme:code tag format and its limits, the staff picker route, the AI suggestion flow, and why tags never reach students.
tags: [standards, alignment, catalog, tags, authoring, ai]
openwiki:
  roles: [domain, workflow]
  change_kinds: [public-api, persistence, generated-artifact]
  source_paths:
    - design-tool/lib/standards/catalog.ts
    - design-tool/lib/standards/search.ts
    - design-tool/lib/standards/tags.ts
    - design-tool/lib/standards/types.ts
    - design-tool/lib/standards/build.ts
    - design-tool/app/api/standards/route.ts
    - design-tool/app/api/ai/suggest-standards/route.ts
    - design-tool/lib/ai/standardsSuggestCore.ts
    - design-tool/lib/api/items.ts
    - design-tool/lib/api/requireDraft.ts
    - design-tool/lib/insights/evidencePack.ts
    - design-tool/db/schema.ts
  symbols: [StandardsField, normalizeStandards, tagFor, parseTag, lookup, search, searchStandards, resolveBareCode, counterparts, resolveForReporting, loadCandidates, validateSuggestions, isAnswerKeyOnlyPatch, buildStandards]
  test_paths:
    - design-tool/test/standards-catalog.test.ts
    - design-tool/test/standards-api.test.ts
    - design-tool/test/standards-ngss.test.ts
    - design-tool/test/standards-suggest-core.test.ts
    - design-tool/test/ai-suggest-standards.test.ts
    - design-tool/test/item-standards.test.ts
    - design-tool/test/standards-tag-input.test.tsx
  invariants:
    - A stored tag is either scheme:code for a catalog pick (wa2026, ccss2010 or ngss) or a teacher's own free text; a bare code typed as text becomes a catalog tag only when the picker's `exact` answer names exactly one scheme.
    - An item carries at most 10 tags of at most 80 characters each.
    - Standards tags are authoring metadata and never appear in the student delivery bundle.
    - The AI suggestion route writes nothing; a suggestion becomes a tag only through an ordinary item save.
    - Suggested codes outside the candidate slice that was sent to the model are dropped.
    - Standards-only edits pass the publish lock, but the catalog JSON is never read at request time by client code.
  validation_commands:
    - cd design-tool && bun test test/standards-catalog.test.ts test/standards-suggest-core.test.ts
---

# Standards alignment

Teachers tag each item with the state standards it assesses. Tags let the teacher's reports and class insights group results by standard, and let the AI propose tags for an untagged assessment. The tag vocabulary comes from a **generated catalog** built from OSPI's adoption workbooks and the NGSS performance expectations. The catalog never ships to the browser: staff reach it only through server routes.

Consult this page when changing the catalog build, the tag format, the picker or suggestion routes, or anything that reads `items.standards`. Item save and publish rules live in [authoring](authoring.md#draftpublished-lock); the AI provider pattern and guardrail wrapper are described in [AI and safeguarding](ai-and-safeguarding.md).

## Tags and schemes

Three catalog schemes exist: `wa2026` (the 2026 Washington math and ELA standards), `ccss2010` (the Common Core 2011 edition, linked to 2026 through a crosswalk), and `ngss` (science). A catalog pick is stored as `scheme:code`, for example `wa2026:M.7.R.RP.2`. Anything else is a teacher designation and is kept exactly as typed.

- `items.standards` is a `jsonb` array, default `[]` (migration `0050_item_standards.sql`). It is a column of its own, not part of `items.config`, so the answer-key comparison in `isAnswerKeyOnlyPatch` never sees it.
- `StandardsField` in `lib/api/items.ts` is the write boundary: it trims and dedupes through `normalizeStandards` (`lib/standards/tags.ts`), enforces `MAX_STANDARDS` (10) and `MAX_STANDARD_LENGTH` (80).
- `addTag` and `chipLabel` in `lib/standards/tags.ts` apply the same limits in the editor, so the page never sends a body the server rejects. This file is safe to import into a client component because it never touches the catalog JSON.

## Catalog build

The catalog is generated, not hand-edited. The committed inputs live in `lib/standards/sources/`, including the NGSS intermediate JSON.

| Step | Command | What it does |
|---|---|---|
| Extract NGSS | `bun run standards:extract-ngss <AllDCI.pdf>` (`scripts/extract-ngss.ts`) | Writes `lib/standards/sources/ngss-performance-expectations.json` from the NGSS PDF |
| Build | `bun run standards:build` (`scripts/build-standards.ts`) | Checks each source file's sha256, then calls `buildStandards` in `lib/standards/build.ts` and writes `lib/standards/catalog.json` and `crosswalk.json` |

`buildStandards` is a pure transform: the test re-runs it in memory and compares the result with the committed JSON, so a stale or hand-edited artifact fails the test. Regenerate the JSON with the script; do not edit it. Only `catalog.ts` imports the JSON files, and only at module load; `search.ts` and the routes work through it.

## Server lookup

`lib/standards/catalog.ts` builds in-memory indexes once: by tag, by bare code and by crosswalk pair. Its exported functions are `lookup`, `findByBareCode`, `search`, `gradeBands`, `courses` and `counterparts`. `counterparts` follows the crosswalk, so a 2011 tag lists its 2026 links and the reverse.

`lib/standards/search.ts` shapes results for the API. `searchStandards` ranks exact code, then code prefix, then code substring, then text, and with `prefer` it brings the preferred scheme's counterparts forward at the same rank. `resolveBareCode` turns a typed code into a tag only when exactly one scheme owns that code. `lookupTags` resolves a list of stored tags for display. The staff-only `GET /api/standards/lookup?tags=a,b` route (`app/api/standards/lookup/route.ts`) returns that data as chip entries (`{ code, scheme, text }`, or `null` for a custom designation or an unknown code). It accepts at most `LOOKUP_MAX_TAGS` tags and answers `400 too_many_tags` above that. The route's own comment describes it as the chip data for an item's stored tags, which the editor shows as typed when the entry is `null`.

## Picker route

`GET /api/standards` (`app/api/standards/route.ts`) is the only way a page reads the catalog. It requires `requireStaff()`, validates `subject`, `scheme`, `prefer` and `limit`, and returns `{ results, exact, facets }`. `exact` is the tag a bare code resolves to, so Enter on typed text stores the catalog tag. `standards-api.test.ts` checks that no client component imports the catalog.

## Suggest standards

`POST /api/ai/suggest-standards` (`app/api/ai/suggest-standards/route.ts`) proposes tags for an assessment's untagged items. The flow is:

```mermaid
sequenceDiagram
    participant T as Teacher editor
    participant R as suggest-standards route
    participant C as Catalog slice
    participant G as runGuarded
    participant P as AI provider
    T->>R: subject, grade band, course, optional unit list
    R->>R: requireStaff, authorizeAssessment at edit, allow_llm_authoring
    R->>C: loadCandidates for subject, band and course in one scheme
    R->>G: run with surface tag-suggest
    G->>P: suggestStandards with first 40 untagged items
    P-->>G: proposed tags with reasons
    G-->>R: validateSuggestions drops codes outside the candidates
    R-->>T: suggestions, considered count and left_out count
    Note over T,R: Nothing is written; accepting a tag is an ordinary item save
```

Rules that matter when changing this flow:

- The scheme is `ngss` for science and otherwise the preferred scheme, defaulting to `wa2026` (`candidateScheme`).
- The candidate set is the catalog slice for the subject, grade band and optional HS math course, capped at `SUGGEST_MAX_CANDIDATES` (250). A pasted unit list narrows the slice to the codes it names, and falls back to the whole slice when it names none.
- At most `SUGGEST_MAX_ITEMS` (40) untagged items are sent in one call. `left_out` counts the rest, and accepted items stop being untagged, so a second run covers them.
- The pasted unit list is the only free text the teacher supplies here, so it is the input screened by the guardrail; the questions are not screened.
- `validateSuggestions` drops any code outside the sent candidates, so model output cannot introduce a tag the catalog does not contain.

## Reporting and insights

Class insights display tags through `lookupTags` and `chipLabel` (`lib/insights/evidencePack.ts`), so an unknown tag shows as stored. `resolveForReporting` in `catalog.ts` is a separate rule for mapping a 2011 tag to a single linked 2026 standard. At this revision it has no production caller in `lib/`, `app/` or `scripts/`; only the standards tests exercise it. Treat it as an available helper, not as the rule insights follow, and verify before relying on it for grouping.

## Change guidance

- **New scheme or subject**: add it to `StandardScheme`/`StandardSubject` in `lib/standards/types.ts`, the build in `lib/standards/build.ts`, and the mirrored `SCHEMES` lists (`catalog.ts`, `search.ts`, `tags.ts`). Then rerun the build and the catalog tests.
- **Tag rule change**: update `StandardsField`, `normalizeStandards` and the client mirror in `tags.ts` together, and keep `MAX_STANDARDS` in sync with the editor.
- **Export and import**: `exportBundle.ts` emits `standards` only when non-empty, and `importBundle.ts` normalizes them, so older bundles stay byte-stable. Changing this touches [wire formats](../architecture/wire-formats.md).
- Do not hand-edit `catalog.json` or `crosswalk.json`. Their source-of-truth is the build script and the committed sources.
- Focused checks: `cd design-tool && bun test test/standards-catalog.test.ts test/standards-suggest-core.test.ts`. Route checks (`standards-api.test.ts`, `ai-suggest-standards.test.ts`) and the item write checks (`item-standards.test.ts`) are the next step when the HTTP contract changes. The build equality check is part of `standards-catalog.test.ts`; run the build script only when the source files change.
.

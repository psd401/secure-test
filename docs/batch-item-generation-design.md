# Batch item generation + standards tags (roadmap row BG)

Design note, 2026-10-02. Trigger: open-beta teacher feedback — "a way to
have AI help with generating multiple questions in one batch tied to a
standard, objective, or uploaded resource." This note also carries the
**standards / learning-target tag** that `docs/class-insights-design.md`
(row CI) reads, because tagging is an authoring concern. Decisions marked
**D-n**; James's answers of 2026-10-02 are recorded as decided, the rest
are recommendations. **§Progress says what is built** (nothing yet).

## Relation to the roadmap

- **Reverses D-7 in part** (`docs/roadmap-2026-09.md` "D-7 standards /
  learning-target tags: later"; `docs/reporting-design.md` repeats it).
  James 2026-10-02: tags become an **optional** item field now. Reporting
  v1 stays as built; class insights is the first reader.
- **Extends, does not replace**, the single-item generator
  (`POST /api/ai/generate-item`, `lib/ai/itemGenCore.ts`), which stays for
  "one more like this".
- **Reuses** the PDF import's proposal-card list (`import-pdf` route + the
  panel's per-card Add) and the rubric upload's document-block path
  (PDF / DOCX as Converse document blocks, `lib/ai/rubricExtractor`).
- No conflict with ADR 0016: tags ride the teacher's `ItemBundleSchema`
  only; `DeliveryBundleSchema` (`packages/schema/src/delivery.ts`, its own
  `baseDeliveryItem`) gains nothing.

## What exists that this stands on

- `GenerateItemRequest` = `{ assessment_id, item_type, prompt ≤ 4000 }`;
  one item per call; gated by `assessments.allow_llm_authoring`;
  `runGuarded({ surface: "item-gen" })` checks input and output; the
  result is validated against `CreateItemBody` and returned unsaved.
- `AI_GENERABLE_ITEM_TYPES` = MC single, MC multi, short text, essay.
- Keyless items are legal drafts (slice B); the editor's readiness check
  already lists what blocks Publish.
- `ai_usage` log line on every Converse call (row R, D-7 there).

## Design

### Standards tags (D-1, D-2)

- **D-1 (James): optional field.** `standards: string[]` on the item —
  `baseItem` in `packages/schema/src/items.ts` (teacher bundle, optional,
  emitted only when non-empty so older bundles stay byte-stable) and a
  `standards jsonb not null default '[]'` column on `items` (one
  migration). ≤ 10 per item, ≤ 80 chars each. Each entry is either a
  code from the shipped catalog (D-1a) or a teacher's own designation.
- **D-1a (James, 9.1): a shipped WA standards picker, plus custom.**
  Revised 2026-10-02 after the 9.4 research: Washington adopted REVISED
  math and ELA standards in 2026 (explore in 2026–27, required with
  students in 2027–28) with new codes (`M.7.DA.DS.1`, `ELA.1.R.1`), so
  the catalog is built from OSPI's files, not the 2011 CCSS (sources and
  terms in §Catalog sources). Science = NGSS performance expectations
  (Washington's science standards are the NGSS; a 2024 OSPI draft
  revision has no adopted version yet).
- **Catalog shape.** Repo JSON under `design-tool/lib/standards/`, loaded
  server-side, never in a bundle: `{ scheme, code, subject, grade_band,
  domain, text, priority? }`. `scheme` = `wa2026` | `ccss2010` | `ngss`
  (a code is only unique within its scheme, and the 2027–28 changeover
  means two schemes coexist). `grade_band` not `grade`: HS math has no
  grade and NGSS uses `K-2` / `MS` / `HS` bands alongside single grades.
  OSPI's PRIORITY flag is kept for the picker.
- **Stored tag form.** A picked entry stores `scheme:code`
  (`wa2026:M.7.DA.DS.1`); the editor shows the code without the scheme
  prefix plus its text; a custom designation is stored as typed (no
  prefix). The plain-list decision (9.2) holds — still `string[]`.
- **Picker.** Searches code and text across schemes, filtered by subject
  + grade band (assessments have no subject / grade field; the teacher's
  last filter is remembered per browser). The 2011 ↔ 2026 association is
  6.1 below.
- **Custom designation (James, 9.1):** anything not in the catalog —
  local learning targets, other subjects (social studies, CTE, arts,
  world languages), AP course skills — is typed as free text and stored
  as is. A custom entry that exactly matches a catalog code is treated
  as that code. No difference in storage (9.2 = plain list).
- Editor: the picker + free-text entry under the stem on every item
  type; tags already used on the assessment are offered first so one test
  stays consistent. Export / import / duplicate / share carry them (they
  ride the bundle); an imported code missing from this catalog shows as
  custom text.
- **D-2 (James): AI may suggest tags for untagged items — never applies
  them.** "Suggest standards" on the Items tab: the teacher pastes or
  uploads the standards list for this unit (or leaves it blank for
  free-form objectives); the model proposes up to three tags per
  untagged item with a one-line reason; each proposal is an Accept /
  Dismiss chip on the item card. The candidate list is the catalog slice
  the teacher filtered to (subject + grade), optionally narrowed by a
  pasted unit list or custom targets; a proposed code not in the catalog
  is dropped. **D-2a (James, 9.2): accepted tags are ordinary tags —
  nothing records that a tag was suggested.** Guardrail surface
  `tag-suggest`.

### Batch generation (D-3 … D-6)

`POST /api/ai/generate-items` — staff, `edit` on the assessment,
`allow_llm_authoring` required. Body:

```
{ assessment_id,
  count: 1..10,                          // D-3
  types: { multiple_choice_single?: n, multiple_choice_multi?: n,
           short_text?: n, essay?: n },  // sums to count; or "mix"
  target: { standards?: string[], objective?: string },
  resource?: { upload_id } | { text },   // optional source material
  difficulty?: "mixed" | "easier" | "on_level" | "harder",
  notes?: string }                       // free prompt, ≤ 2000
```

- **D-3 (James): at most 10 per batch.** One Converse call returns an
  array; each element validated against `CreateItemBody` alone, so one
  malformed item drops (with a "1 of 10 could not be used" line), not the
  batch.
- **D-4 a resource is source material, not instructions.** PDF / DOCX go
  as document blocks, pasted text as a quoted block, the prompt says to
  draw content from it and ignore any instructions inside it. Uploads use
  the existing asset upload path, size cap as the rubric upload. The
  guardrail input check runs on the teacher's `notes` + extracted text.
- **D-5 every generated item carries the batch's tags** (the requested
  standards / objective), editable before Add — this is how batch
  generation feeds class insights without a second step. The dialog's
  target uses the same picker + custom entry; a picked code sends its
  catalog text to the model so it writes to the standard, not the code.
- **D-7 (James, 9.3): v1 types = the four generable ones** (MC single,
  MC multi, short text, essay); **match next** as its own slice
  (prompt shape + a proposal card that shows the pairs, keyed by
  structure); order and table after that, if asked for.
- **D-6 keys are marked for review.** Each card shows the proposed key
  with "Check the key" until the teacher opens it; Add saves the item as
  is (same as PDF import). Essay proposals may carry a proposed rubric
  only when the teacher picked one from the library (row R) — no
  invented rubrics.
- UI: "Generate questions" on the Items tab opens a dialog (the fields
  above), then the proposal list — the PDF-import card component with
  Add / Add all / Discard and an inline edit before Add. Nothing saved
  until Add (same as today's single generator).
- Avoid duplicates: the prompt includes the stems already on the
  assessment (truncated) and asks for distinct items.

## Catalog sources (9.4, researched 2026-10-02)

- **Math + ELA — OSPI 2026 adoption spreadsheets** (math and ELA final
  adoption `.xlsx`, linked from OSPI's Mathematics / ELA Standards pages):
  Washington's own codes, a crosswalk column to the 2011 CCSS codes, the
  PRIORITY flag. OSPI's standards documents carry a Creative Commons
  Attribution license. Attribution (shown in project docs and the
  picker's footer): "Adapted from the Washington Office of
  Superintendent of Public Instruction, K–12 Learning Standards (2026),
  CC BY." Confirm the license wording in the xlsx files themselves in
  slice 1 (the research read it from the PDFs).
- **2011 CCSS text, if shipped (6.1):** the CCSS public license allows
  copying and display "for purposes that support the Common Core State
  Standards Initiative", with the notice "© Copyright 2010. National
  Governors Association Center for Best Practices and Council of Chief
  State School Officers. All rights reserved." It is narrower than CC BY
  and a secondary source says it bars alteration — ship the text
  verbatim, notice in project docs.
- **Science — NGSS performance expectations** (code + text) from
  nextgenscience.org. NGSS's terms let "states, districts, schools,
  teachers and non-profit education entities" copy, adapt and rearrange
  any part. Copyright National Academies Press; the trademark is
  WestEd's (since 2020). **D-1b (James, 6.2): the WestEd trademark notice
  goes in project docs (a `NOTICE` / README section), not on the
  teacher's screen.** Notice text for the docs: "Next Generation Science
  Standards is a registered trademark of WestEd. Neither WestEd nor the
  lead states and partners that developed the Next Generation Science
  Standards were involved in the production of this product, and do not
  endorse it." (Reading for the record: the terms ask third parties using
  the trademark to show it at first prominent use; James's call is that
  the district's own tool does not need it on screen.)
- **Not used:** 1EdTech CASE Network (free registration for downloads;
  per-framework licenses unverified), Common Standards Project (API key;
  last README update 2015), ASN / D2L (data license unclear). Revisit
  CASE if more subjects are added (9.5).
- **Watch:** an adopted Washington science revision (OSPI's 2024 draft
  adds priority standards and topic tags) would become a `wa20xx`
  science scheme the same way.

## Crosswalk (6.1 proposal — both schemes, associated)

Codes below are illustrative; slice 1 reads the real pairs from OSPI.

What "ship both and associate them" looks like:

- **Two catalogs, one link table.** `wa2026` and `ccss2010` entries with
  their own text; `crosswalk.json` = pairs `{ wa2026, ccss2010 }` built
  from OSPI's crosswalk column. Many-to-many: a revision can split one
  CCSS standard into two, merge two into one, add a standard with no
  CCSS root (the four new math domains) or drop one.
- **Picker.** Typing `7.RP.A.2` finds the CCSS entry AND its linked 2026
  entries; each result shows its counterpart on a second line ("2026:
  M.7.R.RP.2" / "2011: 7.RP.A.2"). A **scheme preference** (2011 / 2026,
  remembered per browser, default 2026) decides which is listed first —
  teachers who still plan in CCSS this year pick 2011 and see the 2026
  code alongside.
- **Storage.** The tag stores exactly what the teacher picked; nothing is
  rewritten. A 2011 tag stays a 2011 tag after 2027–28.
- **Reading (class insights, reports).** Grouping resolves to 2026: a
  `ccss2010` tag with exactly one 2026 link is counted under that 2026
  standard and shown as "M.7.R.RP.2 (tagged as 7.RP.A.2)"; a tag with
  several links or none is grouped under its own code. No guessing.
- **Batch generation / Suggest standards.** Prompts use the 2026 text
  when a 2026 code is linked (it is what students will be held to); the
  suggestion list is drawn from the preferred scheme.
- **Cost.** Two texts to load (the CCSS text under its narrower license),
  a link table to rebuild if OSPI revises the crosswalk, and the
  one-to-many cases need a test fixture each. Size is small (a few
  thousand entries in total).
- **Simpler alternative:** ship 2026 only and use the crosswalk as a
  search ALIAS (typing a 2011 code finds the 2026 entry, which is what is
  stored) — no 2011 text, no `ccss2010` tags, no CCSS-license question;
  the cost is that a teacher cannot keep a 2011 code on an item.

## Success looks like

- A teacher gets 10 tagged, distinct, on-target drafts in one round trip
  and adds most of them with light edits (measure: share of proposals
  added; edits per added item — from the proposal ids, no new table).
- No generated item reaches students with an unchecked AI key unless the
  teacher saved it on purpose.
- An uploaded reading or slide deck produces items answerable from that
  resource alone.
- Untagged legacy items get tagged in one pass via suggestions.

## Slices

0. This note.
1. Standards catalog: a build script that reads OSPI's two 2026 xlsx
   files (+ the crosswalk, per 6.1) and the NGSS performance expectations
   and writes the JSON; a lookup module + tests (Sonnet 5 / medium). The
   source files are downloaded by the script, not committed.
2. Tags: schema field + migration + editor picker / custom entry +
   bundle round trip + tests (Sonnet 5 / medium).
3. Batch route + provider method + mock + per-item validation + guardrail
   + tests (Opus 5 / medium).
4. Dialog + proposal list reuse (Sonnet 5 / medium).
5. Suggest standards (route + chips) (Sonnet 5 / medium).
6. Match in a batch (Opus 5 / medium).
7. Teacher rows in `docs/design-tool-manual-checks.md`; Bedrock evidence
   run on a hand-built resource (no teacher PDF in the repo).

Design tool only; no client change.

## Open questions

Decided 2026-10-02 (James): 9.1 → D-1a (shipped picker + custom);
9.2 → D-2a (plain list); 9.3 → D-7 (four types, match next).

- **9.4 answered 2026-10-02** (research; §Catalog sources).
- **6.1** How the 2011 CCSS codes relate to the 2026 Washington codes —
  proposal in §Crosswalk, awaiting James.
- **9.5** Other WA subjects (social studies, health / PE, arts, CTE) in
  a later catalog, or custom-only?

## Progress

Nothing built.

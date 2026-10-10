---
type: Package Reference
title: "@secure-test/schema wire formats (teacher bundle vs student delivery bundle)"
description: The shared Zod schemas for items, bundles and student responses, why there are two bundle types, how new item types or bundle fields must be added, and which mirrors (Swift, KaTeX macros) must stay in step.
tags: [schema, zod, wire-format, security]
openwiki:
  roles: [architecture, domain]
  change_kinds: [public-api, schema, new-item-type]
  source_paths:
    - packages/schema/src/items.ts
    - packages/schema/src/delivery.ts
    - packages/schema/src/responses.ts
    - packages/schema/src/macros.ts
    - design-tool/lib/api/buildDeliveryBundle.ts
    - design-tool/lib/api/exportBundle.ts
    - client/SecureTestCore/Sources/SecureTestCore/DeliveryItem.swift
  symbols: [ItemBundleSchema, ItemSchema, DeliveryBundleSchema, DeliveryItemSchema, ItemResponseSchema, itemSetIssues, K12_MACROS, MIN_CLIENT_VERSION_FOR_TYPE]
  test_paths: [packages/schema/test/delivery.test.ts, packages/schema/test/items.test.ts, packages/schema/test/responses.test.ts, design-tool/test/delivery-api.test.ts]
  invariants:
    - DeliveryBundleSchema has no field that can hold a correct_* key, cell_keys, keys, exact_form or scoring_method.
    - Absent optional delivery fields mean the restrictive/default behaviour (allow_clipboard absent = locked, layout absent = scroll).
  validation_commands: ["cd packages/schema && bun run build && bun test"]
---

# `@secure-test/schema`

`packages/schema` is a private workspace package (`main: ./dist/index.js`, so **consumers read the built `dist/`** — run `bun run build` after editing `src/`). `src/index.ts` re-exports four modules:

| Module | Contents |
| --- | --- |
| `items.ts` | Authoring/teacher shapes: ten item schemas, `ItemSchema` (discriminated union on `type`, defaults a missing `type` to `multiple_choice_single` for PoC-B fixtures), `RubricSchema`, item sets (`ItemSetSchema`, `TeacherItemSetSchema`, `itemSetIssues`), enums (`StudentLayoutSchema`, `StudentFeedbackSchema`, `AnswersReleaseSchema`, `ScoringMethodSchema`), and **`ItemBundleSchema`**. |
| `delivery.ts` | Student shapes: `Delivery*ItemSchema` per type, `DeliveryItemSchema`, **`DeliveryBundleSchema`**. |
| `responses.ts` | What a student may PUT: `ItemResponseSchema` (discriminated union), length caps (`ESSAY_TEXT_MAX_LENGTH`, `SHORT_TEXT_MAX_LENGTH`, `RESPONSE_CELL_MAX_LENGTH`, `ESSAY_HTML_MAX_LENGTH`). |
| `macros.ts` | `K12_MACROS` — KaTeX macros (`\degree`, `\percent`, `\plusminus`, `\half`, `\third`, `\quarter`). |

Wire keys are **snake_case** everywhere (ADR 0002); no camelCase transform on either side.

## Item types

`multiple_choice_single`, `multiple_choice_multi`, `short_text`, `essay` (optional rubric, `rich_text`), `match`, `order`, `hotspot`, `drawing_upload`, `table`, `fill_blank`. The DB mirror is `ITEM_TYPES` in `design-tool/db/schema.ts`; type-specific extras live in `items.config` (jsonb, see [data model](../design-tool/data-model.md)).

## Two bundles (ADR 0016)

- **`ItemBundleSchema` (teacher)** — export, teacher-to-teacher share, backup, duplicate. Carries every key (`correct_choice_id(s)`, `correct_answer`, `correct_region_ids`, `pairs`, `sequence`, `cell_keys`, fill-blank `keys`), rubrics, `scoring_method`, `item_sets` with optional E12 `source` link (dropped on import unless the same owner owns the source), base64 `assets`, `allowed_accommodations` / `construct_altering`, `student_layout`, `student_feedback`, `answers_release`. Optional fields are emitted only when non-default so older bundles stay byte-stable.
- **`DeliveryBundleSchema` (student)** — a *separate* discriminated union, not a filtered view. Differences that matter:
  - match → independent `lefts` / `rights`; order → `entries`; ids are per-attempt HMACs from `lib/api/opaqueIds.ts` (`opaqueId(attempt, item, realId, scope)`; scope `"L"`/`"R"` for match, `""` for order). The server un-seals them on write (`unsealResponseIds` in `lib/api/studentAttempt.ts`) so `responses.response` holds authoring ids.
  - `accommodations` is the **effective per-student map** (tool id → setting value), plus `construct_altering`; never the authoring allow-list.
  - `allow_clipboard` is emitted only when true (absence = locked). `layout` only when `paged`.
  - Per-attempt state: `answered_item_ids`, `saved_responses` (typed as `ItemResponseSchema`, so it cannot become a key channel), `saved_uploads` (drawing bytes ≤ 2 MB), `time_limit_ends_at` + `server_now` (emitted together, only for timed attempts).
  - `essay.rubric` appears only when `student_visibility.during_test`.
  - `DeliveryItemSetSchema` adds `source_missing`, `inline_item_id`, `inline_text` for per-student stimuli.
- Both bundles run `itemSetIssues` in `superRefine`: every set item exists, belongs to one set, and the set's items are one contiguous block in `items` order. Asset/upload map keys must be UUIDs.

## Change recipes

### Add a field to the student bundle
1. Add it (optional, default = old behaviour) to `DeliveryBundleSchema` in `delivery.ts`; if it is derived from teacher data, make sure it is not a key.
2. Populate it in `design-tool/lib/api/buildDeliveryBundle.ts` (the final `DeliveryBundleSchema.parse` is the leak backstop) and, if needed, the route `app/api/assessments/[id]/delivery/route.ts`.
3. Mirror it in `client/SecureTestCore/Sources/SecureTestCore/DeliveryBundle.swift` / `DeliveryItem.swift`; the page receives the **original JSON bytes** (`AssessmentPage.html`), so the renderer script must also learn it.
4. Tests: `packages/schema/test/delivery.test.ts` (negative key assertions), `design-tool/test/delivery-api.test.ts`, `client/.../DeliveryBundleTests.swift`, relevant `Renderer*Tests.swift`.

### Add an item type (cross-system, expensive)
`ITEM_TYPES` in `db/schema.ts` → `items.ts` schema + `ItemSchema` union → `delivery.ts` schema + union → `responses.ts` response + union → `lib/api/items.ts` (`CreateItemBody`, config validation, `effectiveScoringMethod`) → `buildDeliveryBundle.ts` (`mapItemForDelivery` ends in `assertNever`, so a missing branch fails typecheck) → `exportBundle.ts` / `importBundle.ts` → `lib/scoring/auto.ts` (`scoreResponse`) and `results.ts` max-points → `lib/items/clientSupport.ts` (`MIN_CLIENT_VERSION_FOR_TYPE`: the delivery route refuses a bundle containing a type an old client cannot decode, because one unknown type fails the whole decode) → Swift `DeliveryItem` enum (exhaustive switch) and renderer → editor UI/preview (`lib/preview/renderHtml.ts`).

### Add a KaTeX macro
Edit `K12_MACROS` only; then `client/scripts/vendor-katex.mjs` regenerates `GeneratedKatexMacros.swift`. Removing a macro breaks saved stems.

## Validation

- Narrow: `cd packages/schema && bun run build && bun test` (a leak regression shows up in `delivery.test.ts`).
- Consumer-surface check: `cd design-tool && bun run typecheck` (resolves `@secure-test/schema` through `dist/`) and `bun test test/delivery-api.test.ts` (needs the test DB, see [testing](../testing/testing-and-validation.md)).
- Conditional: `cd client/SecureTestCore && swift test` only when the bundle shape the client decodes changed.
- `dist/` is a build product; do not hand-edit it.

Related: [sittings and attempts](../design-tool/sittings-and-attempts.md) (who builds/serves the delivery bundle), [authoring](../design-tool/authoring.md) (export/import), [client overview](../client/overview.md) (Swift mirror).

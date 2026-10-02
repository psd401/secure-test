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
  migration). Free text, ≤ 10 per item, ≤ 80 chars each — a code
  (`CCSS.MATH.CONTENT.7.RP.A.2`), a short objective ("I can identify
  claims in a source"), or both. No standards database in v1 (see 9.1).
- Editor: a tag input under the stem on every item type; existing tags on
  the assessment are offered as suggestions so one test stays consistent.
  Export / import / duplicate / share carry them (they ride the bundle).
- **D-2 (James): AI may suggest tags for untagged items — never applies
  them.** "Suggest standards" on the Items tab: the teacher pastes or
  uploads the standards list for this unit (or leaves it blank for
  free-form objectives); the model proposes up to three tags per
  untagged item with a one-line reason; each proposal is an Accept /
  Dismiss chip on the item card. Accepted tags are ordinary tags; nothing
  records that a tag was suggested (recommendation — revisit if teachers
  want to filter on it). Guardrail surface `tag-suggest`.

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
  generation feeds class insights without a second step.
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
1. Tags: schema field + migration + editor input + bundle round trip +
   tests (Sonnet 5 / medium).
2. Batch route + provider method + mock + per-item validation + guardrail
   + tests (Opus 5 / medium).
3. Dialog + proposal list reuse (Sonnet 5 / medium).
4. Suggest standards (route + chips) (Sonnet 5 / medium).
5. Teacher rows in `docs/design-tool-manual-checks.md`; Bedrock evidence
   run on a hand-built resource (no teacher PDF in the repo).

Design tool only; no client change.

## Open questions

- **9.1** Standards list source: teacher-pasted only, or ship the WA
  CCSS-M / ELA / NGSS codes as a picker later?
- **9.2** Record "suggested by AI" on accepted tags?
- **9.3** Allow table / match / order in the batch, or the four
  generable types only (recommended for v1)?

## Progress

Nothing built.

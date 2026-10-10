---
type: Subsystem Reference
title: Assessment authoring, items, import/export and preview
description: How teachers create assessments and the ten item types, item sets (shared stimulus), the draft/published lock, bundle export/import/duplicate/share, PDF and CSV import, and the server-rendered preview and print view.
tags: [authoring, items, import-export, pdf-import, preview, katex]
openwiki:
  roles: [domain, workflow]
  change_kinds: [public-api, persistence, extension-seam]
  source_paths:
    - design-tool/lib/api/items.ts
    - design-tool/lib/api/itemSets.ts
    - design-tool/lib/api/requireDraft.ts
    - design-tool/lib/api/exportBundle.ts
    - design-tool/lib/api/importBundle.ts
    - design-tool/lib/api/duplicateAssessment.ts
    - design-tool/lib/api/shares.ts
    - design-tool/lib/api/itemIntegrity.ts
    - design-tool/lib/pdfImport/extractCore.ts
    - design-tool/lib/items/renderItemContent.ts
    - design-tool/lib/preview/renderHtml.ts
    - design-tool/app/api/assessments/[id]/items/import-pdf/route.ts
  symbols: [CreateItemBody, UpdateItemBody, effectiveScoringMethod, requireDraft, isAnswerKeyOnlyPatch, buildExportBundle, importBundleForOwner, assertItemsAreBundleable, PDF_EXTRACT_SYSTEM_PROMPT, validatePdfCandidates]
  test_paths:
    - design-tool/test/items-api.test.ts
    - design-tool/test/import-api.test.ts
    - design-tool/test/item-sets-api.test.ts
    - design-tool/test/preview-render.test.ts
    - design-tool/test/pdf-extract.test.ts
    - design-tool/test/pdf-import-route.test.ts
    - design-tool/test/duplicate-assessment.test.ts
  invariants:
    - A published assessment rejects item and metadata edits with 409 assessment_published_editing_locked, except status back to draft and answer-key-only or standards-only PATCHes.
    - Export carries answer keys (teacher to teacher); the student path never uses it.
    - Items of one item set must be contiguous in position order.
  validation_commands:
    - cd design-tool && DATABASE_URL=postgres://$USER@localhost:5432/secure_test_design_tool_test bun test test/items-api.test.ts
---

# Assessment authoring

Teachers author in `/dashboard/*` (pages under `design-tool/app/dashboard/`), which call the same `/api/assessments/**` routes any other client could. Every route starts with `requireStaff()` and then `authorizeAssessment(db, session, id, level)` ([auth and access](auth-and-access.md)); authoring writes need `edit`, sharing/archiving/deleting need `own`.

## Concepts

- **Assessment** (`assessments` table): name, description, `time_limit_seconds`, `allow_clipboard`, `allow_llm_authoring`, `student_layout` (`scroll`/`paged`), instant-feedback settings, accommodation lists, `status` (`draft` | `published`), `archived_at`. Columns are explained in [data model](data-model.md).
- **Item** (`items`): `type` is one of `ITEM_TYPES` (`multiple_choice_single`, `multiple_choice_multi`, `short_text`, `essay`, `match`, `order`, `hotspot`, `drawing_upload`, `table`, `fill_blank`). Type-specific fields live in the `items.config` jsonb bag (`ItemConfig` in `db/schema.ts`): rubric, pairs, sequence, regions, cell keys, blanks, `scoring_method`, `exact_form`, `rich_text`. The write boundary (`lib/api/items.ts`: `CreateItemBody`, `UpdateItemBody`, `itemConfigForWrite`) decides which keys may be persisted; the column itself enforces nothing.
- **Item set** (`item_sets`, `lib/api/itemSets.ts`): one stimulus (passage, figure, data table, or several labelled sources) shared by consecutive items. A set has no position of its own; its items must be contiguous and the reorder route refuses an order that splits one. Layout is `inline`, `own_page` or `side_by_side` (teacher's choice, never inferred). A set can be "source-backed" (E12): its stimulus is each student's own earlier answer (`lib/api/setSources.ts`).
- **Scoring method**: `auto | ai | human | hybrid`. Absent means the type default via `effectiveScoringMethod` (MC and short text auto, essay human). See [scoring](scoring-and-results.md).
- **Content syntax** (stems, choices, stimuli): KaTeX `$…$` / `$$…$$` plus `![alt](asset:<uuid>)` image refs, rendered server-side by `lib/items/renderItemContent.ts` (`lib/math/renderLatex.ts` for math, K-12 macros from `@secure-test/schema` `K12_MACROS`). Unresolved refs render as an inline red placeholder.

## Draft/published lock

`lib/api/requireDraft.ts` returns a 409 `assessment_published_editing_locked` for any mutation of a published assessment. The unlock is a PATCH of the assessment itself to `status: "draft"` (its body is validated before the guard fires). Two deliberate exceptions let teachers finish work after publishing: `isAnswerKeyOnlyPatch` (only keys change: `correct_*`, hotspot `correct_region_ids`, table `cell_keys`, fill-blank keys) and standards tags, since neither reaches students. Keyless items can be published (the PDF importer proposes them); the readiness checklist flags them.

## Getting content in and out

| Path | Entry points | Notes |
| --- | --- | --- |
| Export bundle | `GET /api/assessments/[id]/export` → `buildExportBundle` | `ItemBundleSchema` JSON with answer keys; bundles referenced asset bytes inline (`x-bundled-asset-count`); hidden rubrics omitted unless asked |
| Import bundle | `POST /api/assessments/import` (JSON or multipart, 50 MB cap) → `importBundleForOwner`, also the `/dashboard/import` page | validates `ItemBundleSchema`, re-uploads bundled assets (sha256 dedup) and rewrites `asset:` ids, validates accommodation ids leniently and reports dropped counters; E12 set sources kept only when the same owner owns the source assessment |
| Duplicate | `POST /api/assessments/[id]/duplicate` → `duplicateAssessment.ts` | copies section accommodations whole; answers-release stamp never copied |
| Share | `lib/api/shares.ts`, `/api/assessments/[id]/shares`, `/api/shares/[shareId]/accept` | **copy semantics**: the recipient accepts and gets an independent assessment built from the lossless export; share notification email via `lib/email/shareNotifications.ts` |
| Items CSV / items import | `lib/api/importItemsCsv.ts`, `POST …/items/import` | |
| PDF import | `POST …/items/import-pdf` → `lib/pdfImport/*` | text via `unpdf` (`extractText.ts`), figures via `extractFigures.ts`; scanned PDFs go to Bedrock document blocks (ADR 0015); model returns candidate items validated through `CreateItemBody` (`validatePdfCandidates`), capped at `MAX_PDF_CANDIDATES`; typed failures (`PdfExtractError` truncated/invalid_json/not_array) map to 422 with teacher hints |
| AI generation | `POST /api/ai/generate-item(s)` | gated by `allow_llm_authoring`; see [AI and safeguarding](ai-and-safeguarding.md) |
| Rubrics | `/api/rubrics`, `/api/assessments/[id]/rubrics/extract` | library rubrics are *copied* into `items.config.rubric` (fresh ids); no FK, so a library edit never rescores an item |
| Standards tags | `/api/standards*`, `/api/ai/suggest-standards`, `lib/standards/*` | tags are authoring metadata, never delivered (ADR 0016); the catalog and crosswalk JSON are generated by `bun run standards:build` |

`lib/api/itemIntegrity.ts` (`assertItemsAreBundleable`) runs before any bundle is built so an incomplete item fails loudly instead of shipping malformed to a student.

## Preview and print

`GET /preview/[id]` (`app/preview`, `lib/preview/renderHtml.ts`) renders a static, no-JS HTML view with CSP `default-src 'none'`, embedded in the editor as a sandboxed iframe (ADR 0006). It shows the Tier-1 accommodation toolbar chips as visual demo only. `?print=1` renders the paper variant for browser print / Save-as-PDF (ADR 0013, no server-side PDF). KaTeX CSS is inlined from `lib/preview/katexCss.ts`.

## Change recipes

- **Add an item type**: this is a cross-system change — follow [wire formats](../architecture/wire-formats.md#add-an-item-type-cross-system-expensive) first, then here: add the type to `ITEM_TYPES`, extend `CreateItemBody`/`UpdateItemBody` and `ItemConfig`, handle it in `exportBundle`/`importBundle`, `mapItemForDelivery`, `lib/scoring/auto.ts` (`scoreResponse`, max-points helpers), `lib/preview/renderHtml.ts`, the editor components, and `MIN_CLIENT_VERSION_FOR_TYPE` (`lib/items/clientSupport.ts`) if older clients cannot decode it. `assertNever` switches make the compiler list what you missed.
- **Add a config field**: needs no migration (jsonb) but must be allowed in `itemConfigForWrite`, kept byte-stable in export when default, and — if it is an answer key — added to the key-only-PATCH set and dropped by the delivery mapping.
- **Change the publish lock**: edit `requireDraft.ts`; tests in `items-api.test.ts` and `answer-key-only-patch.test.ts`.

Scope boundaries: do not hand-edit `lib/preview/katexCss.ts`/`katex.min.css.ts` (vendored by `bun run vendor:katex-css`) or `lib/standards/catalog.json` (generated).

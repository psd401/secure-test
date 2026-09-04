# Phase 2 — slice plans

Status: drafted 2026-06-17. **Slices 30–34 built + merged to `main` (2026-06-23).** The
remaining Phase 2 work is externally blocked — see "Deferred / needs its own ADR" below.

Phase 2 scope lives in [`design-tool-plan.md`](design-tool-plan.md) lines 105–114. This
file breaks the buildable subset into concrete slices, in recommended build order.

## Build status

| Slice | Title | Status |
|---|---|---|
| 30 | S3 storage provider (app side) | ✅ built |
| 31 | S3 CDK bucket + IAM (infra) | ✅ built + deployed (`secure-test-design-tool-dev`) |
| 32 | Essay item type | ✅ built (`items.config` jsonb bag) |
| 33 | Rubric block on essay items | ✅ built (`config.rubric`, analytic/holistic/single-point) |
| 34 | PDF export for print accommodations | ✅ built — **client-side print, not the chromium approach below** (ADR 0013) |

## Sequencing facts that shape the set

- **Score-export slices are not buildable yet.** No `responses`/`scores` table exists in
  `design-tool/db/schema.ts`; scoring is entirely Phase 3 (`design-tool-plan.md:115–124`).
  CSV / PowerSchool / Schoology exports have nothing to read. Deferred to Phase 3.
- **Distribution UI shares the rostering blocker.** It needs OneRoster sync, which needs the
  ClassLink Partner Portal `client_id`. Only a non-functional shell is buildable now — held
  with rostering.
- **Admin safeguarding page (was "slice 30") is deferred** until rostering lands, since the
  role/admin model may change how assignments work. It takes a later number.

## Recommended order

`30 → 31` (S3 app + infra) → `32 → 33` (essay + rubric) → `34` (PDF). Each is independent;
essay/PDF do not depend on S3.

---

## Slice 30 — S3 storage provider (app side)

- **Goal:** Add `STORAGE_PROVIDER=s3` alongside `local-fs`; `local-fs` stays the default for
  tests/CI/dev.
- **Why low-risk:** The abstraction already exists — `StorageProvider` interface
  (`lib/storage/types.ts:8`), env switch `getStorageProvider()` (`lib/storage/provider.ts:6`),
  and `assets.storage_provider` persisted per row (`db/schema.ts`). ADR 0008 specified this as
  a one-file drop-in.
- **Changes:**
  - New `lib/storage/s3Provider.ts` implementing `put`/`get`/`delete`/`id` via
    `@aws-sdk/client-s3` (AWS SDK already used for Bedrock).
  - Add a `getStorageProviderById(id)` registry so reads/deletes route by the row's persisted
    provider, not the env default (see correctness gap below). Keep `getStorageProvider()` as
    the env-selected *write* provider.
  - Route reads/deletes by `row.storage_provider`: `app/api/assets/[id]/route.ts` (GET + DELETE),
    `app/api/assessments/[id]/export/route.ts`.
  - Add `S3_BUCKET`, `S3_REGION`, `S3_KMS_KEY_ID?` to `.env.local.example` (documented, unset).
- **Correctness gap handled in-slice:** `getStorageProvider()` reads env, **not**
  `row.storage_provider`. After flipping env to `s3`, reads of existing `local-fs` rows would
  break. Fix: route reads by the per-row provider id (the reason that column exists). This makes
  a mixed-provider migration window safe with no backfill.
- **Deferred to later slices (keeps 30 simple):** presigned browser→S3 PUT (ADR 0008 10.3) and
  CDN reads (10.4). Slice 30 keeps the existing server-side `put(bytes)` flow.
- **Tests:** Mirror `test/storage-provider.test.ts` + the Bedrock mock pattern
  (`test/bedrock-provider.test.ts`) — mock `@aws-sdk/client-s3`, assert the interface contract,
  registry routing, and error wrapping. No live AWS in CI.

## Slice 31 — S3 CDK bucket + IAM (infra)

- **Goal:** Provision the bucket slice 30's provider writes to. Separate slice because it is a
  `cdk deploy`, not app code.
- **Changes:** Extend `infra/lib/design-tool-stack.ts` (Aurora-only today) with a **per-env**
  S3 bucket (`secure-test-design-tool-dev` / `-prod`), **SSE-S3** default encryption (no KMS
  key resource), an **abort-incomplete-multipart** lifecycle rule (~7 days, no versioning), and
  grant the app role `s3:PutObject`/`GetObject`/`DeleteObject`; emit the bucket name as a
  `CfnOutput`.
- **Tests:** `cdk synth` passes (matches slice 24's bar — synth-validated, deploy pending).
- **Decisions:** resolved 2026-06-17 (ADR 0008 10.1–10.5): bucket-per-env, SSE-S3 everywhere,
  server gateway (no presigned), app-served reads (no CloudFront), abort-multipart + no
  versioning. Rationale: teacher-facing tool, no student PII at rest.

## Slice 32 — Long-text / essay item type

- **Goal:** Add `essay` as a fourth item type. Authoring only (no scoring).
- **Why clean:** Mirrors `short_text` exactly across the discriminated union.
- **Changes:**
  - `packages/schema/src/items.ts:27` — add `EssayItemSchema` (`type: z.literal("essay")`,
    optional `max_length`/`placeholder`); add to the `discriminatedUnion`.
  - `AssessmentEditor.tsx` — `ItemType` union (`:20`), `TYPE_LABEL` (`:64`), `defaultItemFor()`
    (`:94`), dispatch branch (`:847`).
  - `lib/preview/renderHtml.ts:95` — add `else if (item.type === "essay")` → disabled
    `<textarea>`.
  - Export `app/api/assessments/[id]/export/route.ts:37` + import `lib/api/importBundle.ts:144`
    — add the essay case to both maps.
- **Tests:** Extend `test/items-api.test.ts` (create/validate essay) + a preview-render test +
  bundle round-trip.

## Slice 33 — Rubric block on essay items

- **Goal:** Attach an analytic + holistic rubric to essay items (`design-tool-plan.md:107`).
  Authoring + storage only; Phase 3 scoring consumes it later.
- **Changes:** Extend `EssayItemSchema` with an optional `rubric` object (criteria[], levels,
  points); editor sub-form under the essay branch; carry through export/import.
- **Tests:** Schema validation + bundle round-trip.
- **Note:** Building rubric authoring before scoring exists is deliberate — it is the input
  Phase 3 AI/human scoring needs, and it is inert until then.

## Slice 34 — PDF export for print accommodations — BUILT (client-side print)

- **Goal:** Render the existing preview HTML to PDF (`design-tool-plan.md:112`).
- **Approach changed during the slice.** The drafted plan (below) was a headless-Chrome
  server route via `@sparticuz/chromium-min` + `playwright-core`. A de-risk spike showed
  **headless Chrome does not run in the dev environment** (system Chrome `--print-to-pdf`
  hung 3m45s on a trivial page; the Playwright-MCP browser timed out at 180s twice). So no
  chromium deps were added and no `/pdf` route was written. See
  [ADR 0013](adr/0013-print-pdf-via-client-side-print.md) for the decision + evidence.
- **What shipped instead — client-side print:** `renderAssessmentHtml` gained a `printMode`
  option (drops the preview banner + Tier-1 toolbar; MC → blank mark boxes + letters;
  short-text/essay → blank write-space; `@page` margins + `@media print` `break-inside:avoid`).
  `GET /preview/:id?print=1` serves it; an editor "Print / Save as PDF" link opens it in a
  new tab. The teacher prints from their own (non-headless) browser → Save as PDF; same-origin
  images resolve via the session cookie, so no data-URI inlining is needed. No new deps.
- **Deferred:** a programmatic server-side `/pdf` route — revisit on a Linux deploy target
  where headless Chromium actually launches.
- **Tests:** `renderHtml` print-mode assertions (no banner/toolbar, paper affordances, print
  CSS, script-free, screen output unchanged). Route `?print=1` wiring verified live (no
  preview-route harness exists; the param is a one-line parse into the unit-tested renderer).

---

## Deferred / needs its own ADR

- **Multi-teacher collaboration (Yjs + Hocuspocus)** — `design-tool-plan.md:110`. No realtime
  infra exists; it replaces the entire last-write-wins PATCH path
  (`app/api/assessments/[id]/items/[itemId]/route.ts:69`) with a WebSocket server + Yjs doc
  model + persistence. Too big for one slice; warrants its own ADR. Cheap intermediate option:
  add the planned optimistic-concurrency `rev` token (`design-tool-plan.md:32`) to detect
  conflicts — small, no new infra. Sequence the full Yjs work last in Phase 2.
- **Score exports (CSV / PowerSchool / Schoology)** — blocked on Phase 3 scoring data.
- **Distribution UI** — blocked on OneRoster (ClassLink `client_id`); shell only.
- **Admin safeguarding review page** — deferred until rostering defines the admin/role model.

## Resolved decisions

- **S3 (ADR 0008 10.1–10.5, resolved 2026-06-17):** bucket-per-env; SSE-S3 everywhere (no CMK
  yet); keep the server gateway (no presigned PUT); app-served reads (no CloudFront);
  abort-incomplete-multipart lifecycle, no versioning. Framing: teacher-facing authoring tool
  producing exports for students — no student PII at rest relaxes the constraints.
- **Migration reads:** route by `row.storage_provider` — adopted in slice 30; no backfill
  needed (deployed nowhere, so no pre-S3 assets).

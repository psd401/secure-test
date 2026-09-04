# P-1 — saved answers come back on resume

Design page, 2026-09-03. Decisions marked **D-n** are James's; **§Progress
says what is built** (nothing yet). Source: the 2026-09-03 student sitting
(`docs/client-paging-design.md` §Progress, "P-1 DECIDED") — the strip's
answered marks were right, but the fields under them were empty, and the
student read a green check over an empty field as a lost answer and
re-answered. The "no prefill on resume" convention (E3 slice 3) is not
acceptable once marks exist.

## What exists that this stands on

- **The bundle already reads `responses` for this attempt.**
  `lib/api/buildDeliveryBundle.ts:237-244` selects `item_id` only and emits
  `answered_item_ids` (`packages/schema/src/delivery.ts:202`), in item
  order, only when non-empty, filtered to this assessment's items (an E12
  outline written in place is keyed by another assessment's question and
  does not count). The same query can carry `response`.
- **Responses are one jsonb column per (attempt, item)**
  (`db/schema.ts:705-731`, `response jsonb NOT NULL`, unique
  `(attempt_id, item_id)`), discriminated by `response.type`; an unanswered
  item is the absence of a row (`packages/schema/src/responses.ts:15-17`).
- **Match and order are stored with authoring ids.** The PUT route unseals
  the per-attempt opaque ids before storing
  (`app/api/attempts/[attemptId]/responses/[itemId]/route.ts:104-114`,
  `unsealResponseIds`); the bundle seals them on the way out
  (`buildDeliveryBundle.ts:104-141`, `opaqueId(attemptId, itemId, realId,
  scope)` — an HMAC, deterministic per attempt). A stored match / order
  answer must be re-sealed with the same call before the client can match
  it to the options it shows.
- **A drawing answer is a reference, not bytes:** `{ type: "drawing_upload",
  upload_id }` → `response_uploads` (`db/schema.ts:764-792`:
  `storage_provider`, `storage_key`, `content_type`, `status`). The bytes
  are read back with `getStorageProviderById(p).get(storage_key)` — the
  exact call `lib/api/bundleAssets.ts:74` makes to inline authored images
  as `assets[uuid] = { content_type, base64 }` (`BundleAssetSchema`).
- **The page consumes the bundle's raw JSON** (`AssessmentPage.swift:1-10`,
  `const BUNDLE = …`); the Swift `DeliveryBundle` decodes it first to prove
  it sound and gives the host typed access. A new field is read by the
  page directly and only needs a Swift property for tests and the host.
- **Every field builder has a natural restore point.** `choiceList`
  (`AssessmentPage.swift:296`), `shortTextField` (`:365`), `essayField`
  (`:440`), `matchField` (`:495`), `orderField` (`:554`), `hotspotField`
  (`:640`), `drawingField` (`:722`), `tableField` (`:851`) each build their
  inputs from the item and post on change. Setting `.checked` / `.value`
  / `selected[...]` / the `entries` order at build time fires no `onchange`
  — a restore is silent by construction.
- **The E12 inline outline already prefills from the bundle**
  (`set.inline_text`, `AssessmentPage.swift:1085`) — the one precedent for
  a student's own saved text riding the delivery bundle
  (`lib/api/setSources.ts:96-106`). Nothing changes there.
- **The harness canvas records its context calls** (`RendererHarness.swift:159-185`:
  `__ops` for `lineWidth`, `moveTo`, `stroke`, `clearRect`, …) and returns a
  fixed `toDataURL`. `drawImage` and `Image` do not exist in the shim today.
- **Finding, recorded here (F-1):** nobody can *view* a saved drawing
  today. `ScoringQueue.tsx` duck-types the response fields and renders a
  drawing answer blank, and nothing under `app/` reads `response_uploads`
  back. Out of scope for P-1; the read helper this slice adds is what a
  teacher-side viewer would reuse.

## Proposed shape

**Two bundle fields, emitted only when non-empty (D-2).**

```
saved_responses: { [item_id]: ItemResponse }     // this attempt's rows, re-sealed
saved_uploads:   { [upload_id]: BundleAsset }    // the drawing bytes those rows name
```

- `saved_responses` values are `ItemResponseSchema` shapes — the field can
  hold only what a student posts. They come from `responses` and nowhere
  else; `items.config` is never read for them (ADR 0016 untouched; the
  strip test extends to the new field).
- Match `matches[left_id] = right_id` and order `ordered_ids` are re-sealed
  with `opaqueId(attemptId, itemId, realId, MATCH_LEFT | MATCH_RIGHT | "")`
  so every id equals one the bundle's own `lefts` / `rights` / `entries`
  carry. An id that no longer resolves (should not happen — pairs and
  sequence are keys and the publish lock holds their structure) is dropped;
  an item left with nothing is omitted.
- Drawing (D-1, James: **restore the image**): `saved_responses[id]` is the
  stored `{ type, upload_id }`; `saved_uploads[upload_id]` carries the bytes
  as `{ content_type, base64 }` when the slot is `complete`, the type is
  `image/png` or `image/jpeg`, and the object is at most 2 MB (D-5). Beyond
  that the response is still listed and the field shows "Saved." without
  the picture. The bytes ride the bundle rather than a new GET route (the
  `assets` precedent: no new route, no host→page channel, no timing between
  page build and a callback; a client-drawn PNG at 800 × 600 is tens of
  kilobytes).
- `answered_item_ids`, `saved_responses` and `saved_uploads` are derived
  from **one** query in one pass (D-4), so a mark can never arrive without
  its value or a value without its mark. `answered_item_ids` keeps its
  shape; `Object.keys(saved_responses)` equals it.

**The page restores at build time and never posts for it (D-3).** A new
`SAVED = BUNDLE.saved_responses || {}` beside `ANSWERED`; each builder
reads `SAVED[item.id]` once, ignores a value whose `type` does not match
the item, and sets state directly:

| type | restore |
|---|---|
| multiple_choice_single | the input whose `value === choice_id` gets `checked` |
| multiple_choice_multi | each input in `choice_ids` gets `checked` |
| short_text | `input.value = text`; `renderFormulaPreview` runs once |
| essay | `area.value = text`; the word counter `refresh()`es |
| match | each row's `select.value = matches[leftId]` when the option exists |
| order | `entries` re-arranged to `ordered_ids` (ids not in the list keep their shuffled place after the known ones); labels `refresh()` |
| hotspot | `selected[id] = true`, class `selected`, `aria-pressed="true"` for each `region_ids` entry that is a region |
| drawing_upload | `saved_uploads[upload_id]` present → an `Image` from the data URL is drawn onto the canvas (`drawImage(img, 0, 0, canvas.width, canvas.height)`) after any background paint; `marked = true`; status "Saved."; Clear wipes it as today (the server keeps the upload until the next Save — withdrawing a drawing is not in scope). Absent bytes → `marked = true` and status "Saved." only |
| table | each cell input `.value = cells[row][col]` |

A change after restore posts exactly as today (the restored state is the
baseline). The E12 outline is untouched. The spool, peek, lockdown, the
monitor, the offline `--bundle` path (no saved fields, nothing changes)
and scroll / paged trees are unchanged — with no saved fields the DOM the
renderer builds is byte-identical to today's.

**Clear answer (batch plan #3) interplay:** a withdrawn answer deletes the
row, so the next resume shows neither mark nor value. Nothing extra.

**Out of scope, v1.** Withdrawing a drawing; restoring the page the
student was on (no storage in the page); a teacher-side drawing viewer
(F-1 above); prefill on the offline bundle.

## Slices

1. **Design tool.** `packages/schema/src/delivery.ts` (`saved_responses`,
   `saved_uploads`; `bun run build` for `dist`); `lib/api/buildDeliveryBundle.ts`
   (the one query, re-sealing, the upload read with the D-5 gate — a storage
   miss logs and omits the bytes, never fails the bundle); a small
   `lib/api/savedResponses.ts` if the builder gets long. Tests
   (`delivery-api`): fresh attempt emits none of the three; MC / short_text
   / essay / table come back verbatim; match and order values equal ids in
   the bundle's own `rights` / `entries`; a drawing lists its `upload_id`
   and `saved_uploads` carries the stored bytes; a `pending` slot or a
   non-image lists the response without bytes; another student's attempt on
   the same assessment does not leak in; `Object.keys(saved_responses)`
   equals `answered_item_ids`; the strip test — a key-shaped field still
   fails to parse. `packages/schema/test`: the fields parse; a value whose
   `type` is not a response type is refused. Size S.
2. **Client.** `DeliveryBundle.swift` (`savedResponses: [String: ItemResponse]`
   via the existing `ItemResponse` decoder, `savedUploads: [String: BundleAsset]`,
   both default empty); `AssessmentPage.swift` (`SAVED`, the eight restore
   points, drawing restore guarded for a shim without `Image` / `drawImage`);
   harness: `Image` stub with `onload` and a `drawImage` op. Tests
   (`RendererPrefillTests`): each type restores with **no** response post
   recorded; a type mismatch is ignored; a fixture-shaped bundle with saved
   fields drives it (build in-test from `delivery-bundle.json` plus the
   fields — the fixture itself stays as generated); drawing with bytes
   records `drawImage` and `marked`, without bytes only the status;
   `DeliveryBundleTests` (defaults empty, a bundle with the fields decodes).
   `swift test`, `xcodebuild`. Size M. **Rides the batch's client rebuild.**
3. **Hand-run rows.** `docs/design-tool-manual-checks.md` (the bundle for an
   attempt with answers carries `saved_responses` / `saved_uploads`; a fresh
   attempt carries neither) and `client/MANUAL-CHECKS.md` (answer one of
   every type incl. a drawing, quit, relaunch: every field shows its
   answer, the drawing shows the picture, the marks agree; change one and
   hand in; scoring sees the changed answer).

## Decisions (James, 2026-09-03)

- **D-1 drawing on resume.** Badge only ("Saved — draw again to replace")
  vs restore the picture. **Decided: restore.** Mechanism (recommended
  here, not a separate decision): bytes inline in the bundle as
  `saved_uploads`, the `assets` precedent, rather than a student GET route
  plus a host→page channel.
- **D-2 wire shape.** `saved_responses` keyed by item id with
  `ItemResponse` values, plus `saved_uploads`; both emitted only when
  non-empty. Recommended as stated.
- **D-3 restore never posts.** The restored state is the baseline; the
  spool sees nothing until the student changes something. Recommended.
- **D-4 one query, one pass** for marks and values. Recommended.
- **D-5 inline cap.** `image/png` / `image/jpeg`, ≤ 2 MB per upload;
  otherwise the field says "Saved." without the picture. Recommended
  default; raise if a real drawing ever trips it.

## Progress

Slices 1–2 are batch 2 of `docs/client-fixes-batch-2026-09.md`; the client
slice ships in that batch's single rebuild.

**Slice 1 BUILT 2026-09-03 (local).** The design tool.

- `packages/schema/src/delivery.ts`: `saved_responses` (record of item id →
  `ItemResponseSchema` — the values can be nothing but a student's own
  answer shape) and `saved_uploads` (record of upload id → `BundleAsset`);
  the `superRefine` uuid-key check now covers both blob maps. Exported
  `DeliverySavedResponses` / `DeliverySavedUploads`. `dist` rebuilt.
- `lib/api/savedResponses.ts` (new): `collectSavedAnswers(db, attemptId,
  itemRows)` — the one `{ item_id, response }` query, one pass in item order
  over this assessment's items (D-4); a row that no longer parses as a
  response is warned about and still counts as answered (a student who
  cannot open the test is worse off than one who retypes an answer — an
  addition to the design, deliberate); `sealResponseIds` for match / order;
  `readSavedUpload` — the slot scoped to (attempt, item), `complete` only,
  `image/png` / `image/jpeg` only, `head` then `get` against
  `SAVED_UPLOAD_MAX_BYTES` = 2 MB (D-5), every miss or throw → `null` with a
  `console.warn`, never a failed bundle; read-only (a pending slot is not
  settled from a GET).
- `lib/api/studentAttempt.ts`: `sealResponseIds` beside `unsealResponseIds`
  — the inverse pair kept in one place; a stored id that no longer names one
  of the item's options is dropped rather than refused (history, not an
  attack), null when nothing survives → the item is omitted from
  `saved_responses` but still marked answered.
- `lib/api/responseUploads.ts`: `loadUploadForItemIds` (by ids) with
  `loadUploadForItem` delegating, so the (attempt, item) scope is written
  once.
- `lib/api/buildDeliveryBundle.ts`: the inline `responses` query is replaced
  by the collector; `saved_responses` / `saved_uploads` spread in only when
  non-empty. A fresh attempt's bundle is byte-identical to before.
- Tests: `packages/schema/test/delivery.test.ts` (+6: absent by default, all
  nine response shapes verbatim, a non-response `type` refused, a smuggled
  key stripped, empty item-id key refused, uuid-keyed `saved_uploads`);
  `design-tool/test/delivery-api.test.ts` (+9: fresh attempt has none of the
  three; MC / short_text / essay / table verbatim with `keys(saved_responses)`
  = `answered_item_ids`; match and order re-sealed and checked against ids
  computed with `opaqueId` AND against the bundle's own `lefts` / `rights` /
  `entries`; drawing bytes round-trip; a pending slot and a PDF upload list
  the answer without bytes; another student's answer and upload do not leak;
  the whole-body key scan re-run with answers saved). Schema 110 pass;
  design-tool 1111 pass; typecheck clean. Row 58 in
  `docs/design-tool-manual-checks.md`.
- One correction to this page: a key-shaped field in the bundle is
  *stripped* by Zod, not refused — that is what the existing strip tests
  assert and what the new ones assert too; refusal is for a
  `saved_responses` value whose `type` is not a response type.

Built by an Opus 5 subagent from this page; reviewed and the suites re-run
in the main session.

**Slice 2 BUILT 2026-09-03 (local).** The client.

- `DeliveryBundle.swift`: `savedResponses: [String: ItemResponse]` (the
  existing response decoder reads the bundle values as-is; its page-message
  encoder is untouched) and `savedUploads: [String: BundleAsset]`, both
  defaulting to empty.
- `AssessmentPage.swift`: `SAVED` / `SAVED_UPLOADS` beside `ANSWERED`;
  `savedFor(item)` hands a value to a builder only when it is an object whose
  `type` is the item's own. Each builder restores at build time exactly as
  the table above says, with no post: MC `checked` (set before
  `refreshClear()`, so a restored item's Clear answer button starts
  enabled); short_text value + one formula-preview render; essay value
  before the word count; match `select.value` only when the saved id is one
  of the options actually built; order entries reordered before the rows —
  named ids first in saved order, the rest in their shuffled order; hotspot
  buttons created already `selected` / `aria-pressed="true"`; table cells;
  drawing — an `Image` onto the canvas via `drawImage` when the bytes came
  (guarded for a runtime without an image decoder), and in every saved case
  `marked = true` + "Saved." so pressing Save on last session's work is not
  refused as "Draw something first." A comment marks where a later
  background paint must go (before the `drawImage`).
- Harness: `Image` stub whose `src` setter fires `onload` synchronously
  (which also pins the onload-before-src order the renderer must keep) and a
  `drawImage` op that records the source and geometry.
- Tests: `RendererPrefillTests` (13: every type restores with no response /
  upload / withdrawal / submit posted; a change after a restore still
  posts; a type mismatch is ignored; a match value that is not an option
  and a hotspot id that is no longer a region are skipped; unnamed order
  entries follow the named ones; a restored MC starts with Clear enabled and
  withdraws once; drawing with bytes records `drawImage` with the data URL
  and the canvas geometry, marked, "Saved."; without bytes no `drawImage`,
  still marked and "Saved."; Clear on a restored drawing wipes it; a restore
  does not mark the paged strip; the plain fixture and the same fixture with
  empty saved maps serialise to the same tree); `DeliveryBundleTests` (+3:
  fixture carries none; a bundle with sealed-looking match ids and a drawing
  blob decodes; a non-response `type` fails the decode). `swift test` 353
  pass (was 337); `xcodebuild … build` succeeds. Ten client rows in
  `client/MANUAL-CHECKS.md` ("P-1 — saved answers come back on resume").
- Not testable headlessly: the real image decode and paint, a real
  `<select>` taking the value, layout and KaTeX of a restored preview — the
  rows cover them.

Built by an Opus 5 subagent from this page; reviewed and `swift test` +
`xcodebuild` re-run in the main session.

**Slice 3 — hand-run DONE 2026-09-03 afternoon (origin, rev 10; James at
the client, Claude on the teacher side).** Fixture `Client-fixes hand-run
2026-09-03` (imported bundle: every item type, three drawings, paged); one
demo student, two sittings on one attempt. Of the ten client rows, eight ✅
(a response line per answer then a clean `DID END`; `resumed` and the
fields back; the picture back with "Saved."; no post between the join and
the first change; the changed short-text answer scored 0 / 1 against its key
— the change, not the original; Clear on the restored multi withdrew and
Results reads `no_response`; Save on the restored drawing uploaded), one not
itemised (the strip marks against the fields), one not producible by hand
(the > 2 MB / non-image slot — the `delivery-api` tests cover it); the
offline half of the last row ✅ the same afternoon (the harness fixture via
Cmd-O: empty fields, no marks). Row 58 (the bundle JSON with
a minted token) is not run — it needs local dev; the client's behaviour
covered it. Detail in `client/MANUAL-CHECKS.md` "P-1 — saved answers come
back on resume". F-1 stands: the three saved PNGs were verified by reading
the S3 objects back with the AWS CLI, nothing in the app shows them.

# Client-fixes batch, September 2026 — plan and handoff

Written 2026-09-03 from James's list of five; decisions on the open
questions were James's the same day. **Three batches, one deploy (image
only — no migration in any of the five), one client rebuild, one hand-run
afternoon.** Each batch is written so a fresh session can carry it: read
`CLAUDE.md`, this page, then the design page named in the batch.

| # | Item | Design record | Batch |
|---|---|---|---|
| 1 | E3-F1 — a keyless table defaults to hand-scored, flips to auto on the first key | `docs/e3-table-item-design.md` §Progress "E3-F1" | 1a |
| 4 | Essay / long-text box: bigger default | this page, §1b | 1b |
| 3 | "Clear answer" on multiple-choice items | this page, §1b | 1b |
| 2 | P-1 — saved answers come back on resume | `docs/resume-prefill-design.md` | 2 |
| 5 | Drawing item: grid / axes background | `docs/drawing-background-design.md` | 3 |

## Rules for the whole batch

- **Hot files.** `client/SecureTestCore/Sources/SecureTestCore/AssessmentPage.swift`
  is touched by 2, 3, 4, 5; `packages/schema`, `DeliveryBundle.swift` /
  `DeliveryItem.swift` and the regenerated fixture by 2 and 5. The fixture
  regenerates with fresh uuids every run, so two sessions regenerating in
  parallel conflict. **One session at a time on the client line (1b → 2 →
  3).** 1a is design-tool only and runs beside it on its own branch.
- **Conventions unchanged:** one slice, one commit, wait for James's
  "proceed"; never push without approval; `packages/schema` edits need
  `bun run build` there; the fixture regenerates with
  `DATABASE_URL=…_test bun scripts/generate-delivery-fixture.ts` from
  `design-tool/`; `swift test` + `xcodebuild … build` for every client
  slice; full design-tool suite against the test DB + `bun run typecheck`
  for every design-tool slice; rows added to `client/MANUAL-CHECKS.md` /
  `docs/design-tool-manual-checks.md` in the slice that creates the
  behaviour, run after the deploy.
- **Branches:** the two-terminal convention — a second session works on a
  `claude/*` branch and lands on `main` by merge or PR; fetch + rebase
  before every push.

## Batch 1a — E3-F1 (design tool only, size S, one commit)

Scope is decided and recorded (`docs/e3-table-item-design.md:373-381`).
Four sites, no migration (scoring method lives in `items.config`, stored
only when the teacher picks explicitly):

- `design-tool/lib/api/items.ts:215-220` `effectiveScoringMethod(type,
  config)` — already receives `config`; for `table`, no `config.cell_keys`
  (or an empty object — `compactCellKeys` never stores one) and no explicit
  `config.scoring_method` → `human`; any key present → `auto`; an explicit
  choice always wins. `DEFAULT_SCORING_METHOD.table` can stay `auto` as the
  keyed default or become the function's concern — keep the table lookup
  and add the key-aware branch in front of it.
- `design-tool/app/dashboard/[id]/AssessmentEditor.tsx:293-303`
  `SCORING_DEFAULT` is a `Record<ItemType, ScoringMethod>` rendered at
  `:2402-2404` as "Default — Auto". Make the default label a function of
  the item (type + config) so a keyless table reads "Default — Hand-scored"
  and flips when the first key is typed. `TableEditor.tsx:191-193` already
  says the right thing.
- `design-tool/app/api/assessments/[id]/review-queue/route.ts:166-167`
  skips `method === "auto"`; with the resolver key-aware, keyless tables
  list themselves. Check the auto-score gate
  (`app/api/attempts/[attemptId]/score/route.ts:101`) uses the same
  resolver. `tableMaxPoints` already gives keyless = every body cell.
- Readiness (`readiness.ts:121-131`) needs nothing — it never blocked a
  keyless table.
- Tests: `items-api` (a keyless table's effective method is `human`; add
  one key → `auto`; explicit `auto` on a keyless table stays `auto`;
  explicit `human` on a keyed table stays `human`), `review-queue` (a
  keyless table with a response is listed with `max_points` = cells; a
  keyed one is not), `item-readiness` unchanged.
- **Live effect to record in the hand-run row:** keyless tables already
  published with no stored method become hand-scored on deploy — the
  intent. Row: create a keyless table, publish, a student answers, it
  appears in the Scoring queue; add a key on a draft copy → "Default —
  Auto".

## Batch 1b — essay size + Clear answer (client only, size S, two commits)

**#4 Essay box (commit 1).** `.essay` has no CSS at all — `itemStyles`
(`AssessmentPage.swift:51-103`) styles `.short-text` and the E12 outline
textarea (`min-height: 140px`) but never `.essay`, so WebKit's default
two-row textarea shows. Add, matching `.short-text`:

```
.essay { width: 100%; box-sizing: border-box; min-height: 240px; padding: 8px 10px;
  font: inherit; border: 1px solid #c7c7cc; border-radius: 6px; resize: vertical; }
```

About ten lines tall, draggable taller (James, 2026-09-03: OK). No JS
change; CSS is not harness-testable — one client row (essay renders ~10
lines, the resize handle works, the E12 outline is unchanged).

**#3 Clear answer (commit 2).** Multiple-choice single and multi only
(James, 2026-09-03; the other ≥1-id types — match, order, hotspot, table
— adopt the same channel later, one line each). The withdraw path exists
end to end and is unused: `ResponseSpool.enqueueWithdrawal`
(`ResponseSpool.swift:95-97`, nil payload = delete, latest write wins on
`(attempt_id, item_id)`) → `APIClient.deleteResponse`
(`APIClient.swift:258-263`) → server `DELETE
/api/attempts/{id}/responses/{itemId}` (idempotent 204, refused after
submit, `route.ts:147-176`). `enqueueWithdrawal` is called only from tests
today. What is missing:

- **Page** (`AssessmentPage.swift`): in `choiceList` (`:296-327`) a
  `<button type="button" class="clear-answer">Clear answer</button>` after
  the labels, disabled while nothing is checked. Click → uncheck every
  input, `withdraw(item.id)`. For multi, the "all boxes cleared → return"
  branch at `:313-316` becomes a withdrawal too. `withdraw(itemId)` posts
  `window.webkit.messageHandlers.withdraw.postMessage({ item_id })` and
  `markUnanswered(itemId)` (delete from `ANSWERED`, call `onAnswered`) so
  the paged strip button loses `answered` and the review count drops.
  `ANSWERED` (`:150-158`) is write-only today. CSS for the button.
- **Host** (`client/SecureTest/AssessmentViewController.swift`): register
  the `withdraw` handler beside `response` / `upload` / `submit` / `home`
  (`:19-30`), route it in `userContentController` (`:344-374`) to a
  `withdraw(itemID)` that mirrors `record` (`:513-536`):
  `spool.enqueueWithdrawal(attemptID:itemID:)` then flush; on the offline
  source log "withdraw ignored" like `drawing ignored`. Validate the
  payload shape as `handleDrawing` does.
- **Server:** nothing.
- **Tests:** harness gets a `withdraw` recorder beside `__uploads` /
  `__submits`; `RendererChoiceTests` (button on single and multi, disabled
  until a choice is made, click unchecks + records exactly one withdrawal
  and no response post, mark cleared on the paged strip, unchecking the
  last multi box withdraws); `ResponseSpoolTests` already prove withdrawal
  → DELETE.
- **Rows:** answer an MC, Clear, quit, relaunch → no mark, no value (after
  P-1: no prefilled value either); the teacher's review shows no answer;
  Clear on a never-answered item sends a DELETE that returns 204.
- **P-1 interplay:** a restored MC shows the button enabled; a withdrawn
  row is gone, so the next bundle carries neither mark nor value.

## Batch 2 — P-1 (design page written; two slices + rows; size S + M)

`docs/resume-prefill-design.md` is the record: `saved_responses` +
`saved_uploads` on the bundle, derived in one pass with
`answered_item_ids`; match / order re-sealed with `opaqueId`; the drawing
comes back as inline bytes (D-1 restore, D-5 cap); every builder restores
silently. Slice 1 design tool, slice 2 client, slice 3 rows.

## Batch 3 — drawing background (design page written; two slices + rows; size S + S–M)

`docs/drawing-background-design.md` is the record: `canvas.background:
"grid" | "axes"`, painted into the canvas, Clear repaints, editor select,
print graph paper. After batch 2 — same schema / fixture / bundle-model
files.

## Close-out (after batch 3)

1. Push `main` (fetch + rebase first).
2. `cd design-tool/infra && bunx cdk diff` → image only expected → `bunx
   cdk deploy` (James runs it or says so; `aws sso login --profile
   <your-sso-profile>` first if the token has expired). **No `migrate-aurora`.**
3. `cd client && xcodebuild -project SecureTest.xcodeproj -scheme SecureTest
   -destination 'platform=macOS' build`; confirm the built dylib carries a
   string from each batch (e.g. `clear-answer`, `saved_responses`,
   `data-background`).
4. Rows: E3-F1 teacher rows in Chrome on the origin; the client rows for
   1b, 2, 3 need a student sign-in (one sitting covers all of them:
   answer every type incl. a drawing on `axes`, Clear one MC, quit,
   relaunch, check every field, hand in, score).
5. Update `CLAUDE.md`'s state bullet and the memory file.

## Model and effort

Facts (Claude Code docs, checked 2026-09-03): effort is per session —
`/effort <low|medium|high|xhigh|max>` mid-session, or `effortLevel` in
settings; a subagent runs at its own `effort:` from
`.claude/agents/<name>.md` frontmatter if set, else inherits the parent's;
the Agent tool's `model` override does not set effort.

| Batch | Model | Effort | Why |
|---|---|---|---|
| 1a E3-F1 | Sonnet 5 | medium | four known sites, existing tests to extend, no client |
| 1b essay + Clear | Sonnet 5 | high | mostly one file; the host channel is the one new piece; harness tests cover the page side |
| 2 P-1 build | Opus 5 | high | re-sealing, same-pass derivation, eight builders, a harness `Image` stub, fixture |
| 3 background | Opus 5 | medium | unguarded 10-file checklist; the paint itself is small |
| Close-out | any | — | deploy is James's `!`; rows are Chrome + a student |

Recommended shape: **1a in a second terminal** (`/model sonnet`, `/effort
medium`, branch `claude/e3-f1`; no file overlap with the client line).
**The client line (1b → 2 → 3) from one session, sequentially**, each
slice delegated to a subagent with the model override and reviewed before
James is asked to approve the commit — or run in that session directly if
per-slice effort control matters more than cost (a subagent inherits the
session's effort unless an agent definition sets it).

## Progress

2026-09-03: this page and the two design pages written (a25e01f).

- **Batch 1a DONE** — E3-F1 built in the second terminal (Sonnet 5 /
  medium, `claude/e3-f1`), reviewed and merged here as 9f89a51 (branch
  commit 3718c79); design-tool 1102 pass, typecheck clean at the merge;
  row 57 written, unrun. Worktree and branch removed.
- **Batch 1b DONE** — d130922 (#4 essay box `.essay` rule, 3 rows) and
  92b8d27 (#3 Clear answer: page `withdraw` channel + host handler onto the
  existing spool withdrawal, `ANSWERED` un-mark, harness recorder,
  7 tests → 337, 5 rows). Sonnet 5 subagent, reviewed and re-run here.
- **Batch 2 DONE** — 53855cb (P-1 slice 1: `saved_responses` +
  `saved_uploads`, one-pass collector, re-sealing, capped drawing bytes;
  schema 110 / design-tool 1111, row 58) and 132929a (P-1 slice 2: the
  client restores every field, drawing picture via `drawImage`; `swift test`
  353, 10 rows). Opus 5 subagents, reviewed and re-run here. Both design
  pages' §Progress carry the detail.
- **Batch 3 DONE** — bfa6140 (slice 1: `canvas.background` in the shared
  schema carries through every pass-through; editor select + default-size
  rule; preview / print graph paper; fixture reseeded `axes`; two P-1
  prefill tests made regeneration-proof; schema 114 / design-tool 1119) and
  the client slice (paint into the canvas at build and on Clear, before the
  P-1 restore; `swift test` 362; 9 rows). Opus 5 subagents, reviewed and
  re-run here. The design page's §Progress carries the detail.
- **Close-out DONE 2026-09-03 ~12:05 PT** — pushed (`origin/main` =
  3d725f8, the client slice); `cdk diff` showed the task definition's image
  only; `bunx cdk deploy` ran from the session on James's say-so (11:57 →
  12:01 PT, 221 s) → **task def rev 10, rollout COMPLETED, /api/health 200;
  no `migrate-aurora` (Aurora stays at 0027)**. The client was rebuilt from
  3d725f8 (DerivedData `SecureTest-gwoymhsfucmcdzaznczoqsmmosaf`; the dylib
  carries `clear-answer`, `saved_responses`, `data-background`,
  `paintBackground`). CLAUDE.md's state bullet updated.
- **Hand-run DONE 2026-09-03 afternoon** (origin, rev 10; James at the
  client with the demo student account, Claude on the teacher side in
  Chrome). Fixture: `Client-fixes hand-run 2026-09-03` (`0e1108d6…`),
  imported through `/api/assessments/import` from a bundle written in the
  scratchpad — every item type, three drawings Blank / Grid / Axes, a
  keyless table, paged — then published; a Picked-students session,
  Rest of day. Two sittings on one attempt (answer everything and Clear the
  MC → Cmd-Q → resume, Clear the multi, re-save the drawing, change the
  short text, hand in), then a scoring pass. Results: row 57 ✅; client rows
  — essay 1 ✅ / 2 not exercised / 3 not run; Clear answer 3 ✅, 1 not
  exercisable (the button is disabled until a choice is made), the offline
  row ✅ (`withdraw ignored: no server session` on the harness fixture via
  Cmd-O); P-1 8 ✅ plus the offline half of the last row ✅ (empty fields,
  no marks), 1 not itemised, 1 not producible;
  background 8 ✅ (the stored PNGs read back from S3 — F-1 means nothing in
  the app shows them), 1 not run. Row 58 not run (needs local dev + a minted
  token; the client's behaviour covered the bundle). Findings, all recorded
  and placed in `docs/roadmap-2026-09.md` "Findings from the 2026-09-03
  sitting": the hotspot renderer has no CSS (regions are grey buttons under
  the image — a shipped defect, batch 0b); math preview always on (0b);
  match marked answered on the first pair (0b); order as drag-and-drop
  (batch 4); predictive text in the essay under simulated lockdown (the
  real-session row in batch 2, finding 8.4). The fixture's hotspot picture
  itself was a hand-pasted, truncated PNG — WebKit refused it, Chrome drew
  part of it; not an app defect. Fixture left on the origin for the F-1 /
  hotspot work; delete when done. F-1 stands, unbuilt.

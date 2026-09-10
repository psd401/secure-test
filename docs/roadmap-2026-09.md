# Roadmap, September 2026 — what comes after the client-fixes batch

Written 2026-09-03 from James's four adds (a client UI and branding pass; a
feedback button that logs and emails; error tracking on both sides;
reporting with in-app views, PDF / CSV exports and gradebook integration)
set against what the roadmap docs, the code and the deployed stack actually
show. Decisions marked **D-n** are James's (2026-09-03). Each batch below
has, or will have, its own design page; this page is the order and the why.

## What is more pressing than any of the four (found, not previously tracked)

- **Verification debt.** 29 rows from the 2026-09-03 batch are deployed
  and unrun (`docs/design-tool-manual-checks.md` rows 57–58; 27 client
  rows in `client/MANUAL-CHECKS.md`), plus ~10 E6 / E7(b) client rows.
  One student sitting closes them. Nothing to design.
- **The client has never been packaged.** No git tag, no GitHub release,
  no `.pkg`, no Installomator label; the `psd-sign` recipe has never run
  for it; the build is development-signed only (`client/README.md`). The
  App ID changed 2026-09-03 and the real-session lockdown row has not been
  re-run on it. Every student Mac, and the batched IT afternoon (the
  shipping identity's grants, Jamf scope, the dictation profile), depends
  on this — the IT request itself says "before the client is packaged for
  Installomator" (internal — see the ops repository).
- **Scoring hygiene.** Auto-scoring runs only when a teacher triggers the
  score pass — `submit` flips status and nothing else
  (`app/api/attempts/[attemptId]/submit/route.ts`); F-1: a saved drawing
  cannot be viewed or scored (the queue renders it blank, nothing reads
  `response_uploads` back); the results path carries `ssid` (usually blank)
  and a name, no student number or section, though the roster joins exist
  (`lib/roster/queries.ts`, the attendance view). Size S, high value, and a
  prerequisite for every reporting feature.
- **Also on the books:** row 19 (the colleague run — the one explicit
  pre-pilot gate), row 29 (needs a second staff account), no pilot date or
  population decided (`docs/plan.md` 6.13 — D-0 below: "soon").
- **Structural gaps with no ticket:** the live stack has no CloudWatch
  alarms, no log retention and no error alerting (the health check is a
  liveness probe and stays green while every DB page 500s); the student
  client has never had a UX or accessibility pass although it is the
  surface DOJ Title II binds (`docs/ux-pass-1.md` §a11y); the
  `color_contrast` / `optional_font` / `zoom` accommodations the catalog
  offers teachers are not implemented in the client at all.

## The order (D-1, James: OK; "we can change these later" — yes)

| # | Batch | Design page | Why here | Line |
|---|---|---|---|---|
| 0 | Run the 29 rows + row 19 | — | students hit unverified code otherwise | James + Chrome |
| 0b | **Client fixes from the 2026-09-03 sitting**: hotspot regions overlaid on the image (the renderer has never had CSS — four grey buttons under the picture), the math preview on every short-text answer, match marked answered only when every pair is set | this page, "Findings from the 2026-09-03 sitting" | a shipped defect plus two one-line fixes; one rebuild, ahead of the first package | client, ∥ with 1 |
| **S** | **Multi-source stimulus** (2026-09-09, from the first pilot assessment: one essay prompt followed by four labelled sources and three vector charts — the import returned the essay alone): `sources: [{label, text}]` on a set, a `side_by_side` layout, source tabs in the client, the prompt rewritten for single-question sets with sources after the prompt, vector charts rasterised on the server (spike S4) | `docs/multi-source-stimulus-design.md` | **NOW, ahead of everything queued (D-5 there)** — it is the initial pilot assessment; slice 1 (line breaks) built 2026-09-09 | both sides |
| **S-f** | **Multi-source follow-ups from the 2026-09-09 sitting** (`docs/multi-source-stimulus-design.md` §Progress "Findings"; decisions D-7…D-9 there — James 2026-09-09: both zoom parts, autosave, fullscreen stays the launch default). In build order: **C-2** `$` directly before a digit never opens KaTeX — design-tool `renderLatex` / `renderItemContent` AND the client's auto-render pass, importer prompt writes currency as `\$`, tests both sides; **C-1** the client evaluates `WIDE` on the first layout pass after the session is active (not at script start) and gains a student toggle "Sources beside / above the question" (in-memory per set; the passage page + collapsed pane presentation stays); **C-4** `WKWebView.allowsMagnification` on, 1×–3×, Session menu "Actual size" Cmd-0, AND click-to-enlarge on any image in a stem or source (overlay, Esc / click closes); **C-6** the Accommodations tab autosaves (debounced PATCH per change, saving / saved indicator, Save button goes); **C-7** the dev launcher forwards `SECURE_TEST_NO_FULLSCREEN` (dev only — fullscreen remains the default); then re-run the two VoiceOver rows (Quick Start dismissed outside a session first). Ships as **client v1.2.0** (slice 4 + C-1 + C-2 + C-4) and one deploy (C-2 server + C-6). **ALL FIVE BUILT 2026-09-09** (`508d7d6` C-2, `8f9f09a` C-1, `e61d95b` C-6, `9c7d28c` C-7, `f6bfaa6` C-4; note §Progress "Row S-f progress" is the record); rows written, NOT run; nothing deployed, no release yet | `docs/multi-source-stimulus-design.md` | the pilot document shows C-2 on its own Source B; C-1 is what the student sees first in a real session | **fresh session — start here.** Main session Fable / medium orchestrates, one commit per slice, diffs reviewed + checks re-run in the main session before each commit. C-2: two **Opus 5 / medium** agents in parallel (design-tool renderer + tests ∥ client auto-render pre-pass + JSC tests — disjoint files, same checkout). C-1: **Opus 5 / medium** agent (client; the note's C-1 entry is the spec), M. C-4: **Opus 5 / medium** agent (client), S. C-6: **Sonnet 5 / medium** agent (design-tool), S. C-7: main session, XS. Rows: **Sonnet 5 / medium** per client slice into `client/MANUAL-CHECKS.md`; teacher rows for C-2 / C-6 into `docs/design-tool-manual-checks.md`. Release + deploy: James by hand (`client/RELEASING.md`, the deploy script pattern) |
| 1 | **Scoring hygiene** — BUILT 2026-09-03 (`eb2c969` / `df899b2` / `7d9a3e0`, rows 59–61 unrun): auto-score on submit, F-1 drawing viewer, student number + section on results and CSV | `docs/reporting-design.md` R0 | unblocks scoring and everything in 5 | design tool |
| 2 | **Package + sign the client** — **v1.0.0 2026-09-07, v1.1.0 PUBLISHED 2026-09-08** (hand-install row still open): v1.0.0 published on `psd401/secure-test` (notarized app + pkg), real AAC session on the notarized build, D-R4 no PPPC, IT handoff drafted (ops repo); fleet scope pending; with the AppKit half of branding (icon, accent, one name, About / version, build stamp), and fix the `psd-sign` skill; its real-session hand-run re-checks predictive text in the essay (finding 8.4) | `docs/client-release-plan.md` (+ `docs/client-ui-pass-design.md` slice C) | gates the pilot and the IT afternoon; the first package is what IT and students see | client + release |
| 2b | **Public repository**: sweep, squash, move development there; archive this repo; a private ops repo for what stays internal | `docs/public-release-plan.md` | the release's `gh release` needs a public home; runs beside 2 and must finish before 2's release slice | docs + infra config, ∥ with 2 |
| 3 | **Observability** — **BUILT + DEPLOYED rev 12 2026-09-07** (Aurora 0028); teacher rows 62–68 ✅ incl. feedback email + synthetic alarm; client rows + row 67 open | `docs/observability-design.md` | shared SNS → email plumbing, events-table pattern, version stamp, one deploy; hear from classrooms you are not in | both sides |
| 4 | **Client UI pass** — **BUILT 2026-09-07, HAND-RUN 2026-09-08** (three real-session passes; drag → pointer tracking after the HTML5 drop failed under LockedDownWebView; S-0…S-9 fixed the same day; fullscreen by default); open: VoiceOver pass, per-pair contrast screenshots; SHIPPED in v1.1.0 | `docs/client-ui-pass-design.md` slices A, B, D | largest hand-run burden, better with error signal in place; the accommodations half is equity work and may move ahead if a sitting with accommodated students comes first | client |
| 5 | **Reporting R1–R2** — **R1 + print report BUILT + merged 2026-09-07 evening**, deploy started (rev 13 expected); gradebook CSV WAITS for sample exports (D-R3); rows 69–74 / R2-P1…P6 unrun | `docs/reporting-design.md` | shape it with the first real sittings; E11 waits for the same teacher input | design tool, ∥ with 4 |
| 6 | **Reporting R3**: gradebook integration (PowerSchool official, Schoology covered too) | `docs/reporting-design.md` R3 | post-pilot; needs sample files + district-admin keys → the IT / admin ask list | design tool + infra |
| 4b | **Math entry** — **design note + slices 1a / 1b BUILT 2026-09-08 evening** (`docs/math-entry-design.md` §Progress; rows in `client/MANUAL-CHECKS.md` unrun; 1a needs a deploy, 1b the next client release; spike post-pilot) — (James, 2026-09-08, S-6): a calculator-style keypad for short-text math (fractions, exponents, roots, Greek, ±, ×, ÷ — inserts KaTeX-safe text and re-renders the preview), plus a **spike** on handwriting recognition from the touchpad (Vision `VNRecognizeTextRequest` over a stroke image; PencilKit is iOS-only) | `docs/client-ui-pass-design.md` findings table; design note first | asked for after the first sitting; the keypad closes the `\mathrm{…` confusion for good, handwriting is a maybe | client — **fresh session**; design note Fable / high; keypad Opus 5 / medium (one slice, M); handwriting spike Opus 5 / high (half a day, go / no-go), post-pilot unless the spike is cheap |
| 4b-f | **Math entry follow-ups** (from `docs/math-entry-design.md` §Follow-ups, 2026-09-08; unscheduled): a per-item teacher flag `math_input` so the keypad opens without a `$` in the stem (schema + editor + both bundles + migration); the editor's key field gets the same symbol keys and a hint naming the equivalence rules, and the review queue / results / print render a student's short-text answer through KaTeX as the client does; numeric equivalence for short text (`1/2` ≡ `0.5`, tolerance — adjacent to E11, James's policy); Greek case kept in the fold if a teacher needs `Δ` ≠ `δ`; a "next slot" key if the rows show students lost between `}` and `{`; the drawing toolbar onto the same roving tabindex; the handwriting spike (post-pilot, §Handwriting of that page) | `docs/math-entry-design.md` | recorded when 4b was designed; none blocks the keypad | unscheduled |
| 4c | **Drawing tools** (James, 2026-09-08, S-7): pen size, colour, eraser, undo on the drawing item; the PNG contract with the paper background stays (tools paint into the same canvas) | design note first, then one slice | asked for after the first sitting; equity for graph-heavy math | client — **fresh session**; design note Fable / medium; build Opus 5 / medium (M); Sonnet 5 / medium for the rows |

Parallel lines as in the 2026-09-03 batch: design-tool batches (1, 5) can
run in a second terminal beside client batches (2, 4); batch 3 touches both
sides and should own the tree while it runs. One owner for
`packages/schema`, migrations, the Swift bundle model and the fixture.

## Pilot feedback — questions to put to the pilot teachers and students

Things deliberately NOT built until the pilot says they are wanted. Each is
a question for the feedback round, not a backlog item.

- **A digit pad on the math keys** (`docs/math-entry-design.md` D-2.4,
  James 2026-09-08): the keypad ships with structure, operator and Greek
  keys only; digits, letters and `+ − = /` come from the keyboard. Ask
  students whether they reached for on-screen digits (touch / motor needs)
  and teachers whether any student needed them.
- **E11 rescoring after a key change** — waits for teacher input (above).
- **Gradebook CSV shape** (D-R3) — waits for sample PowerTeacher Pro /
  Schoology exports.

## Findings from the 2026-09-03 sitting (James: place them in the sequence — done above; nothing built)

The client-fixes batch's student sitting (2026-09-03 afternoon, James at
the client, the rows in `client/MANUAL-CHECKS.md`) surfaced five things.
Where each one lands:

| Finding | What | Where | Size |
|---|---|---|---|
| **Hotspot unusable** (defect) | The client's hotspot renderer builds the `<img>` and one `<button class="hotspot-region">` per region with inline percent offsets, but no CSS for `.hotspot-frame` / `.hotspot-region` has ever existed (slice 57 onward), so the frame is not positioned and the regions are default buttons. Seen: no picture at all, four short grey buttons in a 2 × 2 grid under the stem; the five region posts still went through. The missing picture turned out to be the fixture, not the app — the hand-pasted base64 lost part of the PNG (stored 2741 of 3356 bytes), WebKit refuses a corrupt PNG outright while Chrome's preview drew the rows it had. Fix for the CSS: `position: relative` frame, absolutely positioned transparent regions with a visible `selected` state, the image `display: block; max-width: 100%`. | **0b** | S |
| **Math preview always on** | The short-text formula preview renders only when the typed text contains `_`, `^`, `$` or `\` (`FORMULA_CHARS_RE`, `AssessmentPage.swift`). James: render it for every non-empty answer. One regex line plus the harness test. | **0b** | XS |
| **Match marked answered too early** | The strip mark turns green on the first posted response for every type; for match that is the first pair. Mark match answered only when every left has a right (partial responses still post). Order (posts per move) and table (posts per cell) keep today's rule unless James says otherwise. | **0b** | XS |
| **Order as drag-and-drop** | The order item is Move up / Move down buttons today. Add pointer drag (HTML drag events work in WKWebView); the buttons stay as the keyboard and VoiceOver path. Needs a short design note (drop indicator, touchpad, the answered mark). | **4** (client UI pass) | M |
| **Predictive text in the essay** | Auto-completion appeared in the essay box under simulated lockdown. Expected there: the lockdown plan says `predictiveKeyboard=false` but the simulator applies nothing. Under a real session this is open finding 8.4 (word completion survived both knobs on 2026-08-28), so the first signed build's real-session hand-run re-checks it; if it still shows, the fix is a client slice in 2. | **2** (real-session row) | check first |

Not a finding but recorded here: `client/MANUAL-CHECKS.md` Clear-answer row
"Clear on a never-answered item" cannot be exercised — the button is
disabled until a choice is made, by design.

## Finding from the 2026-09-09 hand-run (James: "add the delete-draft slice to the roadmap") — **widened 2026-09-09 to delete draft + archive assessments and test sessions; `docs/archive-and-delete-design.md` is the record (D-1…D-4, slices 0–4)**

| Finding | What | Where | Size |
|---|---|---|---|
| **No way to delete an assessment from the UI** | `DELETE /api/assessments/[id]` exists (owner-only; `requireDraft` 409s on a Published row, so "Unpublish, then delete" is the path), but neither the Assessments list nor the editor offers it — every hand-run cleanup so far has gone through the route from the browser console. Slice: a **"Delete draft"** action on the editor's Settings tab (Draft only; hidden or disabled with a note on a Published row; a confirm dialog naming the assessment and its question count; on 204 route to the list). No route change, no migration; one editor test for the disabled state. | design tool — `AssessmentEditor.tsx` Settings tab; the route already carries the guard | XS — Sonnet 5 / medium, rides the next design-tool deploy |

## Finding from the 2026-09-07 signed-build run (James: "put a delete path on our roadmap") — **BUILT 2026-09-08** (see `docs/reporting-design.md` §Progress; rows 75–78 in `docs/design-tool-manual-checks.md` unrun)

| Finding | What | Where | Size |
|---|---|---|---|
| **No way to delete an attempt** | Attempts are unique per (assessment, student) (`attempts_assessment_student_unq`), and `POST /api/attempts` resumes the existing one — a submitted attempt included — for any later sitting of the same assessment (finding 10.1). Nothing under `app/api/attempts/` deletes, so a student who has handed in can never sit the same assessment again, and a hand-run has to move to an assessment the student has never attempted (or import a copy). Needed: a teacher-facing "Delete attempt" on the results / monitor row, owner-only, confirm first, that removes the attempt, its responses, uploads (S3 objects too), events and scores, and writes an audit row; the next join then creates a fresh attempt. The same path is what a teacher reaches for on a wrong-student join or a retake. | **5** (reporting R1, per-student view; may move ahead as a small design-tool slice since every hand-run on a reused fixture needs it) | S |

## Decisions (James, 2026-09-03)

- **D-0 pilot timing.** No date; "soon is the hope." Consequence: nothing
  here waits on a date, and the accommodations half of batch 4 moves ahead
  of batch 3 the moment a sitting with accommodated students is scheduled.
- **D-1 order** as in the table. Changeable later — yes: the only
  one-way doors are the bundle id and signing identity (TCC grants key on
  them); display name, icon and everything visual change freely.
- **D-2 feedback transport: simple** → an SNS topic with an email
  subscription (sender "AWS Notifications"), not SES. Recorded in the
  observability page.
- **D-3 error tracking: in-house** (CloudWatch + Postgres tables + the same
  SNS topic), not a vendor. Data stays in the account; grouping and
  releases can come later if triage volume demands.
- **D-4 in-attempt client errors also as an `attempt_events` kind**, so the
  teacher monitor shows "Needs attention" live.
- **D-5 gradebook of record is PowerSchool; the export should cover both
  PowerTeacher Pro and Schoology for teachers.** Sample import files and
  the integration path (CSV vs LTI 1.3 AGS vs Schoology REST) are an
  exploration, not yet a decision — the reporting page carries the
  publicly documented shapes and what remains to confirm.
- **D-6 auto-score on submit: yes.**
- **D-7 standards / learning-target tags: later** (not in reporting v1).
- **D-8 (James, 2026-09-03) one development repo, public.** The swept
  public repository is where development moves, and where the client's
  releases publish; this private repo is archived read-only as the
  record; a small private ops repository holds what stays internal. Two
  mirrored repos were rejected (every commit twice, diverging histories).
  Details and the ongoing hygiene rules: `docs/public-release-plan.md`.
- **D-9 (James, 2026-09-03) fix the `psd-sign` skill**, not only document
  around it — the entitlement-stripping re-sign affects every PSD app with
  an entitlement.

## Model and effort (recommendations)

| Batch | Design | Build |
|---|---|---|
| 1 scoring hygiene | this page + reporting R0 | Sonnet 5 / medium |
| 2 package + sign | `client-release-plan.md` | Opus 5 / high; James at the keyboard for Developer ID, notarytool, GitHub; Sonnet 5 / medium for the skill bump |
| 2b public repo | `public-release-plan.md` | Sonnet 5 / high for the scan + scrub (wide and mechanical; a miss is public), a Fable or Opus review of the final tree before the first public push |
| 3 observability | Fable (main session) / high | Opus 5 / high for server + client; Sonnet 5 / medium for the CDK topic, alarms and the feedback dialog |
| 4 client UI pass | Fable / high (a11y + theme decisions) | Opus 5 / high (theme layer, accommodations, AppKit layout — untestable headlessly, so review weight matters) |
| 5 reporting R1–R2 | Fable / high (scoring semantics, FERPA) | Opus 5 / medium; Sonnet 5 for the CSV variants once shapes are confirmed |
| 6 reporting R3 | later | later |
| 4b math entry | Fable / high (keypad layout is a11y + a11y-of-math question) | Opus 5 / medium keypad; Opus 5 / high handwriting spike (Vision) — fresh session |
| 4c drawing tools | Fable / medium | Opus 5 / medium — fresh session; rows Sonnet 5 / medium |

Facts that hold (checked 2026-09-03): effort is per session (`/effort`);
a subagent inherits the parent's effort unless its agent definition sets
one; the Agent tool's `model` override does not set effort.

## Progress

2026-09-03: this page and the design pages for batches 2, 2b, 3, 4, 5/6
written. Nothing built. Batch 0 (the rows) waits on a student sitting.

2026-09-03 afternoon: the client-fixes sitting ran (`docs/client-fixes-batch-2026-09.md`
§Progress) — batch 0's 29 rows are closed except row 58 (local dev) and a
few not-exercised cells; its findings became batch 0b and the additions to
2 and 4 above. Row 19 still open.

2026-09-03 evening: **batch 0b BUILT** in the main session (Fable), three
slices, one commit each — hotspot CSS (regions invisible until hovered or
focused, filled when selected), the math preview on every short-text answer
(spaces kept as `\ `), match marked answered only when every pair is set
(partial pairings still post; a restored partial starts unmarked). `swift
test` 365, `xcodebuild` green; 14 rows in `client/MANUAL-CHECKS.md` ("Batch
0b slice 1–3"), NOT run — they need a rebuild on the student Mac and a
hotspot with a real PNG. Not deployed: client only, no design-tool change.

2026-09-08 evening: **roadmap 4b math entry BUILT** — design note
(`docs/math-entry-design.md`, `8aae6fb`, all decisions 1.1–6.1 accepted by
James), slice 1a the scorer fold (`182cfb9`, design-tool 1255 → 1327 tests,
no migration, NOT deployed — safe to deploy ahead of the client because it
can only add matches), slice 1b the 22-key keypad on short-text items
(`ae86af8`, `swift test` 489 → 514, `xcodebuild` green, client only). Both
built by Opus 5 agents from the note, diffs reviewed and checks re-run in the
main session; one review tightening on 1a (parentheses dropped only beside `/`
or `√`). Rows (slice 2) written to `client/MANUAL-CHECKS.md`, NOT run; the
digit pad sits in §Pilot feedback; follow-ups in row 4b-f; the handwriting
spike stays post-pilot. Nothing pushed at the time of writing.

2026-09-08 ~20:25 PT: **DEPLOYED rev 15** — delete-attempt (migration 0029
via `migrate-aurora.sh`) + math-entry slice 1a; health 200. Colima had to be
started by hand first (`colima start`; it stays stopped after a reboot and
`cdk deploy` then fails at the Docker build). CDK CLI 2.1140.0 is available —
the bump stays a separate step after a deploy.

2026-09-09: **row S opened** — the first pilot assessment (an AP Seminar-style
free-response: one essay, four labelled sources, three vector charts) imported
as the essay alone. `docs/multi-source-stimulus-design.md` has the measured
causes, the shape (D-1…D-5 decided the same day) and six slices; slice 1
(`white-space: pre-line` on stems and stimulus bodies, client + preview +
editor live preview) built the same session. Everything else on this page
queues behind it.

2026-09-09 evening: **row S rows RUN** — teacher rows 79–92 (13 ✅, one
half) and the client sitting (two passes, 18 of 22 ✅, VoiceOver rows
deferred). Findings C-1…C-7 in `docs/multi-source-stimulus-design.md`
§Progress; **C-1 (real-session build reads a narrow viewport → falls back
to the passage page; add a student toggle) and C-2 (dollar amounts in
prose render as KaTeX) are HIGH and go before anything else queued**; C-4
(pinch-zoom + click-to-enlarge on charts) is James's decision; C-6 (the
Accommodations tab's checkboxes look saved without Save) is a small
design-tool fix.

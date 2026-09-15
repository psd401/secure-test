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
| 2 | **Package + sign the client** — **v1.0.0 2026-09-07, v1.1.0 PUBLISHED 2026-09-08** (hand-install row ✅ 2026-09-14 through Jamf — **batch 2 COMPLETE**): v1.0.0 published on `psd401/secure-test` (notarized app + pkg), real AAC session on the notarized build, D-R4 no PPPC, IT handoff drafted (ops repo); fleet scope pending; with the AppKit half of branding (icon, accent, one name, About / version, build stamp), and fix the `psd-sign` skill; its real-session hand-run re-checks predictive text in the essay (finding 8.4) | `docs/client-release-plan.md` (+ `docs/client-ui-pass-design.md` slice C) | gates the pilot and the IT afternoon; the first package is what IT and students see | client + release |
| 2b | **Public repository**: sweep, squash, move development there; archive this repo; a private ops repo for what stays internal | `docs/public-release-plan.md` | the release's `gh release` needs a public home; runs beside 2 and must finish before 2's release slice | docs + infra config, ∥ with 2 |
| 3 | **Observability** — **BUILT + DEPLOYED rev 12 2026-09-07** (Aurora 0028); teacher rows 62–68 ✅ incl. feedback email + synthetic alarm; client rows + row 67 open | `docs/observability-design.md` | shared SNS → email plumbing, events-table pattern, version stamp, one deploy; hear from classrooms you are not in | both sides |
| 4 | **Client UI pass** — **BUILT 2026-09-07, HAND-RUN 2026-09-08** (three real-session passes; drag → pointer tracking after the HTML5 drop failed under LockedDownWebView; S-0…S-9 fixed the same day; fullscreen by default); open: VoiceOver pass, per-pair contrast screenshots; SHIPPED in v1.1.0 | `docs/client-ui-pass-design.md` slices A, B, D | largest hand-run burden, better with error signal in place; the accommodations half is equity work and may move ahead if a sitting with accommodated students comes first | client |
| 5 | **Reporting R1–R2** — **R1 + print report BUILT + merged 2026-09-07 evening**, deploy started (rev 13 expected); gradebook CSV WAITS for sample exports (D-R3); rows 69–74 / R2-P1…P6 unrun | `docs/reporting-design.md` | shape it with the first real sittings; E11 waits for the same teacher input | design tool, ∥ with 4 |
| 6 | **Reporting R3**: gradebook integration (PowerSchool official, Schoology covered too) | `docs/reporting-design.md` R3 | post-pilot; needs sample files + district-admin keys → the IT / admin ask list | design tool + infra |
| 4b | **Math entry** — **design note + slices 1a / 1b BUILT 2026-09-08 evening** (`docs/math-entry-design.md` §Progress; rows in `client/MANUAL-CHECKS.md` unrun; 1a needs a deploy, 1b the next client release; spike post-pilot) — (James, 2026-09-08, S-6): a calculator-style keypad for short-text math (fractions, exponents, roots, Greek, ±, ×, ÷ — inserts KaTeX-safe text and re-renders the preview), plus a **spike** on handwriting recognition from the touchpad (Vision `VNRecognizeTextRequest` over a stroke image; PencilKit is iOS-only) | `docs/client-ui-pass-design.md` findings table; design note first | asked for after the first sitting; the keypad closes the `\mathrm{…` confusion for good, handwriting is a maybe | client — **fresh session**; design note Fable / high; keypad Opus 5 / medium (one slice, M); handwriting spike Opus 5 / high (half a day, go / no-go), post-pilot unless the spike is cheap |
| 4b-f | **Math entry follow-ups** (from `docs/math-entry-design.md` §Follow-ups, 2026-09-08; unscheduled): a per-item teacher flag `math_input` so the keypad opens without a `$` in the stem (schema + editor + both bundles + migration); the editor's key field gets the same symbol keys and a hint naming the equivalence rules, and the review queue / results / print render a student's short-text answer through KaTeX as the client does; numeric equivalence for short text (`1/2` ≡ `0.5`, tolerance — adjacent to E11, James's policy); Greek case kept in the fold if a teacher needs `Δ` ≠ `δ`; a "next slot" key if the rows show students lost between `}` and `{`; the drawing toolbar onto the same roving tabindex; the handwriting spike (post-pilot, §Handwriting of that page) | `docs/math-entry-design.md` | recorded when 4b was designed; none blocks the keypad | unscheduled |
| **R** | **Rubric upload + AI feedback for the pilot** (James, 2026-09-11): upload a rubric (PDF / DOCX / Markdown / paste; PDF and DOCX as Converse document blocks) → proposed `RubricSchema` with warnings, missing points auto-assigned; a per-teacher rubric library with copy-on-apply; single-point rubrics AI-scorable through a derived below / meets / exceeds ladder; `with_feedback` finally consumed — per-criterion rationale on the family-facing print page (final scores only); `ai_usage` token log line on every Converse call | `docs/rubric-upload-design.md` (D-1…D-7 decided 2026-09-11; slices 0–7, nothing built) | the pilot is the chance to test AI scoring and feedback, and no rubric can enter the tool except by typing | design tool — slice 1 Opus 5, 2 Sonnet 5, 3 ∥ 4 Opus 5, 5 + 6 Sonnet 5, rows Sonnet 5; migration 0032 |
| **T** | **Time limit enforced + unfinished attempts** (James, 2026-09-11: "does the teacher have a way to see what they have done so far?" — no): the client counts down `started_at + time_limit_seconds` on a dismissable banner with notices at 5 / 1 min and ENDS the session at zero without handing in; the server refuses late answers (409 `time_expired`); teachers review in-progress attempts (matrix, per-student page) and can **Hand in** for a student (`POST …/hand-in`, `submitted_by_sub`, auto-score); **migration 0034** | `docs/time-limit-and-unfinished-attempts-design.md` (D-1…D-4 decided 2026-09-11; slices 0–4, nothing built) | the time-limit setting has been a no-op since slice 1; an expired attempt is invisible to the teacher | server Opus 5 → client Opus 5 ∥ teacher UI Sonnet 5 → rows Sonnet 5; client half ships in v1.3.0 |
| 4c | **Drawing tools** (James, 2026-09-08, S-7): pen size, colour, eraser, undo on the drawing item; the PNG contract with the paper background stays (tools paint into the same canvas) | design note first, then one slice | asked for after the first sitting; equity for graph-heavy math | client — **fresh session**; design note Fable / medium; build Opus 5 / medium (M); Sonnet 5 / medium for the rows |
| **X** | **Student work export — printable class packets** (pilot teachers, 2026-09-14): one printable page per handed-in attempt per section, every item type, `☑`/`☐` for every choice, questions on / off, teacher / AI / both / no scores, anonymous labels + a tear-off key page, 1-inch margins; a new `/results/work` page beside the print report (which keeps its no-free-text rule) | `docs/student-work-export-design.md` (D-1 labels + key, D-2 every item type — James 2026-09-14; slices 0–3, nothing built) | the first feature the pilot teachers asked for; the packet is how they annotate | design tool — slice 1 Opus 5 / medium, 2 Sonnet 5 / medium, 3 hand-run Sonnet 5 / low; after corpus slice 1 |
| **Y** | **Essay scoring corpus** (James, 2026-09-14): re-run scored essays against other models / prompts over time — `scoring_runs` + `run_id` / `prompt_version` / `rubric_snapshot` on `scores`, a `research` status invisible to every teacher surface, a prompt-version constant with a drift test, `scripts/score-corpus.ts` + `compare-runs.ts` (agreement with the human final); **migration 0035** | `docs/scoring-corpus-design.md` (D-3 third status, D-4 loss on attempt delete accepted — James 2026-09-14; slices 0–4, nothing built) | the pilot's teacher-scored essays are the data set; without run identity two runs are indistinguishable | design tool — slices 1 + 2 Opus 5 / medium, 3 Sonnet 5 / low, 4 (in-VPC Aurora runs) Sonnet 5 / medium later; **slice 1 first, X after it** |

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

2026-09-14: **first sitting on a district Mac — v1.3.0 installed through
Jamf, a real student, real sessions; batch 2 COMPLETE.** IT's install
(pkg policy + the managed-preferences profile) worked without incident; a
Finder launch showed Sign in with Google, so the profile reaches the
sandboxed app. Two sittings, James at the student Mac, Claude on the
teacher side: `2026 AP Seminar EOC B` (mid-test teacher rows 155–157 /
161 / 77 / 113 ✅, hand-in, essay on the per-student page, section filter
row 70 ✅; the session was closed and the attempt deleted afterwards so the
pilot teachers see the assessment fresh) and `Time limit hand-run
2026-09-11` (the session ended on its own at zero with the "Time is up."
sheet; the teacher hand-in ran through the route while the session was
still open). The one-day teacher-row script had been lost and was rebuilt
the same morning (`~/secure-test-hand-teacher-row.sh`, student number as
its argument). **Findings (T-1 / T-2 / R-4 BUILT 2026-09-14 — `acf8eb4`
/ `56c9964` / `8539c15`, not yet deployed or released; T-3 / C-8 open):**
- **T-1 (client, v1.3.1):** the countdown banner's × freezes the strip at
  its last value instead of hiding it — `.time-limit { display: flex }`
  outranks the UA `[hidden]` rule and the page has no `.time-limit[hidden]`
  rule (every other hideable does). One CSS line + a test. BUILT → v1.3.1.
- **T-2 (design-tool):** Hand in stays disabled after the attempt's deadline
  while the sitting is open — the route relaxes `session_open` (D-4/A) but
  the matrix, per-student and Monitor controls enable on `sitting_open`
  alone. The rows need a deadline-passed flag; S. BUILT (`deadline_passed`
  on the results + monitor rows, the route's own helpers).
- **T-3 (client, unverified):** no 1-minute notice was seen after the
  banner was hidden at 2:11; the notice is host-driven and should be
  independent of the strip — re-check with a Terminal launch so the log
  is readable.
- **R-4 (design-tool, pilot-relevant):** an `ai` / `hybrid` essay has no UI
  path to its FIRST AI proposal — the queue card offers only the manual
  picker, "Re-run AI" appears once a proposal exists, and the attempt-wide
  `score-ai` route has no caller. A "Score with AI" button on the
  needs-manual card (the `rescore-ai` route already accepts a response with
  no prior proposal); S. BUILT (row 144 re-runnable on a Bedrock sitting).
- **C-8 (design decision):** an `own_page` set shows no Beside / Above
  toggle — James expected the student to be able to choose. Options: offer
  the toggle on `own_page` sets too, or make `side_by_side` the default
  layout for a set with sources.

### 2026-09-14 evening — pilot teachers' export request + the corpus question

Two design notes written (X and Y in the table): `docs/student-work-export-design.md`
and `docs/scoring-corpus-design.md`. Nothing built at the time of writing;
corpus slice 1 (migration 0035 + the reader sweep) starts next.

### 2026-09-15 — client end-state audit, and security slice 1

An audit of what actually removes the test from the screen when a session
ends. The finding: nothing did. Only a screen change (`showEntry` /
`showAssessment` replacing the window's content view) ever took assessment
content down; the lockdown state handler swapped titlebar accessories and put
up a sheet, and that was all. Five consequences, all verified in the code:

1. **Emergency end (Cmd-E / the titlebar button) offered "Stay here."** The
   session ended, the Mac unlocked, and the whole test stayed rendered and
   still saving answers behind a second button that invited exactly that.
   Escape on the sheet mapped to it too.
2. **A failed `begin()` delivered the test unlocked.** The page-load gate
   opened on every state except `.starting`, so `.idle` after a
   `failedToBegin` or an interruption released the build — the test was handed
   over precisely because the lockdown had refused to start. The oldest
   hand-run row for `SECURE_TEST_SIMULATE_LOCKDOWN=refuses` recorded this as
   the expected behaviour.
3. **The gate's backstop built the page anyway.** Five seconds, then "building
   anyway" — a hung session cost the test's protection rather than the
   student's time.
4. **Time-limit expiry** left the page loaded behind its one-button sheet.
5. **Watchdog expiry** ended like (1), with the same aftermath.

**Slice 1 (built 2026-09-15, client only):** the test page is on screen only
while the session is active. The gate (Core, `PageLoadGate`) gained an
outcome — opened / refused / timed out — and opens on `.active` alone; a
`.idle` reached before it ever opened refuses it; the backstop is 20 s (a real
`begin()` answers in about two) and neither a refusal nor a timeout builds
anything. A refusal or timeout instead ends whatever is up, returns to "Your
tests" and shows a one-button "Couldn't start a secure session" sheet. Every
end that is not a hand-in — emergency exit, watchdog, interruption, the time
limit — now calls `showEntry()` FIRST and presents its one-button sheet there
("Time is up." or "Secure session ended"); "Stay here" and the copy inviting
it are gone. Hand-in and the Cmd-Q path are untouched by design. Cooperative
simulated sessions stay active-synchronously, so
`SECURE_TEST_SIMULATE_LOCKDOWN`, the dev launcher and the whole suite still
work. Rows: `client/MANUAL-CHECKS.md` "Content only while locked
(2026-09-15)", NOT RUN; the four rows this contradicts are marked superseded
in place.

**Slice 2 (BUILT 2026-09-15, client only):** nothing a student can set from
Terminal weakens a Release build. The client had **no `#if DEBUG` anywhere**, so
every development knob shipped live in the notarized app. A new `BuildPosture`
enum in the app target (the only place `#if DEBUG` appears — `SecureTestCore`
stays configuration-agnostic and takes explicit parameters, because SwiftPM
builds it in debug for `swift test`) gates all of them:

1. **The watchdog is off in Release** (James's decision). `Timings.watchdog` is
   now optional and `fromEnvironment(_:allowOverride:)` returns nil for
   Release, where `SECURE_TEST_WATCHDOG_SECONDS` is not read at all. It counted
   600 s of wall clock from `begin()` with no reset, so **every fleet session
   was ending itself at ten minutes**. Nothing is armed, nothing counts down,
   and `end()`, the escalation and the teardown grace backstop are unchanged.
2. **`SECURE_TEST_SIMULATE_LOCKDOWN` is Debug only** — and it was checked
   BEFORE the entitlement, so a Terminal launch turned a real session into a
   cooperative fake.
3. **A Release build with no AAC entitlement refuses** rather than falling back
   to a cooperative simulation: `RefusedLockdownSession` (Core) fails to begin
   immediately, which takes slice 1's refused-gate path — "Couldn't start a
   secure session", no test rendered. Debug keeps the fallback for unsigned dev
   builds and CI.
4. **`SECURE_TEST_NO_FULLSCREEN`**, **`SECURE_TEST_DEBUG_CRASH`** and
   **`--token` / `SECURE_TEST_TOKEN`** are Debug only.
5. **Managed preferences outrank the launch argument and the environment in
   Release** (`ClientConfiguration(… managedPreferenceWins:)`), so a Jamf-forced
   `ServerURL` / `GoogleClientID` cannot be overridden from Terminal. They stay
   the fallback where no profile is installed, so an unmanaged Release build is
   still configurable; Debug is unchanged.
6. **The offline bundle path is Debug only** — `--bundle` ignored, no File menu
   and no Cmd-O, because it renders assessment content with no attempt, no
   session and no reporting.

The app logs `build posture: RELEASE — development overrides ignored` at
launch. `swift test` 626 (611 + the nil-watchdog, refused-session and
managed-preference-precedence tests); `xcodebuild` green in **both** Debug and
Release — the first build where the two configurations differ. Records:
`client/MANUAL-CHECKS.md` "Release hardening (2026-09-15) — security slice 2"
(14 rows, NOT RUN, including a 15-minute real session and an
entitlement-stripped re-sign), a "Release vs Debug behaviour" list in
`client/RELEASING.md`, and the env knobs marked Debug-only in
`client/README.md`. Ships in the next client release (**v1.3.2**) — the
watchdog fix does not reach the fleet until then.

**Medium items built (v1.3.3 candidate, release held) — 2026-09-15, client
only.** Three of the audit's Medium findings, built as one "client hygiene"
slice. James decided to HOLD the release: this is built and tested, not cut.

- **#17 `responses.sqlite` purge.** The spool keeps answer text in plaintext,
  and rows only ever left it two ways — deleted when the server takes one,
  cleared wholesale after a confirmed submit. An attempt that was abandoned,
  crashed out of, or ended by the clock therefore left the previous student's
  answers on a shared lab Mac for the next person who sat down. New:
  `ResponseSpool.purge(keeping:olderThan:now:)`, called from
  `applicationDidFinishLaunching` and from `showEntry()`, both with
  `keeping: nil` — at neither moment is an attempt on screen. **No schema
  migration was needed**: the table has carried `queued_at` since slice 67.
  The policy the spool supports, and the judgement call: because a row is
  deleted the instant it is sent, everything still spooled is UNSENT, which is
  the offline case finding 10.7 exists for — the spool is the only copy of that
  work. So the rule is not "delete other attempts" but "delete other attempts
  that are stale": rows of the attempt on screen are never touched, and any
  other attempt's rows go once they are past `ResponseSpool.staleAfter` (24 h).
  A student who lost Wi-Fi yesterday afternoon still hands in this morning; a
  row from last week is a leak with no owner left to claim it. One `[security]`
  line with the count.
- **#19 assessment web view on a non-persistent store.**
  `configuration.websiteDataStore = .nonPersistent()`, matching
  `WebViewAuthPresenter`. Nothing relied on persistence: the page is loaded
  from a string with `baseURL: nil` (a no-origin document WebKit denies
  localStorage and cookies outright), under `default-src 'none'` with
  `img-src data:`, so no cache entry or site data was carrying anything.
  Noted in a comment at the call site.
- **#18 `errors.log` capped.** Newest 500 lines / 512 KB, enforced on append
  against in-memory counters (so the ordinary line costs no read) and seeded
  from the file at init, so a file an earlier launch left oversize is trimmed
  on the first write rather than the five-hundredth. The oldest lines are what
  goes — the drain sends oldest-first, so anything still present at the cap has
  been undeliverable for a long time. **Not** cleared on hand-in: the drain
  already sends after sign-in and prunes only what the server accepted, and
  that path (`removeFirstLines`) is unchanged, now sharing one locked rewrite
  core with the cap.

**Fullscreen** and the hand-in end-state were left alone (decided).

`swift test` 635 (626 + five spool-purge tests and four cap tests);
`xcodebuild` green in **both** Debug and Release. Records:
`client/MANUAL-CHECKS.md` "Client hygiene (2026-09-15) — v1.3.3 candidate"
(6 rows, NOT RUN — they need two attempts and a `sqlite3` row-ageing step).
`MARKETING_VERSION` deliberately NOT bumped.

## Row CS — Close session ends every attempt (scoped 2026-09-15, BEFORE the pilot)

Pilot teachers' first feedback: closing a session (and the session running
out) must end the test for everyone still working; today only the
per-attempt time limit does (`docs/pilot-quick-start.md` "Three clocks").
`docs/close-session-ends-attempts-design.md` is the note — D-1…D-6 with
recommendations, mechanism (server hands in in-progress attempts through
the existing teacher hand-in path on Close and lazily on expiry; the
client learns through the 5 s peek poll and the write 409), three slices
(server → deploy Wednesday; client → v1.3.3 with the hygiene slice; docs).
Next fresh session starts here.

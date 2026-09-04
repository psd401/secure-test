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
| 1 | **Scoring hygiene** — BUILT 2026-09-03 (`eb2c969` / `df899b2` / `7d9a3e0`, rows 59–61 unrun): auto-score on submit, F-1 drawing viewer, student number + section on results and CSV | `docs/reporting-design.md` R0 | unblocks scoring and everything in 5 | design tool |
| 2 | **Package + sign the client** — slices 1 + 3 BUILT 2026-09-03 (`73fe09f`, psd-sign 0.4.0); slice 2 BLOCKED on a Developer ID profile (admin ask); with the AppKit half of branding (icon, accent, one name, About / version, build stamp), and fix the `psd-sign` skill; its real-session hand-run re-checks predictive text in the essay (finding 8.4) | `docs/client-release-plan.md` (+ `docs/client-ui-pass-design.md` slice C) | gates the pilot and the IT afternoon; the first package is what IT and students see | client + release |
| 2b | **Public repository**: sweep, squash, move development there; archive this repo; a private ops repo for what stays internal | `docs/public-release-plan.md` | the release's `gh release` needs a public home; runs beside 2 and must finish before 2's release slice | docs + infra config, ∥ with 2 |
| 3 | **Observability** = error tracking + feedback, one batch | `docs/observability-design.md` | shared SNS → email plumbing, events-table pattern, version stamp, one deploy; hear from classrooms you are not in | both sides |
| 4 | **Client UI pass**: page theme layer → accommodations rendering → entry screen, hand-in block, pips; order items as drag-and-drop (the Move up / down buttons stay as the keyboard path) | `docs/client-ui-pass-design.md` slices A, B, D | largest hand-run burden, better with error signal in place; the accommodations half is equity work and may move ahead if a sitting with accommodated students comes first | client |
| 5 | **Reporting R1–R2**: per-student view + integrity timeline, item analytics, gradebook CSVs (PowerTeacher Pro + Schoology), print-CSS report | `docs/reporting-design.md` | shape it with the first real sittings; E11 waits for the same teacher input | design tool, ∥ with 4 |
| 6 | **Reporting R3**: gradebook integration (PowerSchool official, Schoology covered too) | `docs/reporting-design.md` R3 | post-pilot; needs sample files + district-admin keys → the IT / admin ask list | design tool + infra |

Parallel lines as in the 2026-09-03 batch: design-tool batches (1, 5) can
run in a second terminal beside client batches (2, 4); batch 3 touches both
sides and should own the tree while it runs. One owner for
`packages/schema`, migrations, the Swift bundle model and the fixture.

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

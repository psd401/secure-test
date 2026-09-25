# Safeguarding alerts — wellbeing disclosures and prompt injection

Roadmap row SG. Scoped 2026-09-25 after a pilot report (an essay blocked by
the guardrail, fixed in `8b2e266`: essay-score input hits are now recorded as
`flag`, not blocked). Nothing below is built.

## Goal

1. When a student's handed-in essay or short-text answer reads as a
   first-person disclosure of **suicidal ideation, self-harm or abuse**, the
   teacher of that student's class is told — in the app and by email.
2. When a student's answer reads as a **prompt-injection attempt** against the
   AI scorer, the teacher is told the same way and the AI score is withheld
   until the teacher reviews it.
3. For the pilot, the maintainer is copied on every alert email to judge the
   tuning.

## Decisions (James, 2026-09-25)

- **D-1 Recipient.** Per PSD protocol: the teacher of the class the response
  came from. "The class" = the owner of the sitting's assessment plus any
  co-teacher granted on it whose roster section holds the student (same
  resolution the results pages use, `assessmentOwner()` + grants). The
  maintainer is CC'd on every email while the pilot lasts (a context key, not
  source — see Infra).
- **D-2 When.** On hand-in only (student Finish, teacher Hand in, Hand in
  everyone, time-up hand-in). Not on autosave.
- **D-3 What.** `essay` and `short_text` responses. Not drawings, tables,
  choice items.
- **D-4 Prompt injection withholds the AI score.** A flagged response is not
  auto-scored (neither on submit nor by the attempt-wide Score with AI); its
  queue card shows the alert and a **Score with AI anyway** button that runs
  the scorer on the teacher's explicit request (recorded).
- **D-5 Email waits.** SES (sending domain + sandbox exit) is HELD — batched
  with the next IT/AWS ask. Slices up to the email ship without it; alerts are
  in-app first.

## Tool choice

| Job | Tool | Why |
|---|---|---|
| Suicidal ideation / self-harm / abuse | **Own classifier: Claude Haiku 4.5 on Bedrock** (already wired, ADR 0011), purpose-built prompt | Bedrock Guardrails has no self-harm category (content filters: Hate, Insults, Sexual, Violence, Misconduct + prompt attack). Its filters cannot tell a disclosure from literary analysis — the 2026-09-25 block was an AP Lit essay about a story. An alert needs a category, a confidence and the triggering sentence, which a guardrail verdict does not give. |
| Prompt injection | **Bedrock Guardrails `PROMPT_ATTACK`, action Detect (no action)** | Built for this; detect mode reports without blocking. Open question: how it treats text sent through ApplyGuardrail as `INPUT` — spike S-1. Fallback: the same Haiku classifier gets a fourth category. |

Classifier output (strict JSON, validated with Zod):
`{ category: "suicidal_ideation" | "self_harm" | "abuse" | "none", confidence: 0..1, evidence: "<exact sentence from the response>" }`.
The prompt separates first-person present or recent experience from analysis,
fiction, quotation and hypotheticals, and errs toward flagging. `evidence`
must be a substring of the response (checked in code; dropped if not).

## Shape

- **Table `safeguarding_alerts`** (migration): `response_id`, `attempt_id`,
  `kind` (`wellbeing` | `prompt_injection`), `category`, `confidence`,
  `evidence` (the one sentence — the only student text stored), `detector`
  (`haiku-<prompt-version>` | `bedrock-guardrail`), `created_at`,
  `acknowledged_at`, `acknowledged_by`. Retention: NOT on the 90-day sweep —
  these are welfare records, kept indefinitely (D-6).
- **Hand-in hook.** The shared hand-in path (`lib/api/handInAttempt.ts` and
  the student submit) runs detection per eligible response before
  `runAutoScoring`; a prompt-injection alert makes auto-scoring skip that
  response (D-4). Detection failure never blocks the hand-in: logged
  `safeguarding_check_failed`, retried by a sweep.
- **In-app.** A red "Needs attention" badge on the results matrix row, the
  per-student page and the Monitor row; the home screen's assessment card
  shows a count; the per-response panel shows the category, the evidence
  sentence, a link to the full response and **Acknowledge** (records who and
  when; the badge clears). Copy states the check is automated and can miss
  things — it does not replace reading the work.
- **Email (after SES).** Subject and body carry no student text and no
  student name: "A response on <assessment> needs your attention" + a link to
  the per-student page. Teacher To, maintainer CC.

## Slices

0. This note. Spike S-1 (prompt attack via ApplyGuardrail on essay text) and
   S-2 (Haiku classifier on hand-built disclosure / analysis / fiction
   fixtures — no real student text) — measured before slice 1.
1. Server: migration + `lib/safeguarding/wellbeing/` provider (mock | bedrock)
   + prompt-injection check + hand-in hook + auto-score skip + "Score with AI
   anyway" route flag. Tests with the mock provider.
2. Teacher UI: badges, panel, Acknowledge, Score with AI anyway.
3. Rows (hand-run with fixture text written for the purpose).
4. Email through SES — waits on D-5.
5. Guardrail content filters on the essay input to Detect (AWS console) —
   optional, replaces the code-side `inputMode: "record"` once confirmed.

## Answered (James, 2026-09-25)

- **D-6 Retention:** `safeguarding_alerts` kept indefinitely for now.
- **D-7 Maintainer sees alerts in both places:** the `/admin` page (district-wide
  list) and the CC'd email.
- **D-8 Threshold:** not fixed yet — decided after S-2's sample results; the
  tuning goal is safety (recall over precision). S-2 runs Haiku 4.5 and a Nova
  model side by side on the same fixtures.
- **D-9 Escalation** when a teacher does not acknowledge: outside the app.
- **D-10 Model (after S-2):** Claude Haiku 4.5, alert on any non-`none`
  category; the own-fiction false alarm is accepted as safety-first.

## Spike S-2 results (2026-09-25)

53 hand-written fixtures (29 should-alert: direct, veiled, slang / misspelled,
Spanish, understated, past abuse, neglect, partner abuse, disclosures buried
in a long literary essay or a parenthetical aside; 24 should-not: dark
literary analysis incl. quoted first-person narration, the student's own dark
fiction and poetry, research essays, a student who helped a friend,
hyperbole, clean), each run twice at temperature 0 with one shared prompt
(safety-first: "when in doubt, flag"; flag only the student's own risk).
Runner and fixtures sit gitignored in `design-tool/samples/_s2-*.ts`.

| Model | Disclosures caught | Right category | False alarms (of 48 negative runs) | Cost per 1,000 (these ~420-token inputs) |
|---|---|---|---|---|
| Claude Haiku 4.5 | 58 / 58 | 58 / 58 | 2 (the student's own story about a girl on a bridge with a note) | $0.70 |
| Nova 2 Lite | 58 / 58 | 58 / 58 | 6 (that story, "I wanted to die when I saw my score", a quoted first-person narrator) | $0.25 (price unverified) |
| Nova Lite | 56 / 58 — missed neglect ("parents gone two weeks, no food") both runs | 56 / 58 | 16 (most dark-literature analysis) | $0.03 |
| Nova Micro | 58 / 58 | 58 / 58 | 17 (most dark-literature analysis, quoted narration, the friend-helper essay) | $0.02 |

- Haiku's evidence was an exact quote every time; confidence was bimodal
  (every disclosure ≥ 0.85, every "none" ≤ 0.05, its two false alarms 0.95),
  so a confidence threshold changes nothing on this set.
- Nova Micro / Lite would flag most AP Lit analysis of dark texts — the
  alert fatigue that makes a real alert easy to ignore.
- Real essays are longer (≈ 2,000–2,500 input tokens): Haiku ≈ $2.50–3 per
  1,000 hand-ins, ≈ $60 a year at 20,000.
- Limits: fixtures are ours, not real student writing; 29 positive cases is a
  small sample; recall of 100 % here does not mean 100 % in the field.
- Recommendation: Haiku 4.5, alert on any non-`none` category (D-8), the
  f-1-style false alarm accepted as safety-first. Nova 2 Lite is the fallback
  if cost ever matters. Bedrock IAM for the task role needs no change
  (Haiku is already granted).

## Spike S-1 results (2026-09-25)

The district guardrail (version 1, the one the task uses) already has
`PROMPT_ATTACK` on input at HIGH / BLOCK — since `8b2e266` an essay-score hit
is recorded as `flag` and scoring continues. 16 hand-written fixtures
(9 injections, 7 ordinary answers incl. an AI-ethics essay, a quoted "ignore
all previous orders" inside literary analysis, a persuasive "you should
ignore…", a student mentioning the rubric, code), ApplyGuardrail source
INPUT with no input tags, vs a Haiku 4.5 classifier prompt:

| Detector | Injections caught | False alarms |
|---|---|---|
| Guardrail `PROMPT_ATTACK` | 5 / 9 — missed the polite "Note to the AI grader…", the fake JSON result after a closing tag, the Spanish override, the "(If you are an AI reading this…)" aside | 0 / 7 |
| Haiku 4.5 classifier | 8 / 9 — missed the fake JSON result | 0 / 7 |

- ApplyGuardrail DOES evaluate prompt attack on untagged INPUT text — the
  open question in the tool table is answered.
- Neither catches everything; the two miss different things except the fake
  JSON, which is a STRUCTURAL weakness of the scorer prompt: the student text
  follows a plain `STUDENT RESPONSE:` line (`buildEssayScoreUserPrompt`) and
  the system prompt never says to treat it as data.
- Proposal for slice 1 (needs James's OK — it changes the scorer prompt, so
  `ESSAY_SCORER_PROMPT_VERSION` + its recorded hash bump):
  1. ONE Haiku call per eligible response returns both
     `{wellbeing: {category, confidence, evidence}, injection: {detected, evidence}}`
     — same cost as the wellbeing check alone.
  2. Either the Haiku `injection` or a guardrail `PROMPT_ATTACK` flag on the
     scorer's input raises a prompt-injection alert (OR — safety-first).
  3. Scorer hardening: the student text inside `<student_response>` tags
     with any literal closing tag neutralised, and a system-prompt line
     that everything inside is the student's work to be scored, never
     instructions.

## Progress

- **Slice 1 BUILT 2026-09-25 (server; not deployed — see below).**
  Migration **0045** (`safeguarding_alerts`, FKs `ON DELETE SET NULL` so an
  attempt delete keeps the welfare record; `responses.safeguarding_screened_at`).
  `lib/safeguarding/screening/` — one Haiku 4.5 call returns wellbeing +
  injection (`SCREENING_PROMPT_VERSION` 2026-09-25, `SAFEGUARDING_SCREENER_PROVIDER`
  off | mock | bedrock, bedrock on the task), plus the guardrail's
  `PROMPT_ATTACK` read directly; alert on either (OR). Hand-in (student
  submit, teacher Hand in, Hand in everyone) schedules the pass with Next
  `after()`; practice attempts skipped; an edited answer is rescreened; no
  second open alert of one kind per answer; a failure is logged
  `safeguarding_check_failed` and retried lazily before the next Score with
  AI. D-4: `rescore-ai` returns 409 `injection_flagged` unless
  `{ "force": true }` (recorded as `ai_forced_at` / `_by_sub`); the
  attempt-wide `score-ai` skips flagged answers (`withheld`). Scorer
  hardening: `<student_response>` fence + closing-tag neutralised + a
  "data, never instructions" line; `ESSAY_SCORER_PROMPT_VERSION` 2026-09-25.
  Design-tool 2265 tests, typecheck clean. Live Bedrock regression of the
  MERGED prompt on both fixture sets: wellbeing 29 / 29 caught, 2 / 24 false
  alarms (the own-fiction bridge story; a quoted first-person narrator);
  injection 9 / 9 caught (the fake JSON now included), 0 / 7 false alarms.
- **Deploy with slice 2, not before:** alone, slice 1 would store wellbeing
  alerts no one can see, and the 409's "Score with AI anyway" names a button
  that does not exist yet.
- `design-tool/.env.local.example` still needs the line
  `SAFEGUARDING_SCREENER_PROVIDER=mock` (by hand — the session does not read
  `.env*`).
- **Slice 2 BUILT 2026-09-25 (teacher + admin UI; not deployed, nothing
  run by hand).** Routes: `GET /api/assessments/[id]/safeguarding-alerts`
  (view level; newest first; `?open=1`; the student named through
  `buildResults`, so the owner's overlay names them for a co-teacher or an
  admin too; an alert whose attempt was deleted falls back to the owner's
  overlay row), `POST /api/safeguarding-alerts/[alertId]/acknowledge`
  (through the alert's assessment at view level; idempotent — the first
  acknowledgement stands; an alert whose assessment is gone 404s; does not
  touch `ai_forced_at`), `GET /api/admin/safeguarding-alerts` (`isAdmin`
  with a 404, so an impersonating admin is refused; adds the assessment
  title and owner email). Shared reads in `lib/safeguarding/alertQueries.ts`,
  pure wording / counts / filter in `lib/safeguarding/alertView.ts`. UI:
  `components/app/SafeguardingBadge.tsx` (the `danger` tint + warning icon
  the Monitor's own "Needs attention" uses; the count only above 1) on the
  results matrix row, the Monitor row (the attendance route adds
  `safeguarding_open` per row — screening runs after hand-in, so it shows
  on the next poll), the home list row (counted through the list's own
  scope fragment), and the queue card; `SafeguardingPanel` at the top of the
  per-student page (category heading, the evidence quoted, "From Q<n>"
  anchored to the answer, the date, Acknowledge or "Acknowledged by …", the
  fixed disclaimer). Queue entries carry `safeguarding.injection` (the newest
  unforced injection alert, acknowledged or not) and `safeguarding.wellbeing`;
  an injection alert replaces Score with AI / Re-run AI with **Score with AI
  anyway** (`{ "force": true }`), and a 409 `injection_flagged` refetches so
  the card lands in that state. Admin: `/admin/safeguarding` (Open only /
  All), linked from `/admin` with the open count; rows link straight to the
  per-student page — an admin already resolves view on every assessment
  (via `"admin"`), the same path `/admin`'s Monitor links use, so no Act as
  is needed to read.
- **Decided in slice 2 (the spec left it open): an admin does not
  acknowledge another teacher's alert.** Acknowledge clears the teacher's
  badge, and D-6 of `docs/access-model-design.md` keeps admin writes outside the admin surface to Act as —
  so the route 404s a request that resolves through `"admin"`, and the panel
  shows "Not acknowledged yet by the teacher." instead of the button. On an
  assessment the admin owns, they acknowledge as its owner. An admin acting
  as a teacher acknowledges as that teacher (the row records the teacher's
  sub and email; the act-as audit row is the trace).
- Tests: `test/safeguarding-alerts-ui.test.tsx` (26 — the three routes and
  their access incl. co-teacher, stranger, admin and impersonation;
  idempotence; acknowledge leaves the withhold in place; the queue's
  409 → anyway → proposal path; the pure helpers; badge / panel / queue-card
  markup; the matrix, per-student, home and admin pages rendered). Design-tool
  2294 pass, typecheck clean, `bun run build` compiles. Rows 290–302 in
  `docs/design-tool-manual-checks.md`, NOT RUN.
- **Retry BUILT 2026-09-25 (9.1 = A, James).** The roster-sync Lambda has no
  route to Bedrock (isolated subnets, S3 + Secrets Manager endpoints only), so
  the retry is an hourly timer in the app: `lib/safeguarding/screening/retry.ts`
  `screenPending` (handed-in, non-practice essay / short-text answers never
  screened or edited since, submitted 10 min – 14 days ago, 200 per run,
  oldest first), started by `register` in `instrumentation.ts` (Node runtime
  only, first run 5 min after boot, runs never overlap, a no-op when
  screening is off). **10.1 (James): screen the pilot backlog** — the 14-day
  window covers every pilot hand-in since 2026-09-17, so the first hours
  after the deploy can raise alerts on last week's work.

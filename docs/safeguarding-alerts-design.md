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

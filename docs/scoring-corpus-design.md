# Essay scoring corpus — re-running scored essays against other models

Design note, 2026-09-14. James, after the pilot teachers' export request:
"once we have all of the essays in the database, we will want to run them
against multiple different AI scoring and feedback mechanisms over time for
our own testing purposes — do we have the tooling for that?" We do not. The
data is durable; the harness to re-score it, tell runs apart, and compare
them to the teacher's mark is missing. Design tool only; nothing in the
client or the shared schema moves. Decisions marked **D-n** are James's
(2026-09-14) and are listed at the end; **§Progress says what is built**
(nothing yet).

## What exists that this stands on

- **Essays are durable rows.** Every answer is a `responses` row (`response`
  jsonb, `{type: "essay", text}`); every score is a `scores` row with
  `method IN ('auto','ai','human')`, `status IN ('proposed','final')`,
  `points` / `max_points`, `rationale` jsonb, `scorer`, `created_at`, and a
  partial unique index that allows **one final per response**. A teacher's
  final and any number of AI proposals sit side by side today.
- **The AI scorer is a provider interface** (`lib/ai/essayScorer/`):
  `getEssayScorerProvider()` picks `mock` or `bedrock` from
  `ESSAY_SCORER_PROVIDER`; the Bedrock provider's model is
  `BEDROCK_ESSAY_SCORE_MODEL` (default `us.anthropic.claude-sonnet-4-6`) and
  its `id` is `bedrock-<model>`, which is what `scores.scorer` records.
  `lib/scoring/aiScoreResponse.ts` is the score-one-response core; it runs
  the guardrail (`runGuarded`, surface `essay-score`) and emits the
  `ai_usage` log line (D-7 of `docs/rubric-upload-design.md`). A
  direct-Anthropic provider was deliberately not added (ADR 0014, the AWS
  bubble).
- **Two callers, both teacher-facing and both wrong for research:**
  `POST /api/attempts/[attemptId]/score-ai` skips any response that
  already has a score row; `POST /api/responses/[responseId]/rescore-ai`
  adds a proposal but **409s `final_exists`** — precisely the human-labelled
  population a study needs.
- **What a score row does not carry:** which prompt produced it (the
  provider has no version constant), the rubric text it was scored against
  (`items.config.rubric` is edited in place), or any run identity. Two
  runs a month apart with a changed prompt are indistinguishable.
- **Every reader of `scores` assumes two statuses.** The list, so slice 1
  knows where to look: `lib/scoring/results.ts`,
  `lib/scoring/runAutoScoring.ts`, `lib/api/reviewActions.ts`,
  `app/api/assessments/[id]/review-queue/route.ts`,
  `app/api/attempts/[attemptId]/score-ai/route.ts`,
  `app/api/scores/[scoreId]/approve/route.ts`,
  `app/api/responses/[responseId]/score/route.ts`,
  `app/dashboard/[id]/results/[attemptId]/page.tsx`,
  `app/dashboard/[id]/results/print/page.tsx`,
  `app/dashboard/[id]/results/analyticsQuery.ts`, plus the student-work
  packet (`docs/student-work-export-design.md`) once it exists.
- **Attempt delete cascades** (`DELETE /api/attempts/[attemptId]`,
  `docs/reporting-design.md`) through responses to scores. Teachers delete
  attempts to re-sit a student; the essay and every score on it go with it
  (D-4 accepts this).
- **Aurora is reachable only in-VPC**; one-off work runs as an ECS task on
  the service's own image (`infra/scripts/migrate-aurora.sh` is the
  pattern). Local dev and the test DB are reachable directly.

## Design

### Runs and research rows (D-3)

**Migration 0035:**

- `scoring_runs` — `id`, `label text` (unique), `provider_id text` (the
  provider's `id`, e.g. `bedrock-us.anthropic.claude-sonnet-4-6`),
  `prompt_version text`, `filter jsonb` (the selection the run was made
  with, for the record), `created_by text` (the operator's sub or
  `cli:<user>`), `created_at`, `notes text`.
- `scores` gains `run_id uuid null references scoring_runs(id) on delete
  cascade`, `prompt_version text null`, and `rubric_snapshot jsonb null`.
  The status CHECK becomes `('proposed','final','research')`. The
  one-final-per-response index is untouched — a research row is never
  final.
- Live AI scoring starts stamping `prompt_version` on its own rows too (no
  run, no snapshot) so the day-to-day proposals become comparable to a
  later run without a join on dates.

**Research rows are invisible to teachers.** Every reader listed above adds
`status <> 'research'` (or selects the statuses it wants by name). The
score-ai route's "already has a score row" skip and rescore-ai's
`final_exists` check both ignore research rows. The review queue, the
matrix, the per-student page, the print report, the analytics footer, the
CSV, and the student-work packet never show one. A test per reader locks
that in — the fixture seeds one research row beside a proposal and a final
and asserts each surface's output is unchanged.

### Prompt version

`lib/ai/essayScorer/scoreCore.ts` exports `ESSAY_SCORER_PROMPT_VERSION`
(a date string, `2026-09-14`), bumped by hand whenever the prompt text or
the scoring view changes; the provider interface gains
`promptVersion: string`. A test asserts the constant changes when the
prompt template's hash changes (the same drift-check idea as the KaTeX
macros test), so a prompt edit that forgets the bump fails the suite.

### The runner

`design-tool/scripts/score-corpus.ts` — an operator script, not a route:

```
bun --env-file=.env.local scripts/score-corpus.ts \
  --label "sonnet-4-6 prompt 2026-09-14 vs pilot finals" \
  [--assessment <id>] [--item <id>] [--owner <sub>] \
  [--with-human-final] [--since <date>] [--limit N] \
  [--provider bedrock|mock] [--model <bedrock model id>] \
  [--dry-run]
```

- Selects essay responses on `ai` / `hybrid` / `human` items matching the
  filters (`--with-human-final` is the usual one: only essays a teacher
  has settled), prints the count and stops on `--dry-run`.
- Inserts the `scoring_runs` row, then for each response calls the
  provider directly through `aiScoreResponse`'s core — the guardrail still
  runs (`ownerSub` = the assessment owner, so the `ai_usage` line
  attributes spend as today), the model and prompt are the run's — and
  writes a `research` row with `run_id`, `prompt_version`, and the item's
  rubric as `rubric_snapshot`. Bounds failures and provider errors are
  counted, not thrown; the run's `notes` carries the tally.
- Sequential with a small concurrency flag; Bedrock throttling is the
  limit, not the DB.
- Idempotent per run: re-running with the same label refuses; a response
  already scored in that run is skipped.

`design-tool/scripts/compare-runs.ts` — reads one or more runs and prints
(or writes CSV) per run: n, exact agreement with the human final, mean
absolute points difference, per-criterion agreement where both sides carry
`criterion_scores`, and the hybrid auto-finalize rate the run would have
produced at `HYBRID_AUTO_FINALIZE_CONFIDENCE`. Two runs side by side is the
model-vs-model question; one run vs the finals is the "is this prompt good
enough" question. Pure helpers in `lib/reporting/runComparison.ts` with
tests; the script is the thin CLI.

**Where it runs:** local dev and the test DB directly. Against Aurora the
runner goes the migrate-aurora way — a one-off ECS task on the service
image with the script as the command — as its own later slice, once a run
on the local roster-shaped data has proven the shape. Until then a corpus
question on production data is a copy of the relevant rows into the dev
DB (an export script is out of scope here; the dump is operator work).

### What this deliberately does not do

- No new provider. A second Bedrock model is `--model`; anything outside
  the AWS bubble is an ADR 0014 conversation first.
- No teacher UI. Research rows are an operator's data set; the queue
  never offers them and nothing promotes a research row to a proposal.
- No corpus survival past attempt delete (D-4). If that changes, the fix
  is a copy-on-delete into a detached corpus table, not a cascade change.
- No student identity in the comparison output — run summaries carry
  response ids and item ids only.

## Slices

Every slice is one commit, diff reviewed and the suite re-run in the main
session before the commit. Slice 1 carries **migration 0035**; deploy first,
then `migrate-aurora.sh`, as always.

| # | Slice | Agent |
|---|---|---|
| 0 | This note | — |
| 1 | Migration 0035 (`scoring_runs`, the three `scores` columns, the `research` status), the reader sweep with a test per reader, prompt-version constant + drift test + stamping on live rows | **Opus 5 / medium** — eleven readers to audit; the cost of missing one is a research row on a teacher's screen |
| 2 | `scripts/score-corpus.ts` + `lib/reporting/runComparison.ts` + `scripts/compare-runs.ts`, tests on the pure parts, a mock-provider end-to-end test on the test DB | **Opus 5 / medium** — the selection and idempotency rules are where a runner goes wrong |
| 3 | `docs/` operator recipe (in this note's §Progress + `design-tool/README`), the first real run on local dev against the mock provider and one Bedrock run on a handful of pilot essays, its numbers recorded here | **Sonnet 5 / low** |
| 4 | The in-VPC one-off task for Aurora runs (the migrate-aurora pattern) | Sonnet 5 / medium, after slice 3 shows the shape holds |

Order: slice 1 before the student-work packet's slice 1, so the packet
excludes `research` from the start.

## Decisions

- **D-3 a third `scores.status` value, `research`** (James, 2026-09-14),
  rather than a separate table — the rows keep the same shape as the
  proposals they are compared to, and one column excludes them everywhere.
- **D-4 loss on attempt delete is acceptable** (James, 2026-09-14) — no
  copy-on-delete.
- Prompt version as a hand-bumped constant with a drift test, and the
  rubric snapshotted per research row — recommendations in this note, not
  yet decided.

## Progress

- 2026-09-14 — note written; nothing built.
- 2026-09-14 — **slice 1 BUILT** (not yet deployed). **Migration 0035**
  (`0035_wise_the_phantom.sql`, applied to dev + test; Aurora needs
  `migrate-aurora.sh` after the next deploy): `scoring_runs`, `scores` gains
  `run_id` (cascade + index), `prompt_version` and `rubric_snapshot`, and the
  status CHECK becomes `('proposed','final','research')` (Drizzle emits it as
  drop + add). `ESSAY_SCORER_PROMPT_VERSION = "2026-09-14"` lives in
  `lib/ai/essayScorer/scoreCore.ts`, both providers report it as
  `promptVersion`, and `aiScoreResponse` stamps it on every live AI row
  (proposals included) — `test/essay-prompt-version.test.ts` hashes the system
  prompt plus the assembled user prompt (through `scoringView`, so the
  single-point ladder is pinned) and fails with the exact bump instructions if
  either changes. **Reader sweep:** `ne(scores.status,'research')` added where
  a reader selects score rows without naming statuses — `lib/scoring/results.ts`
  (so the matrix, the totals and the CSV), the review-queue route, the
  per-student results page, `lib/api/reviewActions.ts` (so manual score,
  approve and re-run AI), and the attempt-wide `score-ai` route, whose
  "already has a score row" skip would otherwise treat a corpus row as the
  teacher's work. `approve` now 404s a research score id. Needing no change,
  and commented as audited rather than altered: `runAutoScoring`
  (`status = 'final'`), the print page (`status = 'final'`),
  `analyticsQuery` (left join on `status = 'final'`),
  `rescore-ai` + the manual `score` route (both ride `reviewActions.hasFinal`).
  Tests: a new `test/scoring-corpus-schema.test.ts` (research accepted, no
  collision with the one-final index, run cascade, D-4 attempt-delete), plus
  research rows seeded beside a proposal and a final in `results.test.ts`,
  `scoring-auto.test.ts`, `review-queue.test.ts`, `reporting-print.test.tsx`
  and `reporting-views.test.tsx` — the rendered matrix, per-student page and
  print report are asserted **byte-identical** before and after the rows land.
  `bun test` 1608 pass / 0 fail across 99 files; `bun run typecheck` clean.

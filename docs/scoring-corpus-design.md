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
image with the script as the command (**slice 4, built**: both scripts are
bundled into the image, the entrypoint gains `corpus` and `compare` beside
`migrate`, and `infra/scripts/oneoff-aurora.sh <mode> [args…]` is the
generalized run-task with `migrate-aurora.sh` as a thin wrapper —
`infra/README.md` "Corpus runs on Aurora"). The task role's Bedrock access
and the service's guardrail are what such a run uses, so a corpus question
on production data needs no new IAM and no longer needs a copy of the rows
into the dev DB.

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
- 2026-09-14 — **slice 2 BUILT** (no migration, no deploy: two operator
  scripts and two libs). `lib/scoring/corpus.ts` is the runner's logic —
  `parseCorpusArgs` (unknown flags rejected, `--flag value` and `--flag=value`,
  provider default `ESSAY_SCORER_PROVIDER` then `mock`, `--model` bedrock-only,
  `--concurrency` 1-4), `selectCorpusResponses` (submitted attempts × essay
  items in SQL, then `effectiveScoringMethod ∈ ai|hybrid|human`, the
  `--with-human-final` test and the already-scored-in-this-run exclusion in JS,
  `--limit` applied LAST so it means "score at most N of the matching essays"),
  `createRun` (`DuplicateRunLabelError` on a used label, select + the unique
  index), `scoreForCorpus` (a `research` row with `run_id`,
  `prompt_version = provider.promptVersion`, `rubric_snapshot` = the rubric as
  authored, `scorer = provider.id`), `summarizeOutcomes`. **The provider runs
  through the live path**: `aiScoreResponse` was split into `runEssayScorer`
  (guardrail surface `essay-score`, `ownerSub` = the assessment owner so
  `ai_usage` attributes spend as today, `scoringView` + bounds) plus the
  persistence it always had — its behaviour is unchanged (a bounds failure is
  still `provider_error` to that caller; the insert is still inside a catch),
  and the corpus caller gets `bounds` as its own outcome plus
  `allowedMethods`/`provider` overrides. `scripts/score-corpus.ts` is the CLI:
  `--dry-run` prints the count and up to five response/item ids and creates
  nothing; otherwise run row → worker pool at `--concurrency` → progress every
  10 → the tally into `scoring_runs.notes`; exit 1 when nothing matched or the
  label is taken, 2 on a bad flag; `created_by = cli:<username>`; response,
  item and attempt ids only. `lib/reporting/runComparison.ts` +
  `scripts/compare-runs.ts` (`--run` repeatable / `--all`, `--csv`) report per
  run: n, with_human_final, exact points agreement, mean |Δ points|, mean
  |Δ|/max, per-criterion level agreement over the pairs where BOTH sides carry
  `rationale.criterion_scores` (the AI writes
  `{criterion_id, level_id, points, rationale}` and the human route writes the
  same array from `ManualScoreBody`, both validated against the scoring view,
  so the level ids are directly comparable; the human side may omit it for a
  holistic override), and the hybrid auto-finalize rate the run would have
  produced at `HYBRID_AUTO_FINALIZE_CONFIDENCE` from `rationale.confidence`.
  Every rate is null rather than NaN on an empty population. Tests:
  `test/corpus-args.test.ts` (21), `test/run-comparison.test.ts` (10),
  `test/scoring-corpus-runner.test.ts` (9, mock provider on the test DB —
  research-row provenance, the human-method-with-a-final population the live
  routes refuse, unscorable without a rubric, per-run idempotency, duplicate
  label, `--with-human-final`, and `buildResults` + its CSV byte-identical
  before and after a run). Slice 3 is the operator recipe and the first real
  runs.
- 2026-09-14 — **slice 3, mock half RUN on local dev.** `score-corpus.ts
  --label "mock smoke 2026-09-14" --provider mock` (no filter) matched the
  dev DB's two essays (one item, method `human`, no rubric): run row
  created, both responses `unscorable`, tally written to `notes`;
  `compare-runs.ts --all` and `--csv` print the run with every rate `—` /
  blank on the empty population. `--with-human-final --dry-run` reported 0
  (no teacher final exists locally) and exited 1. The scored path is
  covered by `test/scoring-corpus-runner.test.ts` (mock provider, research
  row fields, idempotency, `buildResults` unchanged). **Bedrock half
  OPEN:** needs pilot essays with teacher finals in a reachable DB —
  either slice 4's in-VPC task or a copy of the rows into dev. Reading: an
  `unscorable` line did not say why — **BUILT the same evening**: the
  outcome carries `reason: no_rubric | empty_response | not_essay_method`
  and the CLI prints it (`unscorable (no_rubric)` on the dev re-run).
- 2026-09-14 — **slice 4 BUILT** (no migration; no design-tool code changed —
  this is the image, the entrypoint and the infra script).
  **Bundling:** the Dockerfile's builder stage now also runs
  `bun build scripts/score-corpus.ts` and `scripts/compare-runs.ts`
  (`--target=node --format=esm`) beside the existing `db/migrate.ts` build,
  and the runner stage copies the two `.mjs` next to `db/migrate.mjs` —
  1.46 MB and 405 KB. `bun build` inlines `@aws-sdk/client-bedrock-runtime`
  along with drizzle/postgres, so the only imports left in either output are
  node builtins (plus `node:module`'s `createRequire`, which the AWS SDK uses
  for its own lazy `node:fs`/`node:http` reads); nothing needs an
  `@napi-rs`-style copy rule. Both names are gitignored beside
  `db/migrate.mjs`. **Entrypoint:** a `MODES` map (`migrate` →
  `db/migrate.mjs`, `corpus` → `score-corpus.mjs`, `compare` →
  `compare-runs.mjs`), an unknown mode still exits 64, and the mode is
  removed from `process.argv` with `splice(2, 1)` before the import — so each
  script's own `process.argv.slice(2)` sees exactly the pass-through
  arguments and **neither script changed**. The DB_* → DATABASE_URL shim runs
  for every mode as before. **Infra:** `infra/scripts/oneoff-aurora.sh <mode>
  [args…]` carries the discovery + run-task the migrate script used to;
  `migrate-aurora.sh` is now `exec oneoff-aurora.sh migrate "$@"`, so the
  deploy recipe and the README command are unchanged. The container-command
  JSON is built with `jq -nc … --args -- "$@"` (the `--` is load-bearing:
  without it jq reads `--label` as its own option and dies) with a
  hand-rolled JSON-string escaper as the no-jq fallback — both paths produce
  byte-identical JSON for a label containing spaces, quotes and backslashes.
  `aws ecs wait tasks-stopped` caps at 100 × 6 s = 10 min, too short for a
  Bedrock run, so the wait is our own `describe-tasks` poll (every 10 s, a
  dot per poll) with a `TIMEOUT_MINUTES` ceiling, default 30; hitting it
  exits 3 and says the task is still running, because it is. The script exits
  with the **container's own** code, so the runner's 1 (nothing matched /
  label taken) and 2 (bad flag) survive to the terminal.
  **Container proof** (colima; image built from the repo root;
  `host.docker.internal` reaches local Postgres with no change to the runner
  stage):
  `corpus --label proof --dry-run` against the test DB → `0 essay response(s)
  match the filter` / `nothing matched — check the filters (no run was
  created)`, exit 1; `bogus` → `docker-entrypoint: unknown mode "bogus" — no
  argument boots the server; modes: migrate, corpus, compare.`, exit 64;
  `corpus --nope` → the parser's unknown-flag line + usage, exit 2;
  `corpus --label "sonnet-4-6 prompt 2026-09-14 vs pilot finals"
  --with-human-final --dry-run` → the same 0-match lines, exit 1 (the
  multi-word label reached the parser intact); `migrate` against a scratch DB
  → `migrations applied — 36 in drizzle.__drizzle_migrations (journal has
  36)`, exit 0 (the wrapper refactor did not disturb the migrate path);
  `compare --all` with one seeded run row → the readable table with every
  rate `—`, exit 0, and `compare --all --csv` → the header plus one row, exit
  0. (`compare --all` against a DB with **no** runs exits 1 with `no runs in
  this database` — slice 2's behaviour, unchanged; the empty-table proof
  needed a run row.) The scratch DB was dropped afterwards.
  **Test:** `test/docker-entrypoint.test.ts` (7) copies the entrypoint into a
  temp directory beside stub targets and runs it with plain node — every path
  it imports is relative to its own location, so the temp copy is a faithful
  stand-in for the image: each mode reaches its own file, no argument boots
  `server.js`, a mode's arguments are never read as modes, the multi-word
  label survives the splice, the DB_* shim's assembled URL is asserted
  character for character (percent-encoding included), and both exit-64
  paths. `bun run typecheck` clean.
  **Not done here:** no `cdk deploy` and no Aurora run — the two scripts
  reach the image only with the next deploy, and slice 3's Bedrock half is
  still the first real run (it can now be that run, against production
  essays, instead of a dump into dev).
- 2026-09-14 — **slice 4 PROVEN on Aurora (rev 29):** `oneoff-aurora.sh
  corpus --label … --with-human-final --dry-run` ran in-VPC and reported 0
  (exit 1 by design); without the filter the origin holds 6 essay responses
  (all `human` method, none with a teacher final) — the corpus is empty until
  a pilot teacher scores essays. Nothing was created. The Bedrock run is one
  command when finals exist (README "Corpus runs on Aurora").

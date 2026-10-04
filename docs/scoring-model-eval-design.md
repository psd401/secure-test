# Essay scoring quality by model — a broad evaluation before any switch

Design note, 2026-10-03. James, after the AWS cost work (the essay-scoring
grid by model, `CLAUDE.md` 2026-10-03 cost bullet): "what would a broad test
of scoring quality by model look like? This test would exclude any Opus or
Fable models", then: "while agreement with teacher scores is the goal, we
want to err on the side of the AI scoring a little lower than teachers when a
mistake is made." Design tool and infra only; nothing in the client or the
shared schema moves. Decisions marked **D-n** are James's (all made
2026-10-03, listed at the end); **§Progress says what is built** (nothing
yet).

## Why now

- **Cost.** Sonnet 4.6 scores an essay for 1.38¢ (measured: 68 calls over
  30 days, 1,801 tokens in / 475 out, `infra/scripts/ai-usage.sh`).
  Sonnet 5.5 is about 1.10¢, Haiku 4.5 about 0.46¢, the Nova and open-weight
  models a fraction of a cent. At the high-school worst case (16,000 essays a
  month) the spread is roughly $220 vs $176 vs $73.
- **Quality is unmeasured.** Nothing tells us whether a cheaper model scores
  as well, or whether today's model scores well. A switch made on price alone
  would be a guess about student grades.

## What exists that this stands on

- **The corpus harness** (`docs/scoring-corpus-design.md`, built 2026-09-14):
  `scripts/score-corpus.ts` re-scores handed-in essays with any Bedrock model
  (`--model`, `--label`, `--with-human-final`, `--limit`, `--dry-run`) and
  writes `research` score rows that no teacher-facing reader sees, each
  carrying `run_id`, `prompt_version` and the rubric it was scored against.
  `oneoff-aurora.sh corpus …` runs it in-VPC against Aurora.
- **The comparison** (`lib/reporting/runComparison.ts` +
  `scripts/compare-runs.ts`): per run, exact agreement with the teacher's
  final, mean |AI − teacher| points, the same as a fraction of max points,
  and per-criterion level agreement where both sides carry
  `criterion_scores`. CSV output with `--csv`.
- **The scorer** runs at temperature 0, with a pinned prompt version and a
  prompt-hash drift test (`ESSAY_SCORER_PROMPT_VERSION`), through the Bedrock
  Converse API — which Nova, Mistral, Llama and DeepSeek also accept, so no
  per-vendor client is needed.
- **Hybrid auto-finalize.** On a `hybrid` item an AI score at confidence ≥
  `HYBRID_AUTO_FINALIZE_CONFIDENCE` (0.85) becomes the final with no teacher
  review. A confident wrong score there reaches the gradebook unseen, so this
  path matters most for the error preference below.

## The supply of teacher scores (measured 2026-10-03)

Read-only count on Aurora (`query-aurora.sh`, counts only): handed-in,
non-practice essay answers and how their final score was decided.

| Final score | Essays | Teachers | Assessments |
|---|---|---|---|
| None yet | 328 | 6 | 10 |
| Teacher scored (`method = human`) | **8** | 2 | 2 |
| AI score approved as-is by a teacher | 19 | 2 | 3 |
| AI auto-finalized (hybrid, no review) | 1 | 1 | 1 |
| (maintainer-owned and hand-run fixtures, excluded) | 6 | 1 | 5 |

No final in the table was a changed AI score (a teacher correcting an AI
score keeps `method = ai` and leaves a `superseded` row; none exist).

What this means:

- **Ground truth is the bottleneck, not essays or money.** Eight
  independently teacher-scored essays cannot rank models.
- **An approved-as-is AI score is not ground truth.** The teacher saw the AI
  score first; agreement with it measures anchoring. Those 19 are reported
  separately, never pooled with independent scores.
- **The 328 unscored essays are the pool.** Blind teacher scores on a sample
  of them (slice 3) are what make the evaluation possible. Caveat: essays on
  `ai` / `hybrid` items may already carry an AI proposal the review queue
  shows, which would anchor the teacher the same way; slice 3 first counts
  how many of the 328 have one, and blind scoring uses only essays without a
  visible proposal (or hides it for the study).

## Design

### The error preference (D-2)

Agreement with the teacher is the goal. When the AI is wrong, a score **a
little lower** than the teacher's is preferred to one higher. Reasons:

- A too-high score is the harder mistake to catch and to undo: students and
  families anchor on it, and lowering a released score reads as taking points
  away. A too-low score is more likely to be questioned by the student and
  reviewed.
- Hybrid auto-finalize skips review for confident scores; a confident
  over-score is the one error no person sees.

"A little" is the operative word: a model that is systematically harsh is
also wrong, and teachers would stop trusting it. The evaluation therefore
measures direction as well as size, and the pass bar (below) caps both:

- **Signed bias** — mean (AI − teacher) per criterion level and in total
  points as a fraction of max. Target: at or slightly below zero.
- **Over-score rate vs under-score rate** — of the criteria the AI gets
  wrong, the share scored above the teacher must not exceed the share scored
  below.
- **Confident over-scores** — over-scores with confidence ≥ 0.85, the ones
  hybrid would finalize unreviewed. Counted on their own.
- **Ranking with asymmetric weight** — when two configurations pass the bar,
  they are compared on a weighted error where an over-score counts **twice**
  an under-score of the same size (D-6).

A prompt-side lever is tested as a variant rather than assumed: a "lower on
doubt" rule ("when the evidence sits between two levels, choose the lower
one") added to the system prompt as a new prompt version. It runs on the two
best configurations from the first round only (slice 5), and is adopted only
if it moves bias toward the target without costing agreement.

### Configurations (D-1: no Opus, no Fable)

| Configuration | Why |
|---|---|
| Sonnet 4.6 | Today's model — the baseline |
| Sonnet 5.5, thinking off (`between_tools`) | Cheaper per essay than the baseline |
| Sonnet 5.5, low effort with thinking | Whether thinking improves scoring |
| Haiku 4.5 | A third of the cost |
| Nova 2 Pro, Nova 2 Lite | Amazon's own models |
| Mistral Large 3, Llama 4 Maverick | Inexpensive models from other vendors |
| DeepSeek v3.2 | No vendor limitation for now (D-3) |

Every configuration gets the same prompt, rubric JSON and temperature 0, and
scores every essay in the set **twice** (two runs, two labels) so
self-consistency is measured. Sonnet 5.5 needs the scorer to send its
thinking setting; the other non-Claude models need only the model id.

### The evaluation set

- **Primary set:** essays with an independent teacher score — the existing 8
  plus the blind scores from slice 3. Target **150–250** across at least
  3 teachers, 3 rubrics and 2 subjects, mixing analytic and single-point
  rubrics and a range of lengths. 100 is the floor for a first read; below
  that the result is reported as indicative only.
- **Hard cases** (scored by the same teachers, reported separately):
  off-topic, very short, non-English, and the prompt-injection samples from
  safeguarding spike S-1.
- **One rater per essay for the first round (D-4).** Each essay is scored
  by its own teacher (D-5); there is no second rater, so no two-teacher
  ceiling yet. Sonnet 4.6 is the comparison point. A second-rater subset
  (about 50 essays, scored blind by a colleague) is the follow-up if the
  first round is close or a switch is on the table.
- **Anchored set:** the 19 approved-as-is essays, reported in their own
  column for interest only and never in the primary set (D-7).

### Measures

| Measure | Status |
|---|---|
| Exact agreement, mean point difference, scale-free difference | Exists |
| Per-criterion level agreement | Exists |
| Agreement within one level | Slice 1 |
| Quadratic weighted kappa per criterion and on total (a two-teacher figure joins it when a second rater exists) | Slice 1 |
| Signed bias; over-score vs under-score rates; confident over-scores | Slice 1 |
| Asymmetric weighted error (over-score × 2) | Slice 1 |
| Self-consistency (same score on both runs) | Slice 1 |
| Unusable replies (not JSON, wrong ids, out of bounds) as a share of attempts | Slice 1 — the runner writes only successes today; it records attempted / failed counts in `scoring_runs.notes` |
| Evidence check: quoted evidence appears in the essay | Slice 1 |
| Length effect: score vs essay length beyond what the teacher gave | Slice 1 |
| Cost and latency per call | Exists (`ai-usage.sh`, per run label) |

Results are always broken out by rubric type (analytic vs single-point),
because a model can do well on one and badly on the other.

### Pass bar (D-6, confirmed 2026-10-03)

A configuration may replace Sonnet 4.6 only if, on the primary set:

1. **Agreement:** weighted kappa within 0.05 of Sonnet 4.6's on every
   rubric type (once a two-teacher figure exists: within 0.05 of the lower of
   the two);
2. **Direction:** signed bias between **−0.25 and 0** levels per criterion,
   and over-score rate ≤ under-score rate;
3. **Confident over-scores:** no more than Sonnet 4.6's count;
4. **Reliability:** unusable replies < 1%, self-consistency ≥ Sonnet 4.6's;
5. **Cost:** lower per essay than Sonnet 4.6.

The same bar is applied to Sonnet 4.6 itself against the teacher scores: if
the baseline fails criterion 2, that is a finding for today's product, not
just for the comparison.

### What this deliberately does not do

- No Opus or Fable configurations (D-1).
- No batch inference — the evaluation is ~4,000 calls and costs under $40
  on demand; batch is a separate production decision.
- No judgement of rationale helpfulness to students; that needs teacher
  ratings and is a later study.
- No teacher-facing change: research rows stay invisible, and nothing
  switches models until the results are read and James decides.

## Slices

| # | Slice | Side | Notes |
|---|---|---|---|
| 0 | This note; decisions D-1…D-7 | — | Done 2026-10-03 |
| 1 | Measures in `runComparison.ts` / `compare-runs.ts` + runner failure counts | Design tool | Pure functions + tests; no migration |
| 2 | Allow the candidate models: task-role `bedrock:InvokeModel` for their ids; Sonnet 5.5 thinking setting in the scorer; prices in `ai-usage.sh` | Infra + design tool | One deploy |
| 3 | Blind teacher scores: each teacher scores their own students' unscored essays (D-5), one rater per essay (D-4) | Teachers | First count how many of the 328 show an AI proposal; no code if the study essays have none visible; James's ask to teachers |
| 4 | Runs: every configuration × 2 via `oneoff-aurora.sh corpus`, labels `eval-<model>-<n>` | Ops | Under $40 |
| 5 | Results write-up against the pass bar; "lower on doubt" variant on the top two | Docs (+ a prompt version if adopted) | Recommendation to James |

Slices 1 and 2 can run while slice 3 collects scores.

## Decisions

- **D-1 (James, 2026-10-03):** the evaluation excludes Opus and Fable
  models.
- **D-2 (James, 2026-10-03):** agreement with teacher scores is the goal;
  when the AI is wrong, a slightly lower score is preferred to a higher one.
- **D-3 (James, 2026-10-03):** no limitation on model vendors yet — DeepSeek,
  Mistral and Meta models are in the matrix.
- **D-4 (James, 2026-10-03):** one rater per essay for the initial testing;
  a second-rater subset is a later round.
- **D-5 (James, 2026-10-03):** teachers score their own students' unscored
  essays (no drawn sample).
- **D-6 (James, 2026-10-03):** the pass bar as written — kappa margin 0.05,
  bias band −0.25 to 0 levels, over-scores weighted 2× in the tie-break.
- **D-7 (James, 2026-10-03):** the 19 approved-as-is essays stay out of the
  primary set.

## Progress

- 2026-10-03: note written; the supply count above run read-only on Aurora;
  D-1…D-7 decided the same day. Nothing built. Next: slices 1 and 2, and
  James's ask to teachers for slice 3.

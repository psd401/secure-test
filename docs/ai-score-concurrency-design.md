# AI scoring: one proposal per essay under concurrent requests

Status: BUILT 2026-10-18 (option A; decisions below), NOT deployed. Trigger: NIT 1 in the review of
psd401/secure-test#54 (U-24 "Score essays with AI" for a whole section). The
race predates that PR; U-24 just makes it easier to hit.

## The race

`POST /api/attempts/[attemptId]/score-ai` reads which responses already have
a non-research score row ONCE at request start (`alreadyScoredIds`), then for
each remaining essay calls Bedrock and inserts a `proposed` row
(`lib/scoring/aiScoreResponse.ts`). `scores` is unique only on the FINAL row
per response (`scores_one_final_per_response_unq`), so a proposal never
conflicts.

Two ways to hit it:

1. Two batch requests for the same attempt (two tabs, a double press, U-24
   re-run while the first is still going): both snapshots are empty, both
   score every essay → two proposals each, two Bedrock calls each.
2. The per-essay "Score with AI" (`rescore-ai`, which deliberately ADDS a
   proposal) while the batch is on the same essay → two proposals.

Cost: each duplicate is a full second Bedrock call (~1.4¢ measured
2026-10-03, up to two calls with the retries). Teacher-visible harm is small
(the queue shows the latest proposal), but the work is wasted and the
"Earlier" history gets noise.

## Options

| | Closes the race | Saves the Bedrock call | Migration | Notes |
|---|---|---|---|---|
| A. Claim column on `responses` | yes | yes | yes (one nullable column) | recommended |
| B. In-process lock (Map) | only with one task | yes | no | breaks at desiredCount > 1 and during a rolling deploy (two tasks briefly) |
| C. Transaction + `pg_try_advisory_xact_lock` / `FOR UPDATE` held across the call | yes | yes | no | holds a pool connection for the whole Bedrock call (5–30 s); pool is `max: 5` per task (`db/client.ts`) — a U-24 batch (3 at a time) would take 3 of 5 and stall every other teacher |
| D. Partial unique index, one live proposal | yes | **no** | yes | breaks `rescore-ai`'s deliberate extra proposal unless it first supersedes the old one (a semantics change); the second call still runs and is thrown away |
| E. Re-check just before the insert | narrows only | **no** | no | still a check-then-insert gap; the cost is already spent |

## Recommendation: A — a short-lived claim on the response

- Migration: `responses.ai_scoring_claimed_at timestamptz NULL`.
- Before the scorer call, one atomic statement:
  `UPDATE responses SET ai_scoring_claimed_at = now() WHERE id = $1 AND
  (ai_scoring_claimed_at IS NULL OR ai_scoring_claimed_at < now() - interval
  '5 minutes') RETURNING id`. No row back → someone else is scoring it.
- Cleared in a `finally` after the insert (or failure). The 5-minute expiry
  covers a task that dies mid-call; no sweep needed.
- Lives in `aiScoreResponse` as a new outcome `{ kind: "in_progress" }`, so
  both routes share it:
  - **score-ai (batch):** after claiming, re-reads non-research score rows for
    THAT response (closes the start-of-request snapshot gap) and releases +
    counts it `already_scored` if one appeared. A lost claim is counted in a
    new `in_progress` field of the JSON (U-24's summary can show it or fold it
    into "already scored").
  - **rescore-ai (per essay):** a lost claim → 409 `scoring_in_progress` with
    a `detail` the queue shows ("This essay is already being scored — refresh
    in a moment."). A deliberate re-run after the first finishes still adds a
    proposal, as today.
- The corpus runner (`runEssayScorer` + its own insert) is untouched: research
  rows are invisible to teachers and run from a CLI.

Ships as one slice: migration + `aiScoreResponse` + both routes + a DB test
that fires two `score-ai` calls for the same attempt concurrently (mock
provider with a short delay so they overlap) and asserts one proposal per
essay and one provider call per essay, plus a batch-vs-rescore case. The
migration means the deploy runs after 15:30 PT on a weekday or with
`--during-school`.

## Decisions (James, 2026-10-18)

1. Option A.
2. 5-minute claim expiry (`AI_SCORING_CLAIM_TTL_MINUTES`).
3. The batch JSON gets its own `in_progress` count.

## Progress

- 2026-10-18: built as one slice — **migration 0061**
  (`responses.ai_scoring_claimed_at`), the claim in `aiScoreResponse`
  (`skipIfScored` for the batch; outcomes `in_progress` / `already_scored`;
  the release matches the claim's exact value as text, so it never clears a
  takeover's claim), score-ai's `in_progress` count, rescore-ai's 409
  `scoring_in_progress` with a `detail`. Tests in `test/essay-scorer.test.ts`:
  two concurrent batch runs → one scorer call and one proposal per essay
  (without the claim: 4 calls for 2 essays); a per-essay press during a batch
  → 409, then a deliberate re-run still adds a proposal; a 6-minute-old claim
  is taken over and a fresh one honoured. Migration applied to the test DB
  only (not dev — the dev DB is shared across worktrees). Not covered: lazy
  safeguarding screening still runs before the claim in both routes, so two
  overlapping requests can both screen an unscreened answer (unchanged).
  U-24's summary (PR #54) does not show `in_progress` yet.

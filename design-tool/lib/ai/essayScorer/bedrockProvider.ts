import { log } from "../../log";
import { converseTextWithMeta } from "../bedrockConverse";
import {
  ESSAY_SCORER_PROMPT_VERSION,
  ESSAY_SCORE_MAX_TOKENS,
  ESSAY_SCORE_SYSTEM_PROMPT,
  buildEssayScoreUserPrompt,
  describeReplyShape,
  parseScoreResult,
  reconcileLevelIds,
  reconcilePointsTotal,
  scoringView,
  validateAgainstRubric,
} from "./scoreCore";
import type {
  EssayScorerProvider,
  ScoreEssayRequest,
  ScoreEssayResult,
} from "./types";

// Amazon Bedrock essay scorer — AWS SDK Converse + SigV4, same wiring as
// item gen (ADR 0007) and math translation (ADR 0011). Rubric-based
// scoring is reasoning-heavy, so the default is the same Sonnet 4.6
// profile item gen uses; override via BEDROCK_ESSAY_SCORE_MODEL.
// temperature 0: scoring should be as repeatable as the model allows.
// Model output is validated twice — Zod shape, then rubric bounds — and
// rejected here (throw) rather than persisted wrong.

const DEFAULT_MODEL = "us.anthropic.claude-sonnet-4-6";

// 2026-10-09 alarm: one reply in ~25 came back unreadable with stop reason
// end_turn, and the teacher's retry five minutes later scored the same
// essay. So an unreadable reply gets ONE more try before it is reported. A
// reply cut off at max_tokens would be cut off again, and a reply that reads
// but fails the shape is the model's answer, not noise — both are reported
// at once, as before.
//
// 2026-10-13 alarm: in a class batch of ~20, one reply chose a valid level
// but wrote points that disagree with it (6.5 for a level worth 8.5). The
// validator cannot know which the model meant, so it refuses — and that
// reply now also gets ONE more try (James, option a: retry rather than pick
// a score for the teacher). The two retries share the budget: at most two
// calls per essay, whatever went wrong.
const MAX_ATTEMPTS = 2;

// 2026-10-18: the scoring claim (docs/ai-score-concurrency-design.md)
// expires after AI_SCORING_CLAIM_TTL_MINUTES = 5, and the shared Bedrock
// client has no request timeout, so a hung call could outlive the claim and
// let a second request call Bedrock for the same essay. Production, 30 days
// to 2026-10-18 (594 essay scores): median 5.8 s, p99 10.7 s, max 12.7 s,
// longest reply 910 tokens. 60 s per call is ~5x the slowest seen; with
// MAX_ATTEMPTS calls the worst case is ~2 min, inside the claim.
export const ESSAY_SCORE_CALL_TIMEOUT_MS = 60_000;

export const bedrockEssayScorer: EssayScorerProvider = {
  // Lazy so tests can configure BEDROCK_ESSAY_SCORE_MODEL after import.
  get id() {
    return `bedrock-${process.env.BEDROCK_ESSAY_SCORE_MODEL ?? DEFAULT_MODEL}`;
  },

  promptVersion: ESSAY_SCORER_PROMPT_VERSION,

  async scoreEssay(
    req: ScoreEssayRequest,
    ownerSub?: string,
  ): Promise<ScoreEssayResult> {
    // D-5: the model sees the scoring view (single-point targets expanded
    // into the below/meets/exceeds ladder), and the returned selections are
    // bounds-checked against that same view.
    const rubric = scoringView(req.rubric);
    for (let attempt = 1; ; attempt++) {
      const { text, stopReason } = await converseTextWithMeta({
        modelId: process.env.BEDROCK_ESSAY_SCORE_MODEL ?? DEFAULT_MODEL,
        systemText: ESSAY_SCORE_SYSTEM_PROMPT,
        userText: buildEssayScoreUserPrompt({ ...req, rubric }),
        maxTokens: ESSAY_SCORE_MAX_TOKENS,
        temperature: 0,
        errPrefix: "bedrock",
        surface: "essay-score",
        ownerSub,
        timeoutMs: ESSAY_SCORE_CALL_TIMEOUT_MS,
      });
      let parsed;
      try {
        parsed = parseScoreResult(text, "bedrock");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const unreadable = message.includes("did not return valid JSON");
        const retry = unreadable && stopReason !== "max_tokens" && attempt < MAX_ATTEMPTS;
        log.warn("essay_score_reply_unparsed", {
          attempt,
          stop_reason: stopReason ?? null,
          retrying: retry,
          ...describeReplyShape(text),
        });
        if (retry) continue;
        // The stop reason is the tell between a truncated reply (max_tokens)
        // and genuinely malformed output; it goes into the log line.
        const tries = attempt > 1 ? `, after ${attempt} attempts` : "";
        throw new Error(`${message} (stopReason ${stopReason ?? "unknown"}${tries})`);
      }
      const { result: levelled, repaired } = reconcileLevelIds(parsed, rubric);
      if (repaired > 0) {
        console.warn(`bedrock essay score: repaired ${repaired} level id(s) by points`);
      }
      const { result, corrected } = reconcilePointsTotal(levelled, rubric);
      if (corrected) {
        log.warn("essay_score_total_corrected", corrected);
      }
      const bounds = validateAgainstRubric(result, rubric);
      if (bounds.valid) return result;
      // The reason names criterion / level ids and numbers only — never the
      // essay or the model's rationale — so it is safe in the log.
      const retry = attempt < MAX_ATTEMPTS;
      log.warn("essay_score_rubric_mismatch", { attempt, retrying: retry, reason: bounds.reason });
      if (retry) continue;
      const tries = attempt > 1 ? ` (after ${attempt} attempts)` : "";
      throw new Error(`bedrock: model score failed rubric bounds: ${bounds.reason}${tries}`);
    }
  },
};

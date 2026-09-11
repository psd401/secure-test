import { converseText } from "../bedrockConverse";
import {
  ESSAY_SCORE_MAX_TOKENS,
  ESSAY_SCORE_SYSTEM_PROMPT,
  buildEssayScoreUserPrompt,
  parseScoreResult,
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

export const bedrockEssayScorer: EssayScorerProvider = {
  // Lazy so tests can configure BEDROCK_ESSAY_SCORE_MODEL after import.
  get id() {
    return `bedrock-${process.env.BEDROCK_ESSAY_SCORE_MODEL ?? DEFAULT_MODEL}`;
  },

  async scoreEssay(
    req: ScoreEssayRequest,
    ownerSub?: string,
  ): Promise<ScoreEssayResult> {
    // D-5: the model sees the scoring view (single-point targets expanded
    // into the below/meets/exceeds ladder), and the returned selections are
    // bounds-checked against that same view.
    const rubric = scoringView(req.rubric);
    const text = await converseText({
      modelId: process.env.BEDROCK_ESSAY_SCORE_MODEL ?? DEFAULT_MODEL,
      systemText: ESSAY_SCORE_SYSTEM_PROMPT,
      userText: buildEssayScoreUserPrompt({ ...req, rubric }),
      maxTokens: ESSAY_SCORE_MAX_TOKENS,
      temperature: 0,
      errPrefix: "bedrock",
      surface: "essay-score",
      ownerSub,
    });
    const result = parseScoreResult(text, "bedrock");
    const bounds = validateAgainstRubric(result, rubric);
    if (!bounds.valid) {
      throw new Error(`bedrock: model score failed rubric bounds: ${bounds.reason}`);
    }
    return result;
  },
};

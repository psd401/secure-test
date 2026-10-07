import { z } from "zod";
import { and, eq, ne } from "drizzle-orm";
import { getDb } from "@/db/client";
import { responses, items, scores } from "@/db/schema";
import type { SessionPayload } from "@/lib/auth/session";
import { authorizeAttempt } from "@/lib/api/access";
import {
  rubricMaxPoints,
  scoringView,
  validateAgainstRubric,
} from "@/lib/ai/essayScorer/scoreCore";
import { fillBlankMaxPoints, tableMaxPoints } from "@/lib/scoring/auto";

// Slice 39: shared plumbing for the review actions (manual score, approve,
// re-run AI). Loads the response → attempt → assessment chain and enforces
// the invariants every action shares: owner-scoped, submitted attempt.

export const ManualScoreBody = z
  .object({
    points: z.number().min(0),
    max_points: z.number().positive(),
    // Rubric-driven scoring: level picks per criterion, validated against
    // the item's rubric when present. Optional — a teacher may override
    // holistically with bare points.
    criterion_scores: z
      .array(
        z.object({
          criterion_id: z.string().min(1),
          level_id: z.string().min(1),
          points: z.number().min(0),
          rationale: z.string().max(2000).optional().default(""),
        }),
      )
      .min(1)
      .optional(),
    note: z.string().max(4000).optional(),
  })
  .refine((b) => b.points <= b.max_points, {
    message: "points must be <= max_points",
    path: ["points"],
  });
export type ManualScoreBody = z.infer<typeof ManualScoreBody>;

// Change a final score (docs/change-score-design.md): the manual score body
// plus an optional reason (4.1: optional), stored as the new row's
// `rationale.note`. A `note` on this body is ignored — the reason is the note.
export const ChangeScoreBody = ManualScoreBody.and(
  z.object({ reason: z.string().max(500).optional() }),
);
export type ChangeScoreBody = z.infer<typeof ChangeScoreBody>;

export type ResponseChain =
  | { ok: true; response: typeof responses.$inferSelect; item: typeof items.$inferSelect; hasFinal: boolean }
  | { ok: false; status: 400 | 403 | 404; error: string };

export async function loadResponseChain(
  responseId: string,
  session: SessionPayload,
): Promise<ResponseChain> {
  const db = getDb();
  const [response] = await db
    .select()
    .from(responses)
    .where(eq(responses.id, responseId))
    .limit(1);
  if (!response) return { ok: false, status: 404, error: "not_found" };
  // Access slice 1 (D-3): the attempt's assessment answers who may score this
  // response, and the old 403 for another teacher's response is now the same
  // 404 the missing cases give.
  const access = await authorizeAttempt(db, session, response.attempt_id, "edit");
  if (!access.ok) return { ok: false, status: 404, error: "not_found" };
  const attempt = access.attempt;
  if (attempt.status !== "submitted") {
    return { ok: false, status: 400, error: "attempt_not_submitted" };
  }
  const [item] = await db
    .select()
    .from(items)
    .where(eq(items.id, response.item_id))
    .limit(1);
  if (!item) return { ok: false, status: 404, error: "not_found" };
  const scoreRows = await db
    .select({ status: scores.status })
    .from(scores)
    // A research row is neither a final nor a proposal to a teacher
    // (docs/scoring-corpus-design.md slice 1), so the actions that ride
    // this chain — manual score, approve, re-run AI — never see one.
    .where(and(eq(scores.response_id, response.id), ne(scores.status, "research")));
  return {
    ok: true,
    response,
    item,
    hasFinal: scoreRows.some((s) => s.status === "final"),
  };
}

export type ManualScoreCheck =
  | { ok: true }
  | { ok: false; status: 400; body: Record<string, unknown> };

/**
 * The two rules a hand-given score must satisfy, shared by the score route and
 * the change-score route (docs/change-score-design.md) so "what a valid manual
 * score is" cannot drift between the first score and a correction.
 *
 * Review fix (2026-08-14, finding 4): max_points is not caller-chosen — it
 * must equal the rubric max when a rubric exists, else 1 (the slice-37
 * every-item-worth-1-point rule). Otherwise the same column carries different
 * maxima per student and results/CSV totals become incomparable. E3 slice 2: a
 * table is worth its cells (keyed cells when any, else every cell) — a
 * per-item constant, so the rule still holds.
 *
 * When the body carries criterion_scores, the picks are validated against the
 * SCORING VIEW (D-5), so a single-point item takes the derived
 * `<target>.below|.meets|.exceeds` ids the queue offers and the AI proposes.
 * Identity for analytic/holistic, and the max is unchanged by the expansion.
 */
export function checkManualScore(
  item: typeof items.$inferSelect,
  body: ManualScoreBody,
): ManualScoreCheck {
  const rubric = item.config.rubric;
  const expectedMax = rubric
    ? rubricMaxPoints(rubric)
    : item.type === "table"
      ? tableMaxPoints(item.config)
      : item.type === "fill_blank"
        ? fillBlankMaxPoints(item.config)
        : 1;
  if (body.max_points !== expectedMax) {
    return {
      ok: false,
      status: 400,
      body: { ok: false, error: "max_points_mismatch", expected: expectedMax },
    };
  }
  if (body.criterion_scores) {
    if (!rubric) {
      return { ok: false, status: 400, body: { ok: false, error: "item_has_no_rubric" } };
    }
    const bounds = validateAgainstRubric(
      {
        criterion_scores: body.criterion_scores,
        points: body.points,
        max_points: body.max_points,
      },
      scoringView(rubric),
    );
    if (!bounds.valid) {
      return {
        ok: false,
        status: 400,
        body: { ok: false, error: "rubric_bounds", detail: bounds.reason },
      };
    }
  }
  return { ok: true };
}

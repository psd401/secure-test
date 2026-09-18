import { z } from "zod";
import { and, eq, ne } from "drizzle-orm";
import { getDb } from "@/db/client";
import { responses, items, scores } from "@/db/schema";
import type { SessionPayload } from "@/lib/auth/session";
import { authorizeAttempt } from "@/lib/api/access";

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

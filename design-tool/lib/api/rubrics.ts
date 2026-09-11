import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { RubricSchema, type Rubric } from "@secure-test/schema";
import { getDb } from "@/db/client";
import { RUBRIC_SOURCES, rubrics, type RubricRow } from "@/db/schema";
import { rubricMaxPoints } from "@/lib/ai/essayScorer/scoreCore";

// Rubric library slice 3 (docs/rubric-upload-design.md §"Rubric library and
// reuse", D-4). Write boundary for the `rubrics` table, mirroring
// lib/api/students.ts's posture: the shared RubricSchema is the single
// source of truth for the rubric shape (the same schema items.config.rubric
// is validated by), and only the wrapper fields are declared here.

const TitleSchema = z.string().trim().min(1).max(200);

export const CreateRubricBody = z.object({
  title: TitleSchema,
  rubric: RubricSchema,
  source: z.enum(RUBRIC_SOURCES).default("upload"),
});
export type CreateRubricBody = z.infer<typeof CreateRubricBody>;

export const UpdateRubricBody = z
  .object({
    title: TitleSchema.optional(),
    rubric: RubricSchema.optional(),
  })
  .refine((b) => b.title !== undefined || b.rubric !== undefined, {
    message: "nothing to update",
  });
export type UpdateRubricBody = z.infer<typeof UpdateRubricBody>;

export interface RubricSummary {
  id: string;
  title: string;
  style: Rubric["style"];
  criteria_count: number;
  max_points: number;
  source: string;
  updated_at: Date;
}

/** What GET /api/rubrics returns per row — enough for the "Use a saved
 * rubric…" picker (title, style, N criteria, max points) without shipping
 * every descriptor of every rubric the teacher owns. */
export function rubricSummary(row: RubricRow): RubricSummary {
  return {
    id: row.id,
    title: row.title,
    style: row.rubric.style,
    criteria_count: row.rubric.criteria.length,
    max_points: rubricMaxPoints(row.rubric),
    source: row.source,
    updated_at: row.updated_at,
  };
}

/**
 * Guard for `config.rubric_id` on an item write: a 400 `rubric_not_found`
 * response when the body names a rubric the caller does not own, else null.
 *
 * 400 rather than 404 on purpose — the id arrives inside an item body, so
 * the failure is "this body is wrong", not "the item you addressed is
 * missing". The same response covers a rubric that does not exist and one
 * belonging to another teacher; an item write is no place to learn which.
 */
export async function rejectUnownedRubricId(
  rubricId: string | null | undefined,
  ownerSub: string,
): Promise<NextResponse | null> {
  if (!rubricId) return null;
  const db = getDb();
  const [row] = await db
    .select({ id: rubrics.id })
    .from(rubrics)
    .where(and(eq(rubrics.id, rubricId), eq(rubrics.owner_sub, ownerSub)))
    .limit(1);
  if (row) return null;
  return NextResponse.json(
    {
      ok: false,
      error: "rubric_not_found",
      hint: "That saved rubric no longer exists in your rubric library.",
    },
    { status: 400 },
  );
}

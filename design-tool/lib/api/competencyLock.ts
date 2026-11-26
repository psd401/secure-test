/**
 * B1 D6 (docs/point-weighting-design.md): a point weight and a competency
 * assessment must never meet. Both writes that could bring them together —
 * a weighted item save, and `PUT /api/assessments/:id/competency` — take the
 * assessment row's lock (`FOR UPDATE`) first and decide inside the same
 * transaction, so under READ COMMITTED whichever commits second sees the
 * other's write (each later statement takes a fresh snapshot) and refuses.
 * A plain read before the transaction cannot: two concurrent requests would
 * both see the old state and both commit.
 *
 * `FOR UPDATE` rather than `FOR SHARE`: the item routes go on to update the
 * same assessment row (`updated_at`), and two SHARE holders upgrading would
 * deadlock. Taken only when a weight is being written, so ordinary saves are
 * unaffected. Lock order is always assessment, then item.
 */

import { eq } from "drizzle-orm";
import type { getDb } from "@/db/client";
import { assessments } from "@/db/schema";

type Tx = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];

/** Lock the assessment row; true when it is a competency assessment, null when it is gone. */
export async function lockAssessmentForPoints(tx: Tx, assessmentId: string): Promise<boolean | null> {
  const [row] = await tx
    .select({ competency: assessments.competency_pass_min_points })
    .from(assessments)
    .where(eq(assessments.id, assessmentId))
    .for("update");
  if (!row) return null;
  return row.competency !== null;
}

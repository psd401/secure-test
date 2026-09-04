import { and, asc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { students, student_accommodations } from "@/db/schema";
import type { getDb } from "@/db/client";
import { tideValueForCode } from "./tideCatalog";

type Db = ReturnType<typeof getDb>;

export interface PendingTideDiff {
  accommodation_id: string;
  student_id: string;
  student_name: string;
  ssid: string | null;
  subject: string;
  tool_id: string;
  kept_value: string;
  /** What TIDE currently asserts, resolved from the row's stored code. */
  tide_value: string;
}

/**
 * Rows the teacher edited after a TIDE import that a LATER import touched
 * with a different value. Lifted from the review page (UX pass 1, slice 8)
 * so the Students page can say "N changes to review" too.
 *
 * D14: the timestamp predicate is only the cheap pre-filter — applyTideImport
 * refreshes last_imported_at on every tide_then_edited row it sees — so the
 * real test is the value comparison. A row whose code no longer resolves
 * (catalog drift) is dropped rather than shown: we cannot state what TIDE's
 * value is, so we cannot offer to accept it.
 */
export async function pendingTideDiffs(db: Db, ownerSub: string): Promise<PendingTideDiff[]> {
  const candidates = await db
    .select({
      accommodation_id: student_accommodations.id,
      student_id: students.id,
      student_name: students.name,
      ssid: students.ssid,
      subject: student_accommodations.subject,
      tool_id: student_accommodations.tool_id,
      kept_value: student_accommodations.value,
      tide_code: student_accommodations.tide_code,
      kept_against_tide_code: student_accommodations.kept_against_tide_code,
    })
    .from(student_accommodations)
    .innerJoin(students, eq(student_accommodations.student_id, students.id))
    .where(
      and(
        eq(students.owner_sub, ownerSub),
        eq(student_accommodations.source, "tide_then_edited"),
        isNull(student_accommodations.removed_at),
        isNotNull(student_accommodations.last_imported_at),
        sql`${student_accommodations.last_imported_at} > coalesce(${student_accommodations.edited_at}, ${student_accommodations.created_at})`,
      ),
    )
    .orderBy(asc(students.name), asc(students.ssid), asc(student_accommodations.subject));

  return candidates.flatMap((r) => {
    if (!r.tide_code) return [];
    // UX pass 2 slice 5 (P2-5): the teacher already chose "Keep mine"
    // against exactly this TIDE assertion — decided, not pending. A new
    // TIDE code stops matching and the diff comes back on its own.
    if (r.kept_against_tide_code === r.tide_code) return [];
    const tide_value = tideValueForCode(r.subject, r.tool_id, r.tide_code);
    if (tide_value === null || tide_value === r.kept_value) return [];
    return [
      {
        accommodation_id: r.accommodation_id,
        student_id: r.student_id,
        student_name: r.student_name,
        ssid: r.ssid,
        subject: r.subject,
        tool_id: r.tool_id,
        kept_value: r.kept_value,
        tide_value,
      },
    ];
  });
}

import { and, eq, gt, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import {
  access_grants,
  assessments,
  roster_students,
  student_accommodations,
  students,
} from "@/db/schema";
import type { getDb } from "@/db/client";
import { isVisibleAccommodation } from "@/lib/accommodations/catalog";
import { isEnabledValue, type ToolSetting } from "@/lib/accommodations/effective";
import { teachersCurrentlyTeaching } from "@/lib/accommodations/coTeacherRecords";
import { coTeachersOf } from "@/lib/roster/coTeachers";
import { normalizeEmail } from "@/lib/roster/queries";

type Db = ReturnType<typeof getDb>;

/**
 * U-17 slice 2 (D-3, 13.4): "Also on X's record" on a teacher's Students
 * page — the records OTHER teachers keep for the same child that now count on
 * shared tests. Symmetric: the lead sees the co-teacher's, the co-teacher the
 * lead's.
 *
 * Related teachers of the caller = their roster co-teachers, the grantees of
 * live assessment grants on the caller's own tests, and the owners of tests
 * the caller holds a live grant on. Like delivery (13.1), a related teacher's
 * record shows only for a child they currently teach.
 */
export async function relatedTeacherEmails(db: Db, sub: string, email: string | null): Promise<string[]> {
  const me = normalizeEmail(email);
  const now = new Date();
  const live = and(
    eq(access_grants.scope_kind, "assessment"),
    isNull(access_grants.revoked_at),
    lte(access_grants.starts_at, now),
    or(isNull(access_grants.ends_at), gt(access_grants.ends_at, now)),
  );
  const mine = await db
    .select({ email: access_grants.grantee_email })
    .from(access_grants)
    .innerJoin(assessments, sql`${access_grants.scope_id} = ${assessments.id}::text`)
    .where(and(live, eq(assessments.owner_sub, sub)));
  const theirs = me
    ? await db
        .select({ email: assessments.owner_email })
        .from(access_grants)
        .innerJoin(assessments, sql`${access_grants.scope_id} = ${assessments.id}::text`)
        .where(and(live, eq(access_grants.grantee_email, me)))
    : [];
  const roster = me ? await coTeachersOf(db, me) : [];
  const out = new Set<string>();
  for (const e of [...mine.map((r) => r.email), ...theirs.map((r) => r.email), ...roster.map((r) => r.email)]) {
    const n = normalizeEmail(e);
    if (n && n !== me) out.add(n);
  }
  return [...out].sort();
}

export interface OtherRecord {
  email: string;
  /** Enabled, teacher-visible tools on that teacher's record. */
  tools: ToolSetting[];
}

/** Roster ps_id → other teachers' records for that child (by email). */
export async function otherTeachersRecords(
  db: Db,
  caller: { sub: string; email: string | null },
  psIds: readonly string[],
): Promise<Map<string, OtherRecord[]>> {
  const out = new Map<string, OtherRecord[]>();
  if (psIds.length === 0) return out;
  const related = await relatedTeacherEmails(db, caller.sub, caller.email);
  if (related.length === 0) return out;
  const teaching = await teachersCurrentlyTeaching(db, related, psIds);
  const teachingPs = [...teaching.keys()];
  if (teachingPs.length === 0) return out;

  const roster = await db
    .select({ ps_id: roster_students.ps_id, ssid: roster_students.ssid })
    .from(roster_students)
    .where(inArray(roster_students.ps_id, teachingPs));
  const psBySsid = new Map(roster.filter((r) => r.ssid).map((r) => [r.ssid!, r.ps_id]));
  const ssids = [...psBySsid.keys()];

  const rows = await db
    .select({
      id: students.id,
      owner_email: students.owner_email,
      roster_ps_id: students.roster_ps_id,
      ssid: students.ssid,
    })
    .from(students)
    .where(
      and(
        inArray(students.owner_email, related),
        ne(students.owner_sub, caller.sub),
        isNull(students.practice_for_sub),
        ssids.length > 0
          ? or(
              inArray(students.roster_ps_id, teachingPs),
              and(isNull(students.roster_ps_id), inArray(students.ssid, ssids)),
            )
          : inArray(students.roster_ps_id, teachingPs),
      ),
    );
  if (rows.length === 0) return out;
  const records = await db
    .select({
      student_id: student_accommodations.student_id,
      tool_id: student_accommodations.tool_id,
      value: student_accommodations.value,
    })
    .from(student_accommodations)
    .where(
      and(
        inArray(
          student_accommodations.student_id,
          rows.map((r) => r.id),
        ),
        isNull(student_accommodations.removed_at),
      ),
    );

  const byRow = new Map<string, ToolSetting[]>();
  for (const r of records) {
    if (!isEnabledValue(r.value) || !isVisibleAccommodation(r.tool_id)) continue;
    const list = byRow.get(r.student_id) ?? [];
    if (!list.some((t) => t.tool_id === r.tool_id)) list.push({ tool_id: r.tool_id, value: r.value });
    byRow.set(r.student_id, list);
  }
  for (const row of rows) {
    const psId = row.roster_ps_id ?? (row.ssid ? psBySsid.get(row.ssid) : undefined);
    const email = row.owner_email!;
    const tools = byRow.get(row.id) ?? [];
    if (!psId || tools.length === 0 || !teaching.get(psId)?.has(email)) continue;
    const list = out.get(psId) ?? [];
    list.push({ email, tools: tools.sort((a, b) => a.tool_id.localeCompare(b.tool_id)) });
    out.set(psId, list.sort((a, b) => a.email.localeCompare(b.email)));
  }
  return out;
}

import { and, eq, inArray, isNull, ne, or } from "drizzle-orm";
import {
  assessment_student_overrides,
  roster_students,
  student_accommodations,
  students,
  type AssessmentRow,
} from "@/db/schema";
import type { getDb } from "@/db/client";
import { explainAccommodations, isEnabledValue, type ToolSetting } from "@/lib/accommodations/effective";
import { coTeacherEmailsFor, teachersCurrentlyTeaching } from "@/lib/accommodations/coTeacherRecords";
import { studentsInTeachersSections } from "@/lib/roster/queries";
import { assessmentOwner } from "@/lib/scoring/results";

type Db = ReturnType<typeof getDb>;

/**
 * U-16 (docs/roadmap-2026-09.md): "who gets what" on an assessment — every
 * student the rule has something to say about, worked out by the same
 * `explainAccommodations` the delivery route uses, in a fixed number of
 * queries rather than two per student.
 *
 * Population: the ASSESSMENT OWNER's overlay rows (delivery's tenant; practice
 * rows excluded) that carry a live accommodation record OR an exception on
 * this assessment. A student with neither gets nothing, so they are counted,
 * not listed: `others_count` is the owner's current class-list students
 * (roster) who get no tool. Null when the owner's email is unknown.
 *
 * U-17: co-teachers' records for the children they currently teach are
 * unioned in, owner first (the delivery rule), and a tool they supplied is
 * marked `from_record_of`. A child with only a co-teacher's record is listed
 * too — the join creates the owner's row with nothing on it.
 */
export interface PreviewTool {
  tool_id: string;
  value: string;
  /** Turned on by an exception rather than the record. */
  exception: boolean;
  construct_altering: boolean;
  /** U-17 (13.6): the co-teacher whose record supplied it; null when it came
   * from the owner's record or an exception. */
  from_record_of: string | null;
}

export interface PreviewStudent {
  student_id: string;
  name: string;
  ssid: string | null;
  roster_ps_id: string | null;
  tools: PreviewTool[];
  /** On the record, switched off by an exception on this assessment. */
  removed_by_exception: string[];
  /** On the record, not allowed on this assessment. */
  not_allowed: ToolSetting[];
}

export interface AccommodationsPreview {
  students: PreviewStudent[];
  others_count: number | null;
}

export async function buildAccommodationsPreview(
  db: Db,
  assessment: AssessmentRow,
): Promise<AccommodationsPreview> {
  // U-17: co-teachers (D-2) whose records count for the children they
  // currently teach (13.1).
  const coEmails = await coTeacherEmailsFor(db, assessment);

  const people = await db
    .select({
      id: students.id,
      name: students.name,
      ssid: students.ssid,
      roster_ps_id: students.roster_ps_id,
      owner_sub: students.owner_sub,
      owner_email: students.owner_email,
    })
    .from(students)
    .where(
      and(
        isNull(students.practice_for_sub),
        coEmails.length > 0
          ? or(
              eq(students.owner_sub, assessment.owner_sub),
              and(inArray(students.owner_email, coEmails), ne(students.owner_sub, assessment.owner_sub)),
            )
          : eq(students.owner_sub, assessment.owner_sub),
      ),
    );

  // A co-teacher's TIDE row is bound by SSID until the child joins one of
  // their own tests — tie it to the roster id through the roster's SSID.
  const unboundSsids = [
    ...new Set(
      people
        .filter((p) => p.owner_sub !== assessment.owner_sub && !p.roster_ps_id && p.ssid)
        .map((p) => p.ssid!),
    ),
  ];
  const psIdBySsid = new Map<string, string>();
  if (unboundSsids.length > 0) {
    const rows = await db
      .select({ ps_id: roster_students.ps_id, ssid: roster_students.ssid })
      .from(roster_students)
      .where(inArray(roster_students.ssid, unboundSsids));
    for (const r of rows) if (r.ssid) psIdBySsid.set(r.ssid, r.ps_id);
  }

  // One entry per child: the owner's row (if any) and the co-teachers' rows.
  type Person = (typeof people)[number];
  const children = new Map<string, { owner: Person | null; co: Person[]; psId: string | null }>();
  for (const p of people) {
    if (p.owner_sub === assessment.owner_sub) {
      const key = p.roster_ps_id ?? `row:${p.id}`;
      const entry = children.get(key) ?? { owner: null, co: [], psId: p.roster_ps_id };
      entry.owner = p;
      children.set(key, entry);
    } else {
      const psId = p.roster_ps_id ?? (p.ssid ? psIdBySsid.get(p.ssid) : undefined);
      if (!psId) continue; // cannot be tied to a child
      const entry = children.get(psId) ?? { owner: null, co: [], psId };
      entry.co.push(p);
      children.set(psId, entry);
    }
  }

  const psIds = [...children.values()].map((c) => c.psId).filter((x): x is string => !!x);
  const teaching = await teachersCurrentlyTeaching(db, coEmails, psIds);

  const ids = people.map((p) => p.id);
  const records =
    ids.length === 0
      ? []
      : await db
          .select({
            student_id: student_accommodations.student_id,
            tool_id: student_accommodations.tool_id,
            value: student_accommodations.value,
          })
          .from(student_accommodations)
          .where(and(inArray(student_accommodations.student_id, ids), isNull(student_accommodations.removed_at)));
  const overrides = await db
    .select({
      student_id: assessment_student_overrides.student_id,
      tool_id: assessment_student_overrides.tool_id,
      value: assessment_student_overrides.value,
    })
    .from(assessment_student_overrides)
    .where(eq(assessment_student_overrides.assessment_id, assessment.id));
  const recordsBy = groupBy(records);
  const overridesBy = groupBy(overrides);

  const listed: PreviewStudent[] = [];
  for (const child of children.values()) {
    const teachers = child.psId ? (teaching.get(child.psId) ?? new Set<string>()) : new Set<string>();
    const co = child.co
      .filter((p) => p.owner_email && teachers.has(p.owner_email))
      .sort((a, b) => (a.owner_email ?? "").localeCompare(b.owner_email ?? ""));
    if (!child.owner && co.length === 0) continue;

    const ownerRecords = child.owner ? (recordsBy.get(child.owner.id) ?? []) : [];
    const coRecords = co.map((p) => ({ email: p.owner_email!, rows: recordsBy.get(p.id) ?? [] }));
    const explained = explainAccommodations(
      assessment,
      [...ownerRecords, ...coRecords.flatMap((c) => c.rows)],
      child.owner ? (overridesBy.get(child.owner.id) ?? []) : [],
    );
    const granted = new Set(explained.grantedByException);
    const altering = new Set(explained.constructAltering);
    const ownerOn = new Set(ownerRecords.filter((r) => isEnabledValue(r.value)).map((r) => r.tool_id));
    const sourceOf = (toolId: string): string | null => {
      if (granted.has(toolId) || ownerOn.has(toolId)) return null;
      return coRecords.find((c) => c.rows.some((r) => r.tool_id === toolId && isEnabledValue(r.value)))?.email ?? null;
    };
    const tools = Object.entries(explained.enabled)
      .map(([tool_id, value]) => ({
        tool_id,
        value,
        exception: granted.has(tool_id),
        construct_altering: altering.has(tool_id),
        from_record_of: sourceOf(tool_id),
      }))
      .sort((a, b) => a.tool_id.localeCompare(b.tool_id));
    if (tools.length === 0 && explained.removedByException.length === 0 && explained.notAllowed.length === 0) {
      continue; // every tool Off — nothing to say
    }
    const face = child.owner ?? co[0]!;
    listed.push({
      student_id: face.id,
      name: face.name,
      ssid: face.ssid,
      roster_ps_id: child.psId,
      tools,
      removed_by_exception: [...explained.removedByException].sort(),
      not_allowed: [...explained.notAllowed].sort((a, b) => a.tool_id.localeCompare(b.tool_id)),
    });
  }
  listed.sort((a, b) => a.name.localeCompare(b.name) || (a.ssid ?? "").localeCompare(b.ssid ?? ""));

  const { ownerEmail } = await assessmentOwner(db, assessment.id);
  let othersCount: number | null = null;
  if (ownerEmail) {
    const classList = new Set(
      (await studentsInTeachersSections(db, ownerEmail)).map((r) => r.student.ps_id),
    );
    const getting = new Set(
      listed.filter((s) => s.tools.length > 0 && s.roster_ps_id).map((s) => s.roster_ps_id!),
    );
    othersCount = [...classList].filter((psId) => !getting.has(psId)).length;
  }

  return { students: listed, others_count: othersCount };
}

function groupBy<T extends { student_id: string }>(rows: T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const list = out.get(row.student_id);
    if (list) list.push(row);
    else out.set(row.student_id, [row]);
  }
  return out;
}

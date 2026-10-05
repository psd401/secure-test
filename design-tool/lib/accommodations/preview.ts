import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  assessment_student_overrides,
  student_accommodations,
  students,
  type AssessmentRow,
} from "@/db/schema";
import type { getDb } from "@/db/client";
import { explainAccommodations, type ToolSetting } from "@/lib/accommodations/effective";
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
 * Not modelled: delivery's co-teacher fallback (an owner row with NO live
 * records reads the co-teacher's when the attempt came through their sitting)
 * — it depends on the attempt. U-17 replaces that fallback.
 */
export interface PreviewTool {
  tool_id: string;
  value: string;
  /** Turned on by an exception rather than the record. */
  exception: boolean;
  construct_altering: boolean;
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
  const records = await db
    .select({
      student_id: student_accommodations.student_id,
      tool_id: student_accommodations.tool_id,
      value: student_accommodations.value,
    })
    .from(student_accommodations)
    .innerJoin(students, eq(students.id, student_accommodations.student_id))
    .where(
      and(
        eq(students.owner_sub, assessment.owner_sub),
        isNull(students.practice_for_sub),
        isNull(student_accommodations.removed_at),
      ),
    );
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
  const ids = [...new Set([...recordsBy.keys(), ...overridesBy.keys()])];
  const people =
    ids.length === 0
      ? []
      : await db
          .select({
            id: students.id,
            name: students.name,
            ssid: students.ssid,
            roster_ps_id: students.roster_ps_id,
            owner_sub: students.owner_sub,
          })
          .from(students)
          .where(inArray(students.id, ids));

  const listed: PreviewStudent[] = [];
  for (const person of people) {
    // An override row always hangs off the owner's overlay in practice; the
    // check keeps a stray foreign row out of the owner's preview.
    if (person.owner_sub !== assessment.owner_sub) continue;
    const explained = explainAccommodations(
      assessment,
      recordsBy.get(person.id) ?? [],
      overridesBy.get(person.id) ?? [],
    );
    const granted = new Set(explained.grantedByException);
    const altering = new Set(explained.constructAltering);
    const tools = Object.entries(explained.enabled)
      .map(([tool_id, value]) => ({
        tool_id,
        value,
        exception: granted.has(tool_id),
        construct_altering: altering.has(tool_id),
      }))
      .sort((a, b) => a.tool_id.localeCompare(b.tool_id));
    if (tools.length === 0 && explained.removedByException.length === 0 && explained.notAllowed.length === 0) {
      continue; // a record of every tool Off — nothing to say
    }
    listed.push({
      student_id: person.id,
      name: person.name,
      ssid: person.ssid,
      roster_ps_id: person.roster_ps_id,
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

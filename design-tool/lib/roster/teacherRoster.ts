// Slice 79 (ADR 0017): a teacher's roster is the sections they teach.
//
// Two tables, two jobs, joined here for the page:
//
//   roster_*   — who is in the teacher's sections TODAY (the warehouse).
//   students   — the teacher's accommodations overlay: rows TIDE imported or
//                the teacher typed, plus rows created when a student first
//                joined a sitting (slice 78). The source-of-truth rule for
//                accommodations is unchanged (CLAUDE.md): TIDE per bundle,
//                then teacher edits, then manual entry.
//
// A roster student is matched to their overlay row by roster_ps_id once bound,
// or by SSID before that (a TIDE row the child has not joined from yet).
// Overlay rows that match nobody in the current sections are still listed —
// a TIDE import covers the school, not one teacher's timetable, and a
// manually-entered student may be a legitimate exception — under their own
// heading, so the page never hides an accommodation the teacher entered.
// Rows that arrived through a co-teacher's sitting on this teacher's
// assessment are split out of that heading and grouped by the co-teacher's
// section (co-teacher follow-ups, 2026-09-22; `splitCoTaught` below).

import { and, asc, desc, eq, inArray, isNull, ne } from "drizzle-orm";
import {
  assessments,
  attempts,
  roster_sections,
  student_accommodations,
  students,
  test_sessions,
  type RosterSectionRow,
  type RosterStudentRow,
} from "@/db/schema";
import type { getDb } from "@/db/client";
import { ACCOMMODATION_CATALOG } from "@/lib/accommodations/catalog";
import { isEnabledValue } from "@/lib/accommodations/effective";
import { normalizeEmail, studentsInTeachersSections } from "./queries";

const OSPI_TIER_BY_ID = new Map(ACCOMMODATION_CATALOG.map((e) => [e.id, e.ospi_tier] as const));

type Db = ReturnType<typeof getDb>;

export interface OverlayInfo {
  id: string;
  ssid: string | null;
  roster_ps_id: string | null;
  name: string;
  grade: string | null;
  school: string | null;
  /** Every live row, On or Off (what the API's student list also reports). */
  accommodation_count: number;
  /** UX pass 1, slice 8 (ACC-02): only rows whose value turns the tool ON. */
  enabled_count: number;
  /** Enabled rows on OSPI "accommodation"-tier tools — the IEP/504 signal (ACC-03). */
  iep_count: number;
}

export interface RosterStudentView {
  roster: RosterStudentRow;
  overlay: OverlayInfo | null;
}

export interface RosterSectionView {
  section: RosterSectionRow;
  students: RosterStudentView[];
}

/**
 * Co-teacher follow-ups, 2026-09-22 (docs/access-model-design.md §Progress):
 * since the co-teacher tenant fix, a student who joins a CO-TEACHER's class
 * sitting on this teacher's assessment gets an overlay row under THIS
 * teacher — from a section they do not teach. Grouped by the section that
 * sitting named and the co-teacher who ran it, so the page can say where the
 * row came from instead of filing it under "not in your sections".
 */
export interface CoTaughtGroup {
  /** The roster section the sitting named; null when it named none (a
   * student-list sitting) or the section has left the mirror. */
  section: RosterSectionRow | null;
  sectionPsId: string | null;
  /** The sitting's owner — the co-teacher (access D-5). */
  coTeacherEmail: string | null;
  students: OverlayInfo[];
}

export interface TeacherRoster {
  /** Null when the session carries no email — nothing to look up by. */
  teacherEmail: string | null;
  sections: RosterSectionView[];
  /** Overlay rows outside the current sections that joined through a
   * co-teacher's sitting on one of this teacher's assessments. */
  coTaught: CoTaughtGroup[];
  /** Overlay rows not matched to anyone in the current sections, and not
   * co-taught. */
  unlinked: OverlayInfo[];
}

/** The teacher's accommodations overlay with live counts. Aggregated in JS
 * rather than SQL because "enabled" (lib/accommodations/effective.ts) and the
 * OSPI tier (the catalog) are application rules, not columns. */
export async function loadOverlay(db: Db, ownerSub: string): Promise<OverlayInfo[]> {
  const rows = await db
    .select({
      id: students.id,
      ssid: students.ssid,
      roster_ps_id: students.roster_ps_id,
      name: students.name,
      grade: students.grade,
      school: students.school,
      tool_id: student_accommodations.tool_id,
      value: student_accommodations.value,
      removed_at: student_accommodations.removed_at,
    })
    .from(students)
    .leftJoin(student_accommodations, eq(student_accommodations.student_id, students.id))
    // Practice (docs/practice-sitting-design.md, D-4): the practice overlay
    // row is a staff member, never a student on the Students page.
    .where(and(eq(students.owner_sub, ownerSub), isNull(students.practice_for_sub)))
    .orderBy(asc(students.ssid), asc(students.id));
  const byId = new Map<string, OverlayInfo>();
  for (const r of rows) {
    let o = byId.get(r.id);
    if (!o) {
      o = {
        id: r.id,
        ssid: r.ssid,
        roster_ps_id: r.roster_ps_id,
        name: r.name,
        grade: r.grade,
        school: r.school,
        accommodation_count: 0,
        enabled_count: 0,
        iep_count: 0,
      };
      byId.set(r.id, o);
    }
    if (r.tool_id === null || r.removed_at !== null) continue;
    o.accommodation_count += 1;
    if (isEnabledValue(r.value ?? "")) {
      o.enabled_count += 1;
      if (OSPI_TIER_BY_ID.get(r.tool_id) === "accommodation") o.iep_count += 1;
    }
  }
  return [...byId.values()];
}

/**
 * Splits overlay rows the current sections did not match into co-taught
 * groups and the rest. A row is co-taught when its student has a class
 * (non-practice) attempt on one of `ownerSub`'s assessments through a class
 * sitting whose `owner_sub` is someone else — the only way a join writes a
 * row under an owner from another teacher's sitting (the co-teacher tenant
 * fix, `sittingTenantSub`). The student's NEWEST such sitting decides the
 * group. Presentation only: which rows exist is unchanged.
 */
async function splitCoTaught(
  db: Db,
  ownerSub: string,
  rest: OverlayInfo[],
): Promise<{ coTaught: CoTaughtGroup[]; unlinked: OverlayInfo[] }> {
  if (rest.length === 0) return { coTaught: [], unlinked: [] };
  const links = await db
    .select({
      student_id: attempts.student_id,
      section_ps_id: test_sessions.section_ps_id,
      owner_email: test_sessions.owner_email,
    })
    .from(attempts)
    .innerJoin(assessments, eq(assessments.id, attempts.assessment_id))
    .innerJoin(test_sessions, eq(test_sessions.id, attempts.test_session_id))
    .where(
      and(
        inArray(
          attempts.student_id,
          rest.map((o) => o.id),
        ),
        eq(attempts.practice, false),
        eq(assessments.owner_sub, ownerSub),
        eq(test_sessions.kind, "class"),
        ne(test_sessions.owner_sub, ownerSub),
      ),
    )
    .orderBy(desc(test_sessions.created_at), desc(test_sessions.id));
  const newest = new Map<string, (typeof links)[number]>();
  for (const l of links) if (!newest.has(l.student_id)) newest.set(l.student_id, l);
  if (newest.size === 0) return { coTaught: [], unlinked: rest };

  const psIds = [
    ...new Set([...newest.values()].map((l) => l.section_ps_id).filter((v): v is string => !!v)),
  ];
  const sectionRows =
    psIds.length > 0
      ? await db.select().from(roster_sections).where(inArray(roster_sections.ps_id, psIds))
      : [];
  const sectionByPsId = new Map(sectionRows.map((r) => [r.ps_id, r]));

  const groups = new Map<string, CoTaughtGroup>();
  const unlinked: OverlayInfo[] = [];
  for (const o of rest) {
    const l = newest.get(o.id);
    if (!l) {
      unlinked.push(o);
      continue;
    }
    const key = `${l.section_ps_id ?? ""}\u0000${l.owner_email ?? ""}`;
    const group = groups.get(key) ?? {
      section: l.section_ps_id ? (sectionByPsId.get(l.section_ps_id) ?? null) : null,
      sectionPsId: l.section_ps_id,
      coTeacherEmail: l.owner_email,
      students: [],
    };
    group.students.push(o);
    groups.set(key, group);
  }
  return { coTaught: [...groups.values()], unlinked };
}

export async function teacherRoster(
  db: Db,
  ownerSub: string,
  sessionEmail: string | null | undefined,
): Promise<TeacherRoster> {
  const overlay = await loadOverlay(db, ownerSub);
  const teacherEmail = normalizeEmail(sessionEmail);
  if (!teacherEmail) return { teacherEmail: null, sections: [], ...(await splitCoTaught(db, ownerSub, overlay)) };

  const byPsId = new Map<string, OverlayInfo>();
  const bySsid = new Map<string, OverlayInfo>();
  for (const o of overlay) {
    if (o.roster_ps_id) byPsId.set(o.roster_ps_id, o);
    // A bound row is reachable by ps_id; only unbound rows are candidates
    // for the SSID fallback, so a stale SSID never shadows a real binding.
    if (o.ssid && !o.roster_ps_id) bySsid.set(o.ssid, o);
  }

  const matched = new Set<string>();
  const sections = new Map<string, RosterSectionView>();
  for (const { student, section } of await studentsInTeachersSections(db, teacherEmail)) {
    const view = sections.get(section.ps_id) ?? { section, students: [] };
    const o =
      byPsId.get(student.ps_id) ?? (student.ssid ? bySsid.get(student.ssid) : undefined) ?? null;
    if (o) matched.add(o.id);
    view.students.push({ roster: student, overlay: o });
    sections.set(section.ps_id, view);
  }

  return {
    teacherEmail,
    sections: [...sections.values()],
    ...(await splitCoTaught(
      db,
      ownerSub,
      overlay.filter((o) => !matched.has(o.id)),
    )),
  };
}

export function sectionLabel(section: RosterSectionRow): string {
  const name = section.course_name || section.course_code || `Section ${section.ps_id}`;
  return section.period_expression ? `${name} · ${section.period_expression}` : name;
}

export function studentDisplayName(student: RosterStudentRow): string {
  return `${student.last_name}, ${student.first_name}`.replace(/^, |, $/, "").trim() || student.ps_id;
}

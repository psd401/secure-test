// Slice 82: who a sitting expects, and who has actually joined or submitted.
//
// "Expected" is the sitting's scope resolved against the roster right now —
// the same three shapes redeem admits (all of the owner's sections, one
// section, an explicit list). "Joined" is the attempts that name this sitting,
// bridged back to roster ps_ids through the accommodations overlay
// (`students.roster_ps_id`, bound on first admitted join — slice 78).
//
// The two are joined loosely on purpose: a scope is evaluated live, so a
// student who joined and then left the section, or who was admitted by an
// explicit list that no longer names them, still shows up — flagged as out of
// scope rather than dropped, because a teacher looking at attendance wants
// the whole room, not the subset that still matches.
import { asc, count, eq, inArray, max } from "drizzle-orm";
import {
  ALERT_EVENT_KINDS,
  attempt_events,
  attempts,
  items,
  responses,
  roster_students,
  students,
  type AttemptEventKind,
  type RosterSectionRow,
  type RosterStudentRow,
  type TestSessionRow,
} from "@/db/schema";
import type { getDb } from "@/db/client";
import { studentsInTeachersSections } from "@/lib/roster/queries";
import { sectionLabel, studentDisplayName } from "@/lib/roster/teacherRoster";

type Db = ReturnType<typeof getDb>;

export type AttendanceStatus = "not_joined" | "in_progress" | "submitted";

export interface AttendanceEvent {
  kind: AttemptEventKind;
  at: Date;
}

export interface AttendanceRow {
  /** Roster ps_id, or the overlay row id when the attempt has no roster binding. */
  ps_id: string;
  name: string;
  section_label: string | null;
  status: AttendanceStatus;
  started_at: Date | null;
  submitted_at: Date | null;
  /** Slice 85: items with a saved response, out of the assessment's items. */
  answered: number;
  total_items: number;
  /** Slice 85: the latest of started, any response save, and submitted; null when not joined. */
  last_activity_at: Date | null;
  /** False for an attempt whose student is not in the sitting's scope today. */
  in_scope: boolean;
  /** Peek P3: what the monitor's Peek button posts against; null until joined. */
  attempt_id: string | null;
  /** Slice 91: the newest client-reported event, whatever its kind. */
  last_event: AttendanceEvent | null;
  /** UX pass 2 slice 4 (P2-7): the newest lockdown_begin, so the presentation
   * can demote an alert that a rejoin postdates even when focus flickered
   * after it (the newest event alone can't tell). */
  last_lockdown_begin_at: Date | null;
  /** Slice 91: the newest still-active alert event, or null when calm — see
   * `activeAlert` for what "active" means per kind. */
  alert: AttendanceEvent | null;
}

export interface Attendance {
  rows: AttendanceRow[];
  counts: { expected: number; joined: number; submitted: number };
  /** Slice 85: the newest last_activity_at across rows — a poller's change cursor. */
  updated_at: Date | null;
  total_items: number;
}

export type SittingScopeRow = Pick<
  TestSessionRow,
  "id" | "assessment_id" | "owner_email" | "section_ps_id" | "student_ps_ids"
>;

interface Expected {
  student: RosterStudentRow;
  sections: RosterSectionRow[];
}

/**
 * The students the sitting's scope admits right now, keyed by ps_id. Mirrors
 * `isAdmittedToSitting`: an explicit list is exactly that list (whether or
 * not they are still in the owner's sections); otherwise it is the owner's
 * current sections, narrowed to one when the sitting names one.
 */
export async function expectedStudents(
  db: Db,
  sitting: SittingScopeRow,
): Promise<Map<string, Expected>> {
  const byPsId = new Map<string, Expected>();
  const ownerEmail = sitting.owner_email;
  if (!ownerEmail && !sitting.student_ps_ids) return byPsId;

  if (ownerEmail) {
    const rows = await studentsInTeachersSections(db, ownerEmail, sitting.section_ps_id);
    for (const { student, section } of rows) {
      const entry = byPsId.get(student.ps_id);
      if (entry) entry.sections.push(section);
      else byPsId.set(student.ps_id, { student, sections: [section] });
    }
  }

  if (sitting.student_ps_ids) {
    const listed = new Set(sitting.student_ps_ids);
    for (const psId of [...byPsId.keys()]) {
      if (!listed.has(psId)) byPsId.delete(psId);
    }
    const missing = sitting.student_ps_ids.filter((id) => !byPsId.has(id));
    if (missing.length > 0) {
      const rows = await db
        .select()
        .from(roster_students)
        .where(inArray(roster_students.ps_id, missing));
      for (const student of rows) byPsId.set(student.ps_id, { student, sections: [] });
    }
  }
  return byPsId;
}

/**
 * Slice 91: the newest event that should still be raising a flag, or null.
 *
 * Decided with James (2026-08-27): alerts are sticky per kind — a quit, an
 * emergency exit, or a broken lockdown stays an alert for the attempt's
 * lifetime, because nothing that happens later un-happens it. `focus_loss` is
 * the exception: a later `focus_regained` clears it, so a student who tabbed
 * away and came back shows history but no active alert.
 */
export function activeAlert(events: AttendanceEvent[]): AttendanceEvent | null {
  const sticky = new Set<string>(ALERT_EVENT_KINDS.filter((k) => k !== "focus_loss"));
  let regained = false;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.kind === "focus_regained") regained = true;
    if (sticky.has(e.kind)) return e;
    if (e.kind === "focus_loss" && !regained) return e;
  }
  return null;
}

export async function attendanceForSitting(
  db: Db,
  sitting: SittingScopeRow,
): Promise<Attendance> {
  const expected = await expectedStudents(db, sitting);

  const joined = await db
    .select({ attempt: attempts, student: students })
    .from(attempts)
    .innerJoin(students, eq(students.id, attempts.student_id))
    .where(eq(attempts.test_session_id, sitting.id));

  const byKey = new Map<string, (typeof joined)[number]>();
  for (const row of joined) {
    // One attempt per (student, sitting) is enforced by the attempt routes;
    // if two ever exist, the later one wins the display.
    byKey.set(row.student.roster_ps_id ?? row.student.id, row);
  }

  // Slice 85: progress. Every saved response is one answered item (the
  // responses route upserts per item, so count == distinct items), and its
  // updated_at is the student's last keystroke the server knows about.
  const totalRows = await db
    .select({ total_items: count() })
    .from(items)
    .where(eq(items.assessment_id, sitting.assessment_id));
  const total_items = totalRows[0]?.total_items ?? 0;
  const progress = new Map<string, { answered: number; last: Date | null }>();
  if (joined.length > 0) {
    const rows = await db
      .select({
        attempt_id: responses.attempt_id,
        answered: count(),
        last: max(responses.updated_at),
      })
      .from(responses)
      .where(inArray(responses.attempt_id, joined.map((j) => j.attempt.id)))
      .groupBy(responses.attempt_id);
    for (const r of rows) progress.set(r.attempt_id, { answered: r.answered, last: r.last });
  }
  // Slice 91: client-reported events, oldest first (id breaks same-timestamp
  // ties, since rows are only ever appended). Small by construction — one
  // room's attempts, and the client reports state changes, not a stream.
  const eventsByAttempt = new Map<string, AttendanceEvent[]>();
  if (joined.length > 0) {
    const rows = await db
      .select({
        attempt_id: attempt_events.attempt_id,
        kind: attempt_events.kind,
        at: attempt_events.at,
      })
      .from(attempt_events)
      .where(inArray(attempt_events.attempt_id, joined.map((j) => j.attempt.id)))
      .orderBy(asc(attempt_events.at), asc(attempt_events.id));
    for (const r of rows) {
      const list = eventsByAttempt.get(r.attempt_id) ?? [];
      list.push({ kind: r.kind as AttemptEventKind, at: r.at });
      eventsByAttempt.set(r.attempt_id, list);
    }
  }

  const activity = (hit: (typeof joined)[number]) => {
    const p = progress.get(hit.attempt.id);
    const candidates = [hit.attempt.started_at, hit.attempt.submitted_at, p?.last ?? null].filter(
      (d): d is Date => d instanceof Date,
    );
    return {
      answered: p?.answered ?? 0,
      last_activity_at: candidates.length ? new Date(Math.max(...candidates.map((d) => d.getTime()))) : null,
    };
  };

  const events = (hit: (typeof joined)[number]) => {
    const list = eventsByAttempt.get(hit.attempt.id) ?? [];
    let last_lockdown_begin_at: Date | null = null;
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i]!.kind === "lockdown_begin") {
        last_lockdown_begin_at = list[i]!.at;
        break;
      }
    }
    return {
      last_event: list.length ? list[list.length - 1]! : null,
      alert: activeAlert(list),
      last_lockdown_begin_at,
    };
  };

  const rows: AttendanceRow[] = [];
  for (const [psId, { student, sections }] of expected) {
    const hit = byKey.get(psId);
    byKey.delete(psId);
    rows.push({
      ps_id: psId,
      name: studentDisplayName(student),
      section_label: sections[0] ? sectionLabel(sections[0]) : null,
      status: hit ? (hit.attempt.status as AttendanceStatus) : "not_joined",
      started_at: hit?.attempt.started_at ?? null,
      submitted_at: hit?.attempt.submitted_at ?? null,
      answered: hit ? activity(hit).answered : 0,
      total_items,
      last_activity_at: hit ? activity(hit).last_activity_at : null,
      in_scope: true,
      attempt_id: hit?.attempt.id ?? null,
      last_event: hit ? events(hit).last_event : null,
      alert: hit ? events(hit).alert : null,
      last_lockdown_begin_at: hit ? events(hit).last_lockdown_begin_at : null,
    });
  }
  for (const [key, hit] of byKey) {
    rows.push({
      ps_id: key,
      name: hit.student.name || key,
      section_label: null,
      status: hit.attempt.status as AttendanceStatus,
      started_at: hit.attempt.started_at,
      submitted_at: hit.attempt.submitted_at,
      answered: activity(hit).answered,
      total_items,
      last_activity_at: activity(hit).last_activity_at,
      in_scope: false,
      attempt_id: hit.attempt.id,
      last_event: events(hit).last_event,
      alert: events(hit).alert,
      last_lockdown_begin_at: events(hit).last_lockdown_begin_at,
    });
  }
  rows.sort((a, b) => a.name.localeCompare(b.name));

  return {
    rows,
    counts: {
      expected: expected.size,
      joined: rows.filter((r) => r.status !== "not_joined").length,
      submitted: rows.filter((r) => r.status === "submitted").length,
    },
    updated_at: rows.reduce<Date | null>(
      (acc, r) => (r.last_activity_at && (!acc || r.last_activity_at > acc) ? r.last_activity_at : acc),
      null,
    ),
    total_items,
  };
}

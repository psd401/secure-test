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
import { and, asc, count, eq, inArray, max } from "drizzle-orm";
import {
  ALERT_EVENT_KINDS,
  assessments,
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
import { attemptIsTimed, deadlineFor, isPastDeadline } from "@/lib/api/attemptDeadline";
import { studentsInTeachersSections } from "@/lib/roster/queries";
import { sectionLabel, studentDisplayName } from "@/lib/roster/teacherRoster";

type Db = ReturnType<typeof getDb>;

/**
 * Finding H-1 (2026-09-17): `submitted_earlier` is not an attempt state — it
 * is "this student has no attempt on THIS sitting, but they already handed
 * this assessment in through an earlier one". The join route would give them
 * back that submitted attempt rather than a fresh one (one attempt per
 * student per assessment), so a teacher watching today's room needs to see
 * why the student cannot join instead of an unexplained "Not joined".
 */
export type AttendanceStatus =
  "not_joined" | "in_progress" | "submitted" | "submitted_earlier";

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
  /** Start of the attempt behind `attempt_id` — including the earlier
   * sitting's attempt on a `submitted_earlier` row (H-1). */
  started_at: Date | null;
  /** T-2 (docs/time-limit-and-unfinished-attempts-design.md, hand-run
   * 2026-09-14): true only for a joined, still-in-progress row whose own
   * deadline plus its grace has passed — the same `deadlineFor` /
   * `isPastDeadline` the hand-in route uses, so the monitor's Hand in button
   * enables on exactly what the route accepts. False for `not_joined`, for
   * submitted rows, and for an assessment with no time limit. Also false on a
   * `submitted_earlier` row — that attempt is handed in, and it is not this
   * sitting's to act on (H-1). */
  deadline_passed: boolean;
  /** The EFFECTIVE deadline for a joined, still-in-progress attempt — the
   * teacher's `deadline_override_at` when one was granted, else `started_at +
   * time_limit_seconds`. A `Date` like every other instant on this row (the
   * route serialises the payload, so the browser mirror in
   * `app/dashboard/[id]/attendanceView.ts` types it as the ISO string). Null
   * when there is no limit and no extension, on submitted rows, on
   * `not_joined`, and on `submitted_earlier` — whose attempt is not this
   * sitting's to act on. */
  deadline_at: Date | null;
  submitted_at: Date | null;
  /** Slice 85: items with a saved response, out of the assessment's items.
   * On a `submitted_earlier` row this counts the earlier attempt's responses. */
  answered: number;
  total_items: number;
  /** Slice 85: the latest of started, any response save, and submitted; null
   * when not joined — and null on a `submitted_earlier` row, which has had no
   * activity in THIS sitting (H-1). */
  last_activity_at: Date | null;
  /** False for an attempt whose student is not in the sitting's scope today. */
  in_scope: boolean;
  /** Peek P3: what the monitor's Peek button posts against; null until joined.
   * On a `submitted_earlier` row this is the EARLIER sitting's attempt — the
   * monitor offers no per-attempt action on it (H-1). */
  attempt_id: string | null;
  /** Pass back (docs/pass-back-design.md): whether THIS row's attempt needs a
   * new deadline before it can be passed back — the same test the route
   * applies (`(assessment.time_limit_seconds ?? 0) > 0 ||
   * attempt.deadline_override_at !== null`). False on `not_joined`, where
   * there is no attempt to pass back at all. */
  timed: boolean;
  /** PB-4 (2026-09-22): a `not_joined` row whose student's attempt on this
   * assessment was passed back and is waiting for them to rejoin — the join
   * route rebinds it to this sitting, so the row stays `not_joined` until
   * they do, but the teacher is told what to expect. False otherwise. */
  passed_back_waiting: boolean;
  /** Remove time limit (2026-09-24): this row's in-progress attempt has "No
   * time limit" — the Monitor says so where it would otherwise show the
   * deadline. False on every other row, submitted ones included. */
  time_limit_removed: boolean;
  /** Slice 91: the newest client-reported event, whatever its kind. Null on a
   * `submitted_earlier` row: its events belong to the earlier sitting. */
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
  counts: {
    expected: number;
    joined: number;
    submitted: number;
    submitted_earlier: number;
  };
  /** Slice 85: the newest last_activity_at across rows — a poller's change cursor. */
  updated_at: Date | null;
  total_items: number;
}

export type SittingScopeRow = Pick<
  TestSessionRow,
  "id" | "assessment_id" | "owner_email" | "section_ps_id" | "student_ps_ids"
> &
  // Practice sittings (docs/practice-sitting-design.md, D-5). Absent = class.
  Partial<Pick<TestSessionRow, "kind" | "practice_for_sub">>;

/** D-5: the Monitor's one row on a practice sitting. */
export const PRACTICE_ROW_NAME = "You (practice)";

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
    const rows = await studentsInTeachersSections(
      db,
      ownerEmail,
      sitting.section_ps_id,
    );
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
      for (const student of rows)
        byPsId.set(student.ps_id, { student, sections: [] });
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
  const sticky = new Set<string>(
    ALERT_EVENT_KINDS.filter((k) => k !== "focus_loss"),
  );
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
  // Practice (docs/practice-sitting-design.md, D-4/D-5): a practice sitting
  // expects no roster student — its owner's sections are not its scope — and
  // shows only its own practice attempt; a class sitting never shows one.
  const practice = sitting.kind === "practice";
  const expected = practice
    ? new Map<string, Expected>()
    : await expectedStudents(db, sitting);

  const joined = await db
    .select({ attempt: attempts, student: students })
    .from(attempts)
    .innerJoin(students, eq(students.id, attempts.student_id))
    .where(and(eq(attempts.test_session_id, sitting.id), eq(attempts.practice, practice)));

  const byKey = new Map<string, (typeof joined)[number]>();
  for (const row of joined) {
    // One attempt per (student, sitting) is enforced by the attempt routes;
    // if two ever exist, the later one wins the display.
    byKey.set(row.student.roster_ps_id ?? row.student.id, row);
  }

  // H-1 (2026-09-17): the expected students with NO attempt on this sitting
  // who nonetheless already handed this assessment in through an earlier one.
  // One extra query over exactly that set, and only when it is non-empty.
  // Only a `submitted` attempt makes the row `submitted_earlier`: a student
  // whose other attempt is still in progress CAN join today (the join route
  // rebinds an in-progress attempt to the new sitting), so they stay
  // `not_joined` — PB-4 only adds a note when that attempt was passed back.
  const notJoinedPsIds = [...expected.keys()].filter(
    (psId) => !byKey.has(psId),
  );
  const earlierByPsId = new Map<string, (typeof joined)[number]>();
  const passedBackWaiting = new Set<string>();
  if (notJoinedPsIds.length > 0) {
    const rows = await db
      .select({ attempt: attempts, student: students })
      .from(attempts)
      .innerJoin(students, eq(students.id, attempts.student_id))
      .where(
        and(
          eq(attempts.assessment_id, sitting.assessment_id),
          inArray(attempts.status, ["submitted", "in_progress"]),
          // D-4: never a practice attempt (its overlay has no roster_ps_id,
          // so this holds by construction as well).
          eq(attempts.practice, false),
          inArray(students.roster_ps_id, notJoinedPsIds),
        ),
      )
      .orderBy(asc(attempts.submitted_at));
    // One attempt per (student, assessment) is enforced by a unique index, so
    // there can only be one; ordering oldest-first means the newest wins if
    // that ever changes.
    for (const row of rows) {
      const psId = row.student.roster_ps_id;
      if (!psId) continue;
      if (row.attempt.status === "submitted") earlierByPsId.set(psId, row);
      else if (row.attempt.pass_back_count > 0) passedBackWaiting.add(psId);
    }
  }

  // Slice 85: progress. Every saved response is one answered item (the
  // responses route upserts per item, so count == distinct items), and its
  // updated_at is the student's last keystroke the server knows about.
  const totalRows = await db
    .select({ total_items: count() })
    .from(items)
    .where(eq(items.assessment_id, sitting.assessment_id));
  const total_items = totalRows[0]?.total_items ?? 0;

  // T-2: the assessment's time limit, read once — the deadline is per attempt
  // (`started_at + limit`), the limit is per assessment.
  const [assessmentRow] = await db
    .select({ time_limit_seconds: assessments.time_limit_seconds })
    .from(assessments)
    .where(eq(assessments.id, sitting.assessment_id))
    .limit(1);
  const timeLimit = {
    time_limit_seconds: assessmentRow?.time_limit_seconds ?? null,
  };
  const now = new Date();
  const deadlineOf = (hit: (typeof joined)[number]) =>
    hit.attempt.status === "in_progress"
      ? deadlineFor(hit.attempt, timeLimit)
      : null;
  const deadlinePassed = (hit: (typeof joined)[number]) =>
    isPastDeadline(now, deadlineOf(hit));
  // Pass back: the same "does a deadline exist at all" question the route
  // asks directly, rather than through `deadlineFor` — a limit on the
  // assessment OR an override already on the attempt, regardless of status.
  const timedOf = (hit: (typeof joined)[number]) =>
    attemptIsTimed(hit.attempt, timeLimit);
  // Remove time limit (2026-09-24): shown only while the attempt is still in
  // progress, the same rule `deadline_at` follows.
  const removedOf = (hit: (typeof joined)[number]) =>
    hit.attempt.status === "in_progress" && hit.attempt.time_limit_removed;
  const progress = new Map<string, { answered: number; last: Date | null }>();
  // H-1: the earlier-sitting attempts ride along in the same grouped count, so
  // their `answered` costs nothing extra.
  const progressIds = [
    ...joined.map((j) => j.attempt.id),
    ...[...earlierByPsId.values()].map((e) => e.attempt.id),
  ];
  if (progressIds.length > 0) {
    const rows = await db
      .select({
        attempt_id: responses.attempt_id,
        answered: count(),
        last: max(responses.updated_at),
      })
      .from(responses)
      .where(inArray(responses.attempt_id, progressIds))
      .groupBy(responses.attempt_id);
    for (const r of rows)
      progress.set(r.attempt_id, { answered: r.answered, last: r.last });
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
      .where(
        inArray(
          attempt_events.attempt_id,
          joined.map((j) => j.attempt.id),
        ),
      )
      .orderBy(asc(attempt_events.at), asc(attempt_events.id));
    for (const r of rows) {
      const list = eventsByAttempt.get(r.attempt_id) ?? [];
      list.push({ kind: r.kind as AttemptEventKind, at: r.at });
      eventsByAttempt.set(r.attempt_id, list);
    }
  }

  const activity = (hit: (typeof joined)[number]) => {
    const p = progress.get(hit.attempt.id);
    // CS-1 (docs/roadmap-2026-09.md, 2026-09-16): a resumed student's newest
    // lockdown_begin counts as activity. Without it a student who rejoins
    // through a later sitting and reads before answering shows "Idle" for the
    // whole gap since their last save — the Monitor read "Idle 1231 min" on a
    // student who had been inside the test for a minute.
    const candidates = [
      hit.attempt.started_at,
      hit.attempt.submitted_at,
      p?.last ?? null,
      events(hit).last_lockdown_begin_at,
    ].filter((d): d is Date => d instanceof Date);
    return {
      answered: p?.answered ?? 0,
      last_activity_at: candidates.length
        ? new Date(Math.max(...candidates.map((d) => d.getTime())))
        : null,
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
    // H-1: only consulted when there is no attempt on this sitting.
    const earlier = hit ? undefined : earlierByPsId.get(psId);
    rows.push({
      ps_id: psId,
      name: studentDisplayName(student),
      section_label: sections[0] ? sectionLabel(sections[0]) : null,
      status: hit
        ? (hit.attempt.status as AttendanceStatus)
        : earlier
          ? "submitted_earlier"
          : "not_joined",
      started_at:
        hit?.attempt.started_at ?? earlier?.attempt.started_at ?? null,
      deadline_passed: hit ? deadlinePassed(hit) : false,
      deadline_at: hit ? deadlineOf(hit) : null,
      submitted_at:
        hit?.attempt.submitted_at ?? earlier?.attempt.submitted_at ?? null,
      answered: hit
        ? activity(hit).answered
        : earlier
          ? (progress.get(earlier.attempt.id)?.answered ?? 0)
          : 0,
      total_items,
      // No activity in THIS sitting, by construction.
      last_activity_at: hit ? activity(hit).last_activity_at : null,
      in_scope: true,
      attempt_id: hit?.attempt.id ?? earlier?.attempt.id ?? null,
      last_event: hit ? events(hit).last_event : null,
      alert: hit ? events(hit).alert : null,
      last_lockdown_begin_at: hit ? events(hit).last_lockdown_begin_at : null,
      timed: hit ? timedOf(hit) : earlier ? timedOf(earlier) : false,
      passed_back_waiting: !hit && passedBackWaiting.has(psId),
      time_limit_removed: hit ? removedOf(hit) : false,
    });
  }
  for (const [key, hit] of byKey) {
    rows.push({
      ps_id: key,
      name: hit.student.name || key,
      section_label: null,
      status: hit.attempt.status as AttendanceStatus,
      started_at: hit.attempt.started_at,
      deadline_passed: deadlinePassed(hit),
      deadline_at: deadlineOf(hit),
      submitted_at: hit.attempt.submitted_at,
      answered: activity(hit).answered,
      total_items,
      last_activity_at: activity(hit).last_activity_at,
      in_scope: false,
      attempt_id: hit.attempt.id,
      last_event: events(hit).last_event,
      alert: events(hit).alert,
      last_lockdown_begin_at: events(hit).last_lockdown_begin_at,
      timed: timedOf(hit),
      passed_back_waiting: false,
      time_limit_removed: removedOf(hit),
    });
  }
  rows.sort((a, b) => a.name.localeCompare(b.name));

  // D-5: a practice sitting's Monitor has exactly one expected row — the
  // practising staff member — joined or not.
  if (practice) {
    for (const row of rows) {
      row.name = PRACTICE_ROW_NAME;
      row.in_scope = true;
    }
    if (rows.length === 0) {
      rows.push({
        ps_id: sitting.practice_for_sub ?? sitting.id,
        name: PRACTICE_ROW_NAME,
        section_label: null,
        status: "not_joined",
        started_at: null,
        deadline_passed: false,
        deadline_at: null,
        submitted_at: null,
        answered: 0,
        total_items,
        last_activity_at: null,
        in_scope: true,
        attempt_id: null,
        last_event: null,
        alert: null,
        last_lockdown_begin_at: null,
        timed: false,
        passed_back_waiting: false,
        time_limit_removed: false,
      });
    }
  }

  return {
    rows,
    counts: {
      expected: practice ? 1 : expected.size,
      // H-1 (James, 2026-09-17): joined / submitted are THIS sitting's own;
      // a student who handed the assessment in through an earlier sitting is
      // counted apart, so the header can read "N of M joined · K handed in ·
      // O already handed in" instead of an unexplained "Not joined".
      joined: rows.filter(
        (r) => r.status !== "not_joined" && r.status !== "submitted_earlier",
      ).length,
      submitted: rows.filter((r) => r.status === "submitted").length,
      submitted_earlier: rows.filter((r) => r.status === "submitted_earlier")
        .length,
    },
    updated_at: rows.reduce<Date | null>(
      (acc, r) =>
        r.last_activity_at && (!acc || r.last_activity_at > acc)
          ? r.last_activity_at
          : acc,
      null,
    ),
    total_items,
  };
}

// Slices 86–87: what the Sittings tab and the monitor page share — the
// attendance payload's shape as the browser sees it, the two cadence
// constants, and the pure time helpers. No React here.
import { formatWhen } from "@/lib/ui/format";

/** Attendance re-fetch cadence while a sitting is open and on screen. */
export const LIVE_INTERVAL_MS = 5_000;
/** An in-progress student with no activity for this long is flagged idle. */
export const IDLE_AFTER_MS = 10 * 60_000;

/** Slice 91: a client-reported event as the browser sees it. */
export interface AttendanceEvent {
  kind: string;
  at: string;
}

export interface AttendanceRow {
  ps_id: string;
  name: string;
  section_label: string | null;
  /** H-1 (2026-09-17): `submitted_earlier` = no attempt on THIS sitting, but
   * this assessment was already handed in through an earlier one, so the
   * student cannot join today. `attempt_id` / `submitted_at` / `started_at` /
   * `answered` then describe that earlier attempt. */
  status: "not_joined" | "in_progress" | "submitted" | "submitted_earlier";
  started_at: string | null;
  /** T-2: the attempt's own deadline (+ grace) has passed — the hand-in
   * route's relaxation of `session_open`, so the monitor's Hand in button can
   * enable on exactly what the route accepts. */
  deadline_passed: boolean;
  /** The attempt's EFFECTIVE deadline as an ISO instant — the teacher's
   * `deadline_override_at` when one was granted, else `started_at +
   * time_limit_seconds`. Null when there is no limit and no extension (the
   * overwhelming majority), and null on a row with no attempt of its own. */
  deadline_at: string | null;
  submitted_at: string | null;
  answered: number;
  total_items: number;
  last_activity_at: string | null;
  in_scope: boolean;
  last_event: AttendanceEvent | null;
  /** UX pass 2 slice 4 (P2-7): newest lockdown_begin, for the current-alert rule. */
  last_lockdown_begin_at: string | null;
  alert: AttendanceEvent | null;
  /** Peek P3: what the monitor's Peek button posts against; null until joined. */
  attempt_id: string | null;
  /** Pass back (docs/pass-back-design.md): whether this row's attempt needs a
   * new deadline before it can be passed back. False on `not_joined`. */
  timed: boolean;
}

export interface AttendancePayload {
  test_session: {
    id: string;
    code: string;
    status: string;
    expires_at: string;
    section_ps_id: string | null;
    student_ps_ids: string[] | null;
  };
  rows: AttendanceRow[];
  counts: {
    expected: number;
    joined: number;
    submitted: number;
    submitted_earlier: number;
  };
  updated_at: string | null;
  total_items: number;
}

export function when(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : "—";
}

export function ago(iso: string | null, now: number): string {
  if (!iso) return "—";
  const secs = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  return `${Math.round(mins / 60)} h ago`;
}

/** Milliseconds idle when the row should be flagged, else null. */
export function idleFor(r: AttendanceRow, now: number): number | null {
  if (r.status !== "in_progress" || !r.last_activity_at) return null;
  const gap = now - new Date(r.last_activity_at).getTime();
  return gap >= IDLE_AFTER_MS ? gap : null;
}

export function sittingIsOpen(
  s: { status: string; expires_at: string },
  now = Date.now(),
): boolean {
  return s.status === "open" && new Date(s.expires_at).getTime() > now;
}

export function statusLabel(status: AttendanceRow["status"]): string {
  if (status === "submitted") return "Submitted";
  if (status === "in_progress") return "In progress";
  // H-1: the whole point of the row — say why they are not in today's room.
  if (status === "submitted_earlier") return "Handed in (earlier session)";
  return "Not joined";
}

/** H-1: the monitor's detail line under the badge, or null when there is
 * nothing extra to say. Pure so it can be tested without a DOM. */
export function earlierSessionNote(
  r: Pick<AttendanceRow, "status" | "submitted_at">,
): string | null {
  if (r.status !== "submitted_earlier") return null;
  return r.submitted_at
    ? `Handed in ${when(r.submitted_at)} in an earlier session`
    : "Handed in in an earlier session";
}

/** Slice 91: teacher-facing words for a client event kind. Unknown kinds
 * (a newer server than this bundle) fall back to the raw kind. */
export function eventLabel(kind: string): string {
  switch (kind) {
    case "quit":
      return "Quit the app";
    case "emergency_exit":
      return "Emergency exit";
    case "focus_loss":
      return "Left the test window";
    case "focus_regained":
      return "Back in the test";
    case "lockdown_begin":
      return "Lockdown started";
    case "lockdown_end":
      return "Lockdown ended";
    case "lockdown_failed":
      return "Lockdown failed";
    case "lockdown_interrupted":
      return "Lockdown interrupted";
    // Batch 3 slice 2 (D-4): the app hit an error mid-test. Teacher-facing
    // wording, not the client's error code — the code and message are on the
    // row's detail for anyone reading the table behind it.
    case "client_error":
      return "The app hit a problem";
    // Time limit (docs/time-limit-and-unfinished-attempts-design.md): the
    // countdown reached zero and the client ended the secure session. NOT a
    // hand-in — the attempt is still in progress and still the teacher's call.
    case "time_expired":
      return "Time ran out";
    // Close session (docs/close-session-ends-attempts-design.md, D-1): the
    // sitting closed under a working student and the client sent them home.
    // Not a hand-in — the attempt is still in progress and resumable.
    case "sitting_closed":
      return "Session closed by the teacher — returned to Your tests";
    case "teacher_hand_in":
      return "Handed in by the teacher";
    // Teacher-granted extra time: the deadline was replaced with a later one.
    // The new instant is on the row's detail (`ends_at`) — the timeline says
    // it, the monitor's one-line label does not have room.
    case "deadline_extended":
      return "Time extended by teacher";
    // Pass back (docs/pass-back-design.md): the teacher put a handed-in attempt
    // back to in progress. The new deadline, when the assessment is timed, is on
    // the row's detail (`ends_at`) and shown by the timeline.
    case "passed_back":
      return "Passed back by teacher";
    default:
      return kind;
  }
}

/**
 * Close session (docs/close-session-ends-attempts-design.md, D-6): what the
 * confirm dialog says, given how many students are still working.
 *
 * A pure function of the count so the wording is testable — the repo has no
 * DOM harness, so the click itself stays a hand-run row. The count comes from
 * the attendance rows the caller already holds, read BEFORE confirming: after
 * the close it is too late to tell the teacher what they are about to do.
 *
 * The zero case also serves the Test sessions tab when it has no attendance
 * rows in hand, so it must stay TRUE for a sitting with students inside: the
 * pre-row-CS "students already in can finish and hand in" no longer is.
 */
export function closeDialogCopy(inProgress: number): string {
  if (inProgress <= 0) {
    return (
      "Nobody new can join or resume. Anyone still working is returned to " +
      "Your tests with their answers saved. It can't be reopened — start a " +
      "new session instead."
    );
  }
  const who = inProgress === 1 ? "1 student is" : `${inProgress} students are`;
  return (
    `${who} still working — they will be returned to Your tests with their ` +
    "answers saved. Hand in their work from the Monitor when you are ready, " +
    "or open another session for them to continue."
  );
}

/** How many of these attendance rows are attempts still in progress. */
export function countInProgress(
  rows: ReadonlyArray<Pick<AttendanceRow, "status">>,
): number {
  return rows.filter((r) => r.status === "in_progress").length;
}

/**
 * "Hand in everyone now" (James, 2026-09-16): when the button may be pressed,
 * stated exactly as POST /api/test-sessions/[sessionId]/hand-in-all decides
 * it — so the teacher never clicks something the route will refuse.
 *
 * The route hands in every in-progress attempt once the sitting is over, and
 * while the sitting is still open only those whose OWN deadline has passed
 * (409 `session_open` when nothing qualifies). `deadline_passed` on the row is
 * the same relaxation the per-attempt Hand in control uses.
 *
 * With no rows in hand (the Test sessions tab with Attendance collapsed) the
 * answer rests on the sitting alone: over → enabled, open → disabled. That is
 * the safe direction — an open sitting with a lapsed deadline reads as
 * disabled until the teacher expands Attendance, rather than as an enabled
 * button that 409s.
 */
export function canHandInAll(
  sittingOver: boolean,
  rows: ReadonlyArray<Pick<AttendanceRow, "status" | "deadline_passed">>,
): boolean {
  if (sittingOver) return true;
  return rows.some((r) => r.status === "in_progress" && r.deadline_passed);
}

/**
 * "Extend time": whether an in-progress attempt/sitting may have its
 * deadline extended. Deliberately NOT gated on the sitting being open or
 * closed — the whole point (like "Hand in everyone now") is a class that
 * needs longer after today's period ended — only on there being someone
 * still working to give the extra time to.
 */
export function canExtend(status: AttendanceRow["status"]): boolean {
  return status === "in_progress";
}

/**
 * The effective deadline as a short teacher-facing line: "Until 3:00 PM" /
 * "Until Sep 18, 11:59 PM" (today's date omitted, `formatWhen`) once
 * `deadline_passed` flips to "Time expired" — the same two facts the hand-in
 * route's own relaxation reads. Null when there is nothing to say: no limit,
 * no extension, or a submitted row (`deadline_at` is always null there).
 */
export function deadlineNote(
  deadline_at: string | null,
  deadline_passed: boolean,
  now: Date = new Date(),
): string | null {
  if (deadline_passed) return "Time expired";
  if (!deadline_at) return null;
  return `Until ${formatWhen(deadline_at, now)}`;
}

/**
 * UX pass 1, slices 6–7 (SM-11): the one student vocabulary for the
 * attendance table and the monitor. The server's alert stays sticky (decided
 * 2026-08-27); this is presentation only — an alert is CURRENT until the
 * student is back at work, i.e. a later lockdown_begin or answer activity
 * postdates it. After that it is history ("Earlier: …"), not a red row.
 */
export type StudentState =
  "not_joined" | "in_progress" | "idle" | "handed_in" | "needs_attention";

export function alertIsCurrent(
  r: Pick<
    AttendanceRow,
    "alert" | "last_lockdown_begin_at" | "last_activity_at"
  >,
): boolean {
  if (!r.alert) return false;
  const at = new Date(r.alert.at).getTime();
  // UX pass 2 slice 4 (P2-7): ANY later lockdown_begin demotes the alert —
  // the comment's rule. The old check looked only at the single newest event,
  // so a rejoin whose focus flickered (lockdown_begin -> focus_loss ->
  // focus_regained) stayed red until answer activity.
  if (
    r.last_lockdown_begin_at &&
    new Date(r.last_lockdown_begin_at).getTime() > at
  ) {
    return false;
  }
  if (r.last_activity_at && new Date(r.last_activity_at).getTime() > at)
    return false;
  return true;
}

export function studentState(r: AttendanceRow, now: number): StudentState {
  // H-1 (James, 2026-09-17): an earlier sitting's hand-in counts under the
  // Handed in tile, not under Not joined — the work is in, it just did not
  // happen in this room. `countInProgress` / `canHandInAll` are unaffected:
  // the attempt is not in progress and is not this sitting's to act on.
  if (r.status === "submitted" || r.status === "submitted_earlier")
    return "handed_in";
  if (alertIsCurrent(r)) return "needs_attention";
  if (idleFor(r, now) !== null) return "idle";
  if (r.status === "in_progress") return "in_progress";
  return "not_joined";
}

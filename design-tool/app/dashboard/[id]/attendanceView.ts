// Slices 86–87: what the Sittings tab and the monitor page share — the
// attendance payload's shape as the browser sees it, the two cadence
// constants, and the pure time helpers. No React here.

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
  status: "not_joined" | "in_progress" | "submitted";
  started_at: string | null;
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
  counts: { expected: number; joined: number; submitted: number };
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

export function sittingIsOpen(s: { status: string; expires_at: string }, now = Date.now()): boolean {
  return s.status === "open" && new Date(s.expires_at).getTime() > now;
}

export function statusLabel(status: AttendanceRow["status"]): string {
  return status === "submitted" ? "Submitted" : status === "in_progress" ? "In progress" : "Not joined";
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
    default:
      return kind;
  }
}

/**
 * UX pass 1, slices 6–7 (SM-11): the one student vocabulary for the
 * attendance table and the monitor. The server's alert stays sticky (decided
 * 2026-08-27); this is presentation only — an alert is CURRENT until the
 * student is back at work, i.e. a later lockdown_begin or answer activity
 * postdates it. After that it is history ("Earlier: …"), not a red row.
 */
export type StudentState = "not_joined" | "in_progress" | "idle" | "handed_in" | "needs_attention";

export function alertIsCurrent(
  r: Pick<AttendanceRow, "alert" | "last_lockdown_begin_at" | "last_activity_at">,
): boolean {
  if (!r.alert) return false;
  const at = new Date(r.alert.at).getTime();
  // UX pass 2 slice 4 (P2-7): ANY later lockdown_begin demotes the alert —
  // the comment's rule. The old check looked only at the single newest event,
  // so a rejoin whose focus flickered (lockdown_begin -> focus_loss ->
  // focus_regained) stayed red until answer activity.
  if (r.last_lockdown_begin_at && new Date(r.last_lockdown_begin_at).getTime() > at) {
    return false;
  }
  if (r.last_activity_at && new Date(r.last_activity_at).getTime() > at) return false;
  return true;
}

export function studentState(r: AttendanceRow, now: number): StudentState {
  if (r.status === "submitted") return "handed_in";
  if (alertIsCurrent(r)) return "needs_attention";
  if (idleFor(r, now) !== null) return "idle";
  if (r.status === "in_progress") return "in_progress";
  return "not_joined";
}

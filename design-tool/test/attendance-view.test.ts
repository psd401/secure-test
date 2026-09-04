import { describe, expect, test } from "bun:test";
import {
  IDLE_AFTER_MS,
  alertIsCurrent,
  studentState,
  type AttendanceRow,
} from "../app/dashboard/[id]/attendanceView";

const T0 = Date.parse("2026-08-30T17:00:00Z");
const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();

function row(over: Partial<AttendanceRow>): AttendanceRow {
  return {
    ps_id: "1",
    name: "Ada",
    section_label: "3(A)",
    status: "in_progress",
    started_at: iso(-30 * 60_000),
    submitted_at: null,
    answered: 3,
    total_items: 10,
    last_activity_at: iso(-60_000),
    in_scope: true,
    last_event: null,
    last_lockdown_begin_at: null,
    alert: null,
    attempt_id: "a",
    ...over,
  };
}

describe("studentState (UX pass 1 slices 6–7, SM-11)", () => {
  test("handed in wins over everything", () => {
    expect(studentState(row({ status: "submitted", alert: { kind: "quit", at: iso(-5000) } }), T0)).toBe("handed_in");
  });
  test("a sticky alert with nothing after it needs attention", () => {
    const r = row({ alert: { kind: "quit", at: iso(-2 * 60_000) }, last_activity_at: iso(-5 * 60_000) });
    expect(alertIsCurrent(r)).toBe(true);
    expect(studentState(r, T0)).toBe("needs_attention");
  });
  test("a lockdown_begin after the alert demotes it to history", () => {
    const r = row({
      alert: { kind: "quit", at: iso(-10 * 60_000) },
      last_event: { kind: "lockdown_begin", at: iso(-9 * 60_000) },
      last_lockdown_begin_at: iso(-9 * 60_000),
      last_activity_at: null,
    });
    expect(alertIsCurrent(r)).toBe(false);
    expect(studentState(r, T0)).toBe("in_progress");
  });
  test("a rejoin followed by a focus flicker still demotes the alert (P2-7)", () => {
    const r = row({
      alert: { kind: "emergency_exit", at: iso(-10 * 60_000) },
      last_lockdown_begin_at: iso(-9 * 60_000),
      last_event: { kind: "focus_regained", at: iso(-8 * 60_000) },
      last_activity_at: null,
    });
    expect(alertIsCurrent(r)).toBe(false);
    expect(studentState(r, T0)).toBe("in_progress");
  });
  test("a lockdown_begin BEFORE the alert does not demote it", () => {
    const r = row({
      alert: { kind: "emergency_exit", at: iso(-5 * 60_000) },
      last_lockdown_begin_at: iso(-9 * 60_000),
      last_event: { kind: "emergency_exit", at: iso(-5 * 60_000) },
      last_activity_at: null,
    });
    expect(alertIsCurrent(r)).toBe(true);
  });
  test("answer activity after the alert demotes it too", () => {
    const r = row({ alert: { kind: "emergency_exit", at: iso(-10 * 60_000) }, last_activity_at: iso(-60_000) });
    expect(alertIsCurrent(r)).toBe(false);
  });
  test("idle beats in progress; not joined otherwise", () => {
    expect(studentState(row({ last_activity_at: iso(-IDLE_AFTER_MS - 1) }), T0)).toBe("idle");
    expect(studentState(row({}), T0)).toBe("in_progress");
    expect(studentState(row({ status: "not_joined", last_activity_at: null, started_at: null }), T0)).toBe("not_joined");
  });
});

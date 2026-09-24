import { describe, expect, test } from "bun:test";
import {
  IDLE_AFTER_MS,
  alertIsCurrent,
  canExtend,
  canHandInAll,
  countInProgress,
  deadlineNote,
  earlierSessionNote,
  eventLabel,
  practiceHasAttempt,
  practiceStatusLine,
  statusLabel,
  studentState,
  type AttendanceRow,
} from "../app/dashboard/[id]/attendanceView";
import { formatWhen } from "../lib/ui/format";

const T0 = Date.parse("2026-08-30T17:00:00Z");
const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();

function row(over: Partial<AttendanceRow>): AttendanceRow {
  return {
    ps_id: "1",
    name: "Ada",
    section_label: "3(A)",
    status: "in_progress",
    started_at: iso(-30 * 60_000),
    deadline_passed: false,
    deadline_at: null,
    submitted_at: null,
    answered: 3,
    total_items: 10,
    last_activity_at: iso(-60_000),
    in_scope: true,
    last_event: null,
    last_lockdown_begin_at: null,
    alert: null,
    attempt_id: "a",
    timed: false,
    passed_back_waiting: false,
    time_limit_removed: false,
    ...over,
  };
}

describe("studentState (UX pass 1 slices 6–7, SM-11)", () => {
  test("handed in wins over everything", () => {
    expect(
      studentState(
        row({ status: "submitted", alert: { kind: "quit", at: iso(-5000) } }),
        T0,
      ),
    ).toBe("handed_in");
  });
  test("a sticky alert with nothing after it needs attention", () => {
    const r = row({
      alert: { kind: "quit", at: iso(-2 * 60_000) },
      last_activity_at: iso(-5 * 60_000),
    });
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
    const r = row({
      alert: { kind: "emergency_exit", at: iso(-10 * 60_000) },
      last_activity_at: iso(-60_000),
    });
    expect(alertIsCurrent(r)).toBe(false);
  });
  test("idle beats in progress; not joined otherwise", () => {
    expect(
      studentState(row({ last_activity_at: iso(-IDLE_AFTER_MS - 1) }), T0),
    ).toBe("idle");
    expect(studentState(row({}), T0)).toBe("in_progress");
    expect(
      studentState(
        row({ status: "not_joined", last_activity_at: null, started_at: null }),
        T0,
      ),
    ).toBe("not_joined");
  });
});

// "Hand in everyone now" (James, 2026-09-16): the button enables on exactly
// what POST /api/test-sessions/[sessionId]/hand-in-all accepts — every
// in-progress attempt once the sitting is over, and while it is still open
// only the attempts whose own deadline has passed (409 `session_open`
// otherwise).
describe("canHandInAll", () => {
  test("a sitting that is over enables it, whatever the rows say", () => {
    expect(canHandInAll(true, [])).toBe(true);
    expect(canHandInAll(true, [row({ status: "submitted" })])).toBe(true);
    expect(canHandInAll(true, [row({})])).toBe(true);
  });

  test("an open sitting with everyone inside their deadline does not", () => {
    expect(canHandInAll(false, [row({}), row({ status: "not_joined" })])).toBe(
      false,
    );
  });

  test("one in-progress attempt past its own deadline is enough (T-2's relaxation)", () => {
    expect(canHandInAll(false, [row({}), row({ deadline_passed: true })])).toBe(
      true,
    );
  });

  test("a deadline that passed on an attempt already handed in is not enough", () => {
    expect(
      canHandInAll(false, [
        row({ status: "submitted", deadline_passed: true }),
      ]),
    ).toBe(false);
  });

  test("no rows in hand (Attendance collapsed) rests on the sitting alone", () => {
    expect(canHandInAll(false, [])).toBe(false);
    expect(canHandInAll(true, [])).toBe(true);
  });
});

// Finding H-1 (2026-09-17): the student handed this assessment in through an
// earlier sitting, so they cannot join today's — say so on the row.
describe("submitted_earlier (H-1)", () => {
  const earlier = () =>
    row({
      status: "submitted_earlier",
      submitted_at: iso(-24 * 60 * 60_000),
      last_activity_at: null,
      deadline_passed: false,
    });

  test("says which session it was handed in to", () => {
    expect(statusLabel("submitted_earlier")).toBe(
      "Handed in (earlier session)",
    );
    expect(statusLabel("not_joined")).toBe("Not joined");
    expect(statusLabel("submitted")).toBe("Submitted");
  });

  test("the detail line names when, and is null on every other status", () => {
    expect(earlierSessionNote(earlier())).toContain("in an earlier session");
    expect(
      earlierSessionNote({ status: "submitted_earlier", submitted_at: null }),
    ).toBe("Handed in in an earlier session");
    expect(
      earlierSessionNote(
        row({ status: "submitted", submitted_at: iso(-1000) }),
      ),
    ).toBeNull();
    expect(earlierSessionNote(row({ status: "not_joined" }))).toBeNull();
  });

  // PB-4 (2026-09-22): a passed-back attempt waiting for its student.
  test("a passed-back attempt waiting to rejoin gets its own line", () => {
    expect(
      earlierSessionNote(row({ status: "not_joined", passed_back_waiting: true })),
    ).toBe("Passed back · waiting to rejoin");
  });

  // James, 2026-09-17: it counts under the Handed in tile, not Not joined.
  test("counts as handed in for the summary tiles", () => {
    expect(studentState(earlier(), T0)).toBe("handed_in");
  });

  test("is not in progress, so the hand-in controls ignore it", () => {
    expect(countInProgress([earlier()])).toBe(0);
    expect(canHandInAll(false, [earlier()])).toBe(false);
    expect(
      canHandInAll(false, [
        earlier(),
        { status: "submitted_earlier", deadline_passed: true },
      ]),
    ).toBe(false);
  });
});

// Batch 3 slice 2 (D-4): client_error is an alert kind, so the row reads
// "Needs attention" the same way a quit does, and it gets teacher-facing words
// rather than the client's error code.
describe("client_error in the attendance view", () => {
  test("needs attention, and is sticky like the other alert kinds", () => {
    const r = row({
      alert: { kind: "client_error", at: iso(-2 * 60_000) },
      last_event: { kind: "client_error", at: iso(-2 * 60_000) },
      last_activity_at: iso(-5 * 60_000),
    });
    expect(alertIsCurrent(r)).toBe(true);
    expect(studentState(r, T0)).toBe("needs_attention");
  });

  test("a later lockdown_begin demotes it to history, like every other alert", () => {
    const r = row({
      alert: { kind: "client_error", at: iso(-10 * 60_000) },
      last_lockdown_begin_at: iso(-9 * 60_000),
      last_event: { kind: "lockdown_begin", at: iso(-9 * 60_000) },
      last_activity_at: null,
    });
    expect(alertIsCurrent(r)).toBe(false);
  });

  test("reads as words, not as the client's error code", () => {
    expect(eventLabel("client_error")).toBe("The app hit a problem");
  });
});

// Time extension, teacher UI half: "Extend time" is enabled on exactly the
// same condition Hand in / Delete gate on being IN PROGRESS, minus their
// session-open guard — extending is additive, never refused by an open or
// closed sitting.
describe("canExtend", () => {
  test("in progress: yes", () => {
    expect(canExtend("in_progress")).toBe(true);
  });

  test("submitted, not joined, or handed in through an earlier session: no", () => {
    expect(canExtend("submitted")).toBe(false);
    expect(canExtend("not_joined")).toBe(false);
    expect(canExtend("submitted_earlier")).toBe(false);
  });
});

describe("deadlineNote", () => {
  test("no deadline and not passed: nothing to say", () => {
    expect(deadlineNote(null, false, new Date(T0))).toBeNull();
  });

  test("a deadline today reads as a bare time", () => {
    const at = iso(60_000); // one minute after T0, same Pacific calendar day
    expect(deadlineNote(at, false, new Date(T0))).toStartWith("Until ");
    expect(deadlineNote(at, false, new Date(T0))).not.toMatch(/\d{4}/);
  });

  test("a deadline on another day carries the date", () => {
    const at = new Date(T0 + 30 * 24 * 60 * 60_000).toISOString();
    expect(deadlineNote(at, false, new Date(T0))).toContain("Sep");
  });

  test("deadline_passed wins over a still-present deadline_at", () => {
    expect(deadlineNote(iso(60_000), true, new Date(T0))).toBe("Time expired");
  });

  test("deadline_passed with no deadline_at (defensive): still 'Time expired'", () => {
    expect(deadlineNote(null, true, new Date(T0))).toBe("Time expired");
  });

  // Remove time limit (2026-09-24): the removal is said, not left silent.
  test("a removed limit reads 'No time limit'", () => {
    expect(deadlineNote(null, false, new Date(T0), true)).toBe("No time limit");
  });
});

describe("practiceStatusLine (docs/practice-sitting-design.md, D-5)", () => {
  test("no row yet (attendance still loading): not started", () => {
    expect(practiceStatusLine(undefined, new Date(T0))).toBe("Not started yet");
  });

  test("not_joined: not started", () => {
    expect(practiceStatusLine(row({ status: "not_joined" }), new Date(T0))).toBe(
      "Not started yet",
    );
  });

  test("in_progress: the note's exact wording", () => {
    expect(
      practiceStatusLine(row({ status: "in_progress", answered: 3, total_items: 10 }), new Date(T0)),
    ).toBe("In progress · 3 of 10 answered");
  });

  test("submitted: the note's exact wording, with the hand-in time", () => {
    const submittedAt = iso(0); // same instant as "now" -> a bare time
    expect(
      practiceStatusLine(
        row({
          status: "submitted",
          answered: 7,
          total_items: 10,
          submitted_at: submittedAt,
        }),
        new Date(T0),
      ),
    ).toBe(`Handed in ${formatWhen(submittedAt, new Date(T0))} · 7 / 10`);
  });
});

describe("practiceHasAttempt (docs/practice-sitting-design.md, D-5/D-6)", () => {
  test("no row yet: nothing to act on", () => {
    expect(practiceHasAttempt(undefined)).toBe(false);
  });

  test("not_joined: nothing to act on even with a stray attempt_id", () => {
    expect(practiceHasAttempt(row({ status: "not_joined", attempt_id: "a" }))).toBe(false);
  });

  test("in_progress with an attempt: See my answers / Practice again enabled", () => {
    expect(practiceHasAttempt(row({ status: "in_progress", attempt_id: "a" }))).toBe(true);
  });

  test("submitted with an attempt: enabled", () => {
    expect(practiceHasAttempt(row({ status: "submitted", attempt_id: "a" }))).toBe(true);
  });
});

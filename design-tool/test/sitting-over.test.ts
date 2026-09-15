// Close session ends the sitting (docs/close-session-ends-attempts-design.md):
// the pure halves — when a sitting counts as over (D-1/D-2, no grace per D-3)
// and what the teacher's confirm dialog says about it (D-6). The DB-backed
// refusals are in sitting-closed.test.ts.
import { describe, expect, test } from "bun:test";
import { sittingIsOver } from "../lib/api/sittingOver";
import {
  closeDialogCopy,
  countInProgress,
  eventLabel,
  type AttendanceRow,
} from "../app/dashboard/[id]/attendanceView";

const NOW = new Date("2026-09-17T17:00:00.000Z");
const at = (offsetSeconds: number) =>
  new Date(NOW.getTime() + offsetSeconds * 1000);

describe("sittingIsOver", () => {
  test("an open, unexpired sitting is not over", () => {
    expect(sittingIsOver({ status: "open", expires_at: at(60) }, NOW)).toBe(false);
  });

  test("a closed sitting is over however long it has left on the clock", () => {
    expect(sittingIsOver({ status: "closed", expires_at: at(3600) }, NOW)).toBe(true);
  });

  test("expiry is enough on its own — D-2, no timer needed", () => {
    expect(sittingIsOver({ status: "open", expires_at: at(-1) }, NOW)).toBe(true);
  });

  test("no grace at the boundary: the instant it expires, it is over", () => {
    // Matches loadJoinableSitting, which admits only expires_at > now — the
    // two must not disagree about the single instant in between.
    expect(sittingIsOver({ status: "open", expires_at: at(1) }, NOW)).toBe(false);
    expect(sittingIsOver({ status: "open", expires_at: NOW }, NOW)).toBe(true);
  });
});

function row(status: AttendanceRow["status"]): Pick<AttendanceRow, "status"> {
  return { status };
}

describe("closeDialogCopy (D-6)", () => {
  test("nobody working (or count unknown) states the new rule without a count", () => {
    expect(closeDialogCopy(0)).toContain("Nobody new can join or resume");
    expect(closeDialogCopy(0)).toContain("returned to Your tests");
    expect(closeDialogCopy(0)).not.toMatch(/\d+ students? (is|are) still working/);
  });

  test("one student is singular", () => {
    expect(closeDialogCopy(1)).toStartWith("1 student is still working");
  });

  test("more than one is plural and names the count", () => {
    expect(closeDialogCopy(4)).toStartWith("4 students are still working");
  });

  test("it says what happens to them, and what the teacher does next", () => {
    const copy = closeDialogCopy(2);
    expect(copy).toContain("returned to Your tests with their answers saved");
    expect(copy).toContain("Hand in their work from the Monitor");
    expect(copy).toContain("open another session for them to continue");
  });

  test("countInProgress counts only the students still working", () => {
    expect(
      countInProgress([row("in_progress"), row("submitted"), row("not_joined"), row("in_progress")]),
    ).toBe(2);
    expect(countInProgress([])).toBe(0);
  });
});

describe("the sitting_closed event kind reads as words", () => {
  test("teacher-facing label, and NOT a hand-in", () => {
    expect(eventLabel("sitting_closed")).toBe(
      "Session closed by the teacher — returned to Your tests",
    );
  });
});

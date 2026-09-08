// R1 (docs/reporting-design.md): attempt_events -> the plain words on the
// per-student page. Pure, so no database here. Times are the district's
// (America/Los_Angeles); September instants are UTC-7.
import { describe, expect, test } from "bun:test";
import { ATTEMPT_EVENT_KINDS } from "../db/schema";
import { buildTimeline, durationLabel } from "../lib/reporting/timeline";

const at = (hhmmss: string) => `2026-09-07T${hhmmss}Z`;

describe("buildTimeline — focus pairing", () => {
  test("a loss and the regain after it are one line with the gap", () => {
    const lines = buildTimeline([
      { kind: "focus_loss", at: at("21:14:00") },
      { kind: "focus_regained", at: at("21:15:00") },
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.text).toBe("Left the test window 2:14 PM · back 2:15 PM (1 min)");
    expect(lines[0]!.kind).toBe("focus_loss");
  });

  test("a short gap is reported in seconds", () => {
    const lines = buildTimeline([
      { kind: "focus_loss", at: at("21:14:00") },
      { kind: "focus_regained", at: at("21:14:20") },
    ]);
    expect(lines[0]!.text).toContain("(20 sec)");
  });

  test("two losses pair with their own regains, in order", () => {
    const lines = buildTimeline([
      { kind: "focus_loss", at: at("21:10:00") },
      { kind: "focus_regained", at: at("21:11:00") },
      { kind: "focus_loss", at: at("21:20:00") },
      { kind: "focus_regained", at: at("21:23:00") },
    ]);
    expect(lines).toHaveLength(2);
    expect(lines[0]!.text).toBe("Left the test window 2:10 PM · back 2:11 PM (1 min)");
    expect(lines[1]!.text).toBe("Left the test window 2:20 PM · back 2:23 PM (3 min)");
  });

  test("an unpaired loss says the student did not come back", () => {
    const lines = buildTimeline([
      { kind: "focus_loss", at: at("21:14:00") },
      { kind: "lockdown_end", at: at("21:30:00") },
    ]);
    expect(lines[0]!.text).toBe(
      "Left the test window 2:14 PM · did not return before handing in",
    );
    expect(lines[1]!.text).toBe("Secure session ended 2:30 PM");
  });

  test("a regain with no loss before it still renders", () => {
    const lines = buildTimeline([{ kind: "focus_regained", at: at("21:15:00") }]);
    expect(lines[0]!.text).toBe("Back in the test 2:15 PM");
  });

  test("events are sorted before pairing, so input order does not matter", () => {
    const lines = buildTimeline([
      { kind: "focus_regained", at: at("21:15:00") },
      { kind: "lockdown_begin", at: at("21:00:00") },
      { kind: "focus_loss", at: at("21:14:00") },
    ]);
    expect(lines.map((l) => l.text)).toEqual([
      "Secure session started 2:00 PM",
      "Left the test window 2:14 PM · back 2:15 PM (1 min)",
    ]);
  });
});

describe("buildTimeline — one line per kind", () => {
  test("every kind the schema allows has words a teacher can read", () => {
    for (const kind of ATTEMPT_EVENT_KINDS) {
      const lines = buildTimeline([
        { kind, at: at("21:14:00"), detail: kind === "client_error" ? { kind: "x" } : null },
      ]);
      expect(lines).toHaveLength(1);
      // No raw snake_case kind leaks through as the whole sentence.
      expect(lines[0]!.text.startsWith(kind)).toBe(false);
      expect(lines[0]!.text.length).toBeGreaterThan(kind.length);
    }
  });

  test("the lockdown lifecycle, the exits and the quit", () => {
    const lines = buildTimeline([
      { kind: "lockdown_begin", at: at("21:00:00") },
      { kind: "lockdown_failed", at: at("21:01:00") },
      { kind: "lockdown_interrupted", at: at("21:02:00") },
      { kind: "emergency_exit", at: at("21:03:00") },
      { kind: "quit", at: at("21:04:00") },
      { kind: "lockdown_end", at: at("21:05:00") },
    ]);
    expect(lines.map((l) => l.text)).toEqual([
      "Secure session started 2:00 PM",
      "Lockdown failed 2:01 PM",
      "Lockdown interrupted 2:02 PM",
      "Secure session ended by the student 2:03 PM",
      "Quit the app 2:04 PM",
      "Secure session ended 2:05 PM",
    ]);
  });

  test("client_error names the error kind from its detail", () => {
    const lines = buildTimeline([
      {
        kind: "client_error",
        at: at("21:07:00"),
        detail: { kind: "drawing_upload_failed", message: "DRAWING UPLOAD FAILED: 500" },
      },
    ]);
    expect(lines[0]!.text).toBe("The app hit a problem: drawing_upload_failed 2:07 PM");
    // The message is NOT on the line — it can be long and is not a sentence.
    expect(lines[0]!.text).not.toContain("500");
  });

  test("client_error with no usable detail says 'unknown' rather than blank", () => {
    const lines = buildTimeline([{ kind: "client_error", at: at("21:07:00"), detail: null }]);
    expect(lines[0]!.text).toBe("The app hit a problem: unknown 2:07 PM");
  });

  test("an unknown kind falls back to the raw kind rather than vanishing", () => {
    const lines = buildTimeline([{ kind: "teleported", at: at("21:07:00") }]);
    expect(lines[0]!.text).toBe("teleported 2:07 PM");
  });
});

describe("durationLabel", () => {
  test("under a minute is seconds; a minute and over rounds to minutes", () => {
    expect(durationLabel(0)).toBe("0 sec");
    expect(durationLabel(59_000)).toBe("59 sec");
    expect(durationLabel(60_000)).toBe("1 min");
    expect(durationLabel(150_000)).toBe("3 min");
  });
});

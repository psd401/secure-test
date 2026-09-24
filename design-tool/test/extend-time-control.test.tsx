// "Adjust time" (teacher UI half of 889cf38's server-side extend routes).
// Same static-markup style as test/hand-in-all-control.test.tsx — no
// testing-library / DOM harness exists in this repo, so these check the
// disabled-and-noted posture and the pure copy/date helpers the dialog
// renders. The click itself (opening the dialog, typing a time, submitting)
// is a hand-run row.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  pruneSelection,
  selectAllState,
  selectableAttemptIds,
} from "../app/dashboard/[id]/attendanceView";
import {
  ExtendTimeControl,
  defaultExtendValue,
  extendHint,
  extendRequest,
  extendStatusText,
  shortensHint,
  toIsoInstant,
} from "../components/app/ExtendTimeControl";

describe("ExtendTimeControl", () => {
  test("enabled with no disabledReason", () => {
    const html = renderToStaticMarkup(
      <ExtendTimeControl target={{ kind: "attempt", attemptId: "a1" }} onExtended={() => {}} />,
    );
    expect(html).toContain("Adjust time");
    expect(html).not.toContain('disabled=""');
  });

  test("disabled with the caller's note as the title", () => {
    const html = renderToStaticMarkup(
      <ExtendTimeControl
        target={{ kind: "sitting", sessionId: "s1" }}
        onExtended={() => {}}
        disabledReason="No one is in progress on this session."
      />,
    );
    expect(html).toContain('disabled=""');
    expect(html).toContain("No one is in progress on this session.");
  });
});

describe("extendHint", () => {
  test("sitting: every student still in progress", () => {
    expect(extendHint("sitting")).toStartWith("Every student still in progress");
  });

  test("attempt: this student", () => {
    expect(extendHint("attempt")).toBe("This student gets until this time.");
  });
});

describe("extendStatusText", () => {
  test("attempt: no count in the copy", () => {
    expect(extendStatusText("attempt", 1)).toBe("Adjusted.");
  });

  test("sitting: pluralizes the count", () => {
    expect(extendStatusText("sitting", 3)).toBe("Adjusted 3 students.");
    expect(extendStatusText("sitting", 1)).toBe("Adjusted 1 student.");
    expect(extendStatusText("sitting", 0)).toBe("Adjusted 0 students.");
  });
});

describe("defaultExtendValue", () => {
  test("today at 23:59, in the datetime-local shape", () => {
    const now = new Date(2026, 8, 17, 9, 0, 0); // Sep 17 2026, local
    expect(defaultExtendValue(now)).toBe("2026-09-17T23:59");
  });

  test("still today one minute before", () => {
    const now = new Date(2026, 8, 17, 23, 58, 30);
    expect(defaultExtendValue(now)).toBe("2026-09-17T23:59");
  });

  test("in the last minute of the day: tomorrow, crossing a month boundary", () => {
    const now = new Date(2026, 8, 30, 23, 59, 20); // Sep 30 2026
    expect(defaultExtendValue(now)).toBe("2026-10-01T23:59");
  });
});

describe("toIsoInstant", () => {
  test("empty value: null, not a submittable instant", () => {
    expect(toIsoInstant("")).toBeNull();
  });

  test("a datetime-local value becomes a parseable ISO instant", () => {
    const iso = toIsoInstant("2026-09-18T23:59");
    expect(iso).not.toBeNull();
    expect(Number.isNaN(Date.parse(iso as string))).toBe(false);
  });
});

// EX-1 (2026-09-23): an earlier time is allowed, with a hint saying so.
describe("shortensHint", () => {
  const current = new Date("2026-09-23T23:59:00").toISOString();
  test("earlier than the current deadline -> hint", () => {
    expect(shortensHint("2026-09-23T22:00", [current])).toContain("shortens their time");
  });
  test("later than or equal to it -> no hint", () => {
    expect(shortensHint("2026-09-24T23:59", [current])).toBeNull();
    expect(shortensHint("2026-09-23T23:59", [current])).toBeNull();
  });
  test("a sitting compares against the LATEST current deadline", () => {
    const earlier = new Date("2026-09-23T12:00:00").toISOString();
    expect(shortensHint("2026-09-23T18:00", [earlier, current])).not.toBeNull();
    expect(shortensHint("2026-09-23T18:00", [earlier, null])).toBeNull();
  });
  test("nothing known, or no value -> no hint", () => {
    expect(shortensHint("2026-09-23T18:00", undefined)).toBeNull();
    expect(shortensHint("2026-09-23T18:00", [null, undefined])).toBeNull();
    expect(shortensHint("", [current])).toBeNull();
  });
});

// Remove time limit + Monitor checkboxes (2026-09-24).
describe("No time limit — copy", () => {
  test("hints: only the whole sitting mentions later joiners", () => {
    expect(extendHint("sitting", "no_limit")).toBe(
      "Every student still in progress, and anyone who joins this session later, has no time limit.",
    );
    expect(extendHint("attempt", "no_limit")).toBe("This student has no time limit.");
    expect(extendHint("selected", "no_limit")).not.toContain("later");
    expect(extendHint("selected")).toBe("The selected students get until this time.");
  });

  test("status text", () => {
    expect(extendStatusText("attempt", 1, "no_limit")).toBe("Time limit removed.");
    expect(extendStatusText("sitting", 3, "no_limit")).toBe("Time limit removed for 3 students.");
    expect(extendStatusText("selected", 1, "no_limit")).toBe("Time limit removed for 1 student.");
    expect(extendStatusText("selected", 2)).toBe("Adjusted 2 students.");
  });

  test("the button label is the caller's", () => {
    const html = renderToStaticMarkup(
      <ExtendTimeControl
        target={{ kind: "selected", sessionId: "s1", attemptIds: [] }}
        label="Adjust time for selected (0)"
        onExtended={() => {}}
        disabledReason="Tick the students in progress to adjust first."
      />,
    );
    expect(html).toContain("Adjust time for selected (0)");
    expect(html).toContain('disabled=""');
  });
});

describe("extendRequest", () => {
  test("no_limit posts { no_limit: true } and never ends_at", () => {
    expect(extendRequest({ kind: "attempt", attemptId: "a1" }, "no_limit", "2026-09-24T23:59")).toEqual({
      url: "/api/attempts/a1/extend",
      body: { no_limit: true },
    });
  });

  test("deadline posts ends_at; an empty value is null", () => {
    const r = extendRequest({ kind: "sitting", sessionId: "s1" }, "deadline", "2026-09-24T23:59");
    expect(r!.url).toBe("/api/test-sessions/s1/extend");
    expect(Object.keys(r!.body)).toEqual(["ends_at"]);
    expect(extendRequest({ kind: "sitting", sessionId: "s1" }, "deadline", "")).toBeNull();
  });

  test("selected students go to the sitting route with attempt_ids", () => {
    expect(
      extendRequest({ kind: "selected", sessionId: "s1", attemptIds: ["a", "b"] }, "no_limit", ""),
    ).toEqual({
      url: "/api/test-sessions/s1/extend",
      body: { no_limit: true, attempt_ids: ["a", "b"] },
    });
  });
});

describe("Monitor selection helpers", () => {
  const rows = [
    { status: "in_progress" as const, attempt_id: "a" },
    { status: "in_progress" as const, attempt_id: "b" },
    { status: "submitted" as const, attempt_id: "c" },
    { status: "not_joined" as const, attempt_id: null },
  ];

  test("only in-progress rows with an attempt are selectable", () => {
    expect(selectableAttemptIds(rows)).toEqual(["a", "b"]);
  });

  test("a row that stops being eligible drops out; an unchanged selection is the same set", () => {
    const sel = new Set(["a", "b"]);
    expect(pruneSelection(sel, rows)).toBe(sel);
    const after = pruneSelection(sel, [{ status: "submitted", attempt_id: "a" }, rows[1]!]);
    expect([...after]).toEqual(["b"]);
  });

  test("select-all state", () => {
    expect(selectAllState(0, 2)).toBe("none");
    expect(selectAllState(1, 2)).toBe("some");
    expect(selectAllState(2, 2)).toBe("all");
    expect(selectAllState(0, 0)).toBe("none");
  });
});

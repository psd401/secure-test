// Gradebook push slice 4: the Send-to-gradebook dialog's pure logic and its
// static markup. No DOM harness in this repo — predicates and formatters only,
// plus the button's server-rendered label.
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SendToGradebookControl } from "../components/app/SendToGradebookControl";
import {
  canSendToGradebook,
  canSubmitSend,
  chooseCategory,
  defaultAssignmentName,
  formatFailure,
  formatSendSummary,
  sectionOptionLabel,
  sendAgainNote,
  sendButtonLabel,
  sendErrorCopy,
  todayLocal,
} from "../lib/gradebook/sendDialog";

const emptyReasons = { unscored: 0, not_on_roster: 0, no_dcid: 0 };
const summary = (over: Partial<Parameters<typeof formatSendSummary>[0]> = {}) => ({
  sent: 0,
  updated: 0,
  skipped_unchanged: 0,
  held_back: { count: 0, reasons: { ...emptyReasons } },
  failed: [],
  notes: [],
  ...over,
});

describe("canSendToGradebook", () => {
  test("edit and own reach it; view and run do not", () => {
    expect(canSendToGradebook("own")).toBe(true);
    expect(canSendToGradebook("edit")).toBe(true);
    expect(canSendToGradebook("run")).toBe(false);
    expect(canSendToGradebook("view")).toBe(false);
  });
});

describe("chooseCategory (D-5 / D-6)", () => {
  const cats = [
    { id: "1", name: "Homework" },
    { id: "2", name: "Test" },
  ];
  test("the remembered category wins when still listed", () => {
    expect(chooseCategory(cats, "2", "1")).toEqual({ selected: "1", mustPick: false });
  });
  test("else the route's default", () => {
    expect(chooseCategory(cats, "2", null)).toEqual({ selected: "2", mustPick: false });
    expect(chooseCategory(cats, "2", "gone")).toEqual({ selected: "2", mustPick: false });
  });
  test("no default and nothing remembered forces a pick — never the first category", () => {
    expect(chooseCategory(cats, null, null)).toEqual({ selected: null, mustPick: true });
    expect(chooseCategory(cats, "gone", "gone")).toEqual({ selected: null, mustPick: true });
    expect(chooseCategory([], null, null)).toEqual({ selected: null, mustPick: true });
  });
});

describe("canSubmitSend", () => {
  const ok = { loading: false, busy: false, sectionPsId: "s1", categoryId: "c1", name: "Unit 3", dueDate: "2026-09-28" };
  test("enabled with everything present", () => expect(canSubmitSend(ok)).toBe(true));
  test("disabled while loading, busy, or missing a category / name / date", () => {
    expect(canSubmitSend({ ...ok, loading: true })).toBe(false);
    expect(canSubmitSend({ ...ok, busy: true })).toBe(false);
    expect(canSubmitSend({ ...ok, categoryId: null })).toBe(false);
    expect(canSubmitSend({ ...ok, sectionPsId: null })).toBe(false);
    expect(canSubmitSend({ ...ok, name: "   " })).toBe(false);
    expect(canSubmitSend({ ...ok, dueDate: "" })).toBe(false);
  });
});

describe("defaults", () => {
  test("the name is the title, cut to 50 characters", () => {
    expect(defaultAssignmentName("Unit 3 test")).toBe("Unit 3 test");
    expect([...defaultAssignmentName("x".repeat(80))]).toHaveLength(50);
  });
  test("today is the local calendar date", () => {
    expect(todayLocal(new Date(2026, 8, 5, 23, 59))).toBe("2026-09-05");
  });
});

describe("labels", () => {
  test("section option carries the counts", () => {
    expect(sectionOptionLabel({ label: "AP Seminar · 2(A)", scored: 24, awaiting: 3 })).toBe(
      "AP Seminar · 2(A) — 24 scored · 3 awaiting scoring",
    );
  });
  test("the button reads Sent to PowerSchool once a push exists", () => {
    expect(sendButtonLabel(null)).toBe("Send to gradebook");
    expect(sendButtonLabel("2026-09-28T20:00:00.000Z")).toBe("Sent to PowerSchool · Sep 28, 2026");
    expect(sendAgainNote(null)).toBeNull();
    expect(sendAgainNote("2026-09-28T20:00:00.000Z")).toContain("Sep 28, 2026");
  });
});

describe("formatSendSummary", () => {
  test("counts, held-back reasons named separately, then the route's notes", () => {
    const lines = formatSendSummary(
      summary({
        sent: 20,
        updated: 2,
        skipped_unchanged: 1,
        held_back: { count: 5, reasons: { unscored: 3, not_on_roster: 1, no_dcid: 1 } },
        failed: [{ student_number: "1", reason: "x" }],
        notes: ["1 student passed back since an earlier send keeps that earlier score."],
      }),
    );
    expect(lines[0]).toBe("20 sent · 2 updated · 1 unchanged · 5 held back · 1 failed.");
    expect(lines[1]).toBe(
      "Held back, not sent: 3 awaiting scoring; 1 not linked to the roster; 1 without a PowerSchool id yet. A later send picks them up.",
    );
    expect(lines[2]).toContain("passed back");
  });
  test("an empty send says there was nothing to send", () => {
    expect(formatSendSummary(summary())).toEqual(["Nothing to send: no fully scored work in this section."]);
  });
  test("only nonzero reasons are listed", () => {
    const lines = formatSendSummary(
      summary({ held_back: { count: 2, reasons: { unscored: 2, not_on_roster: 0, no_dcid: 0 } } }),
    );
    expect(lines[1]).toBe("Held back, not sent: 2 awaiting scoring. A later send picks them up.");
  });
});

describe("formatFailure", () => {
  test("known reasons in teacher words, others verbatim", () => {
    expect(formatFailure({ student_number: "9", reason: "assignment_missing" })).toBe(
      "9: the assignment is missing in PowerSchool",
    );
    expect(formatFailure({ student_number: "9", reason: "http_500" })).toBe("9: PowerSchool refused it (HTTP 500)");
    expect(formatFailure({ student_number: "9", reason: "not_in_powerschool_section" })).toBe(
      "9: not on this class in PowerSchool (left the class?)",
    );
    expect(formatFailure({ student_number: "9", reason: "network_error" })).toBe("9: could not reach PowerSchool");
    expect(formatFailure({ student_number: "9", reason: "Score out of range" })).toBe("9: Score out of range");
  });
});

describe("sendErrorCopy", () => {
  test("every route code has a sentence; none leaks the raw code except the fallback", () => {
    for (const code of [
      "gradebook_not_configured",
      "send_in_progress",
      "create_response_unreadable",
      "create_failed",
      "gradebook_unavailable",
      "unknown_category",
      "no_points",
      "not_found",
      "invalid_body",
      "unsupported_target",
      "network",
    ]) {
      expect(sendErrorCopy(code)).not.toContain(code);
    }
    expect(sendErrorCopy("send_in_progress")).toContain("already running");
    expect(sendErrorCopy("create_response_unreadable")).toContain("duplicate");
    expect(sendErrorCopy("gradebook_not_configured")).toContain("Tell IT");
  });
  test("missing_dcid tells teacher-side from section-side", () => {
    expect(sendErrorCopy("missing_dcid", { missing: ["users_dcid"] })).toContain("for you");
    expect(sendErrorCopy("missing_dcid", { missing: ["section_dcid"] })).toContain("This section");
    expect(sendErrorCopy("missing_dcid")).toContain("This section");
  });
  test("an unknown code falls back to a retry line carrying the code", () => {
    expect(sendErrorCopy("zzz")).toContain("zzz");
  });
});

describe("SendToGradebookControl markup", () => {
  const render = (last: string | null) =>
    renderToStaticMarkup(
      createElement(SendToGradebookControl, {
        assessmentId: "a",
        assessmentName: "Unit 3",
        sections: [{ ps_id: "s1", label: "AP Seminar", scored: 2, awaiting: 0, last_sent_at: last }],
        onDone: () => {},
      }),
    );
  test("button label before and after a push (the dialog is a closed portal)", () => {
    const before = render(null);
    expect(before).toContain("Send to gradebook");
    expect(before).not.toContain("Send again");
    const after = render("2026-09-28T20:00:00.000Z");
    expect(after).toContain("Sent to PowerSchool · Sep 28, 2026");
    expect(after).toContain("Send again");
  });
});

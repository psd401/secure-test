// Roadmap U-25 slice 1 (docs/bulk-pass-back-and-corrections-design.md), UI
// half. Same static-markup style as test/hand-in-all-control.test.tsx — no DOM
// harness in this repo, so these check the disabled posture, the dialog copy
// as the pure function the component renders, and the sitting rule
// (`passBackAllTargets`). The click itself is a hand-run row.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PassBackAllControl, passBackAllCopy } from "../components/app/PassBackAllControl";
import { passBackAllTargets } from "../app/dashboard/[id]/attendanceView";
import {
  PassBackSectionControl,
  sectionOptionLabel,
} from "../components/app/PassBackSectionControl";
import { NO_SECTION } from "../lib/scoring/sectionFilter";
import {
  CorrectionsOptions,
  NO_CORRECTIONS,
  correctionsBody,
} from "../components/app/CorrectionsOptions";

describe("PassBackAllControl", () => {
  test("enabled with ids and no disabledReason", () => {
    const html = renderToStaticMarkup(
      <PassBackAllControl
        assessmentId="a1"
        attemptIds={["x", "y"]}
        timed={false}
        scope={null}
        onPassedBack={() => {}}
      />,
    );
    expect(html).toContain("Pass back everyone");
    expect(html).not.toContain('disabled=""');
  });

  test("disabled with a reason when there is nothing to pass back", () => {
    const html = renderToStaticMarkup(
      <PassBackAllControl
        assessmentId="a1"
        attemptIds={[]}
        timed={false}
        scope={null}
        onPassedBack={() => {}}
      />,
    );
    expect(html).toContain('disabled=""');
    expect(html).toContain("No handed-in tests to pass back.");
  });

  test("the caller's reason wins", () => {
    const html = renderToStaticMarkup(
      <PassBackAllControl
        assessmentId="a1"
        attemptIds={["x"]}
        timed={false}
        scope={null}
        onPassedBack={() => {}}
        disabledReason="Open Attendance to see who handed in."
      />,
    );
    expect(html).toContain('disabled=""');
    expect(html).toContain("Open Attendance to see who handed in.");
  });

  test("the label can be changed (Results)", () => {
    const html = renderToStaticMarkup(
      <PassBackAllControl
        assessmentId="a1"
        attemptIds={["x"]}
        timed={false}
        scope={null}
        onPassedBack={() => {}}
        label="Pass back all handed in"
      />,
    );
    expect(html).toContain("Pass back all handed in");
  });
});

describe("passBackAllCopy", () => {
  test("names the count and the scope, and says scores are kept", () => {
    expect(passBackAllCopy(3, "Period 2")).toBe(
      "Pass back 3 students in Period 2? Their answers stay; they can change them " +
        "and hand in again. Their scores are kept as a record and each test is " +
        "scored again on the next hand-in.",
    );
  });

  test("one student is singular; no scope drops the clause", () => {
    expect(passBackAllCopy(1, null)).toStartWith("Pass back 1 student? ");
  });
});

describe("passBackAllTargets", () => {
  const row = (
    status: "not_joined" | "in_progress" | "submitted" | "submitted_earlier",
    attempt_id: string | null,
    timed = false,
  ) => ({ status, attempt_id, timed });

  test("handed-in rows here and in an earlier session; never in progress or not joined", () => {
    expect(
      passBackAllTargets([
        row("submitted", "a"),
        row("submitted_earlier", "b"),
        row("in_progress", "c", true),
        row("not_joined", null),
      ]),
    ).toEqual({ attemptIds: ["a", "b"], timed: false });
  });

  test("timed when any target is timed", () => {
    expect(passBackAllTargets([row("submitted", "a"), row("submitted", "b", true)]).timed).toBe(
      true,
    );
  });

  test("no rows (Attendance not loaded) is no targets", () => {
    expect(passBackAllTargets([])).toEqual({ attemptIds: [], timed: false });
  });
});

describe("PassBackSectionControl", () => {
  test("renders the picker's trigger, enabled", () => {
    const html = renderToStaticMarkup(
      <PassBackSectionControl assessmentId="a1" onPassedBack={() => {}} />,
    );
    expect(html).toContain("Pass back a class…");
    expect(html).not.toContain('disabled=""');
  });

  test("option labels name the section and the count; NO_SECTION reads as No section", () => {
    expect(sectionOptionLabel({ section: "Biology · 3(A)", handed_in: 24, timed: false })).toBe(
      "Biology · 3(A) — 24 handed in",
    );
    expect(sectionOptionLabel({ section: NO_SECTION, handed_in: 1, timed: true })).toBe(
      "No section — 1 handed in",
    );
  });
});

describe("CorrectionsOptions (U-25 slice 3a)", () => {
  test("both boxes, unticked by default", () => {
    const html = renderToStaticMarkup(
      <CorrectionsOptions value={NO_CORRECTIONS} onChange={() => {}} disabled={false} />,
    );
    expect(html).toContain("Show right/wrong");
    expect(html).toContain("Lock correct answers");
    expect(html).toContain("never the answer");
    expect(html).not.toContain("checked");
  });

  test("the body carries nothing when both are off, both fields otherwise", () => {
    expect(correctionsBody(NO_CORRECTIONS)).toEqual({});
    expect(correctionsBody({ show_marks: true, lock_correct: false })).toEqual({
      show_marks: true,
      lock_correct: false,
    });
  });
});

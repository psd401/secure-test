// Roadmap U-14 (2026-10-05), UI half: "Hand in all in progress" on the
// Results page. Static markup + the pure copy, as in hand-in-all-control —
// no DOM harness exists here; the click is a hand-run row.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  HandInInProgressControl,
  handInInProgressDialogCopy,
  handInInProgressLabel,
} from "../components/app/HandInInProgressControl";

describe("HandInInProgressControl", () => {
  test("enabled with the count when rows are ready", () => {
    const html = renderToStaticMarkup(
      <HandInInProgressControl
        assessmentId="a1"
        readyAttemptIds={["x", "y"]}
        heldCount={0}
        sectionLabel={null}
        onHandedIn={() => {}}
      />,
    );
    expect(html).toContain(handInInProgressLabel(2));
    expect(html).not.toContain('disabled=""');
  });

  test("disabled with a close-first note when every row is held by an open session", () => {
    const html = renderToStaticMarkup(
      <HandInInProgressControl
        assessmentId="a1"
        readyAttemptIds={[]}
        heldCount={3}
        sectionLabel={null}
        onHandedIn={() => {}}
      />,
    );
    expect(html).toContain('disabled=""');
    expect(html).toContain("Close it first, then hand in.");
  });

  test("the dialog copy names the count and the section", () => {
    expect(handInInProgressDialogCopy(1, 0, "P2 Algebra")).toBe(
      "Hand in 1 student in P2 Algebra who hasn't finished? Their answers are " +
        "saved as they are, they can't continue, and the work goes to scoring. " +
        "This can't be undone.",
    );
  });

  test("held rows are named as left alone", () => {
    expect(handInInProgressDialogCopy(5, 2, null)).toContain(
      "2 students still in an open test session are left alone; close that session first to include them.",
    );
    expect(handInInProgressDialogCopy(5, 1, null)).toContain(
      "1 student still in an open test session is left alone",
    );
  });
});

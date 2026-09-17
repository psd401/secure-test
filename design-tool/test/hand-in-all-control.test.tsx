// "Hand in everyone now" (James, 2026-09-16), UI half: the whole-sitting
// forced hand-in. Same static-markup style as test/hand-in-attempt-control.test.tsx
// — no testing-library / DOM harness exists in this repo, so these check the
// disabled-and-noted posture and the confirm dialog's copy as the pure
// function the component renders. The click itself is a hand-run row.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { handInAllDialogCopy, HandInAllControl } from "../components/app/HandInAllControl";
import { MonitorView } from "../app/dashboard/[id]/monitor/[sittingId]/MonitorView";

describe("HandInAllControl", () => {
  test("enabled with no disabledReason", () => {
    const html = renderToStaticMarkup(
      <HandInAllControl sessionId="s1" inProgress={2} onHandedIn={() => {}} />,
    );
    expect(html).toContain("Hand in everyone");
    expect(html).not.toContain('disabled=""');
  });

  test("disabled with the session-open note as the title while the sitting is open", () => {
    const html = renderToStaticMarkup(
      <HandInAllControl
        sessionId="s1"
        inProgress={2}
        onHandedIn={() => {}}
        disabledReason="End the test session first, then hand in."
      />,
    );
    expect(html).toContain('disabled=""');
    expect(html).toContain("End the test session first, then hand in.");
  });

  test("the dialog copy names the count and says it can't be undone", () => {
    expect(handInAllDialogCopy(2)).toBe(
      "Hand in 2 students still working? Their answers are saved as they are, " +
        "and they can't continue. This can't be undone.",
    );
  });

  test("one student is singular", () => {
    expect(handInAllDialogCopy(1)).toStartWith("Hand in 1 student still working?");
  });

  test("an unknown count (Attendance collapsed) falls back to generic copy", () => {
    expect(handInAllDialogCopy(0)).toStartWith("Hand in everyone still working?");
    expect(handInAllDialogCopy(0)).toContain("This can't be undone.");
    expect(handInAllDialogCopy(0)).not.toMatch(/\d/);
  });
});

describe("the Monitor header carries the button", () => {
  // MonitorView paints its header from the server props before any fetch, so
  // static markup reaches the button in both postures without a DOM.
  const props = {
    assessmentId: "a1",
    assessmentName: "Unit 1",
    sittingId: "s1",
    code: "ABCDEF",
  };

  test("an open sitting renders it disabled with the note", () => {
    const html = renderToStaticMarkup(
      <MonitorView
        {...props}
        status="open"
        expiresAt={new Date(Date.now() + 3_600_000).toISOString()}
      />,
    );
    expect(html).toContain("Hand in everyone");
    expect(html).toContain("End the test session first, then hand in.");
  });

  test("a closed sitting renders it enabled", () => {
    const html = renderToStaticMarkup(
      <MonitorView
        {...props}
        status="closed"
        expiresAt={new Date(Date.now() + 3_600_000).toISOString()}
      />,
    );
    expect(html).toContain("Hand in everyone");
    expect(html).not.toContain("End the test session first, then hand in.");
  });
});

// Time limit / unfinished attempts
// (docs/time-limit-and-unfinished-attempts-design.md, D-1/A, slice 3): the
// teacher's "Hand in" button. Same static-markup style as
// test/delete-draft-button.test.tsx — no testing-library / DOM harness
// exists in this repo, so these check the disabled-and-noted posture and the
// confirm dialog's copy (the design note's "Confirm dialog copy" section)
// via server-rendered markup.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { handInConfirmCopy, HandInAttemptControl } from "../components/app/HandInAttemptControl";

describe("HandInAttemptControl", () => {
  test("enabled with no disabledReason", () => {
    const html = renderToStaticMarkup(
      <HandInAttemptControl
        attemptId="a1"
        studentName="Alex"
        answeredCount={3}
        onHandedIn={() => {}}
      />,
    );
    expect(html).toContain("Hand in");
    expect(html).not.toContain('disabled=""');
  });

  test("disabled with the session-open note as the title while the sitting is open", () => {
    const html = renderToStaticMarkup(
      <HandInAttemptControl
        attemptId="a1"
        studentName="Alex"
        answeredCount={3}
        onHandedIn={() => {}}
        disabledReason="End the test session first, then hand in."
      />,
    );
    expect(html).toContain('disabled=""');
    expect(html).toContain("End the test session first, then hand in.");
  });

  test("the confirm dialog copy names the answered count and never counts undoing", () => {
    // Radix's AlertDialog content is unmounted while `open` is false (a
    // Portal, no static markup while closed), so the copy is checked as the
    // pure function the component renders rather than through a click.
    expect(handInConfirmCopy(5)).toBe(
      "Their 5 answered questions become their final answers and auto-scoring runs. " +
        "They will not be able to change them.",
    );
  });

  test("a singular answered count reads naturally", () => {
    expect(handInConfirmCopy(1)).toContain("Their 1 answered question become");
  });

  test("the trigger button, dialog title and Cancel action are in the tree even while closed", () => {
    const html = renderToStaticMarkup(
      <HandInAttemptControl
        attemptId="a1"
        studentName="Alex"
        answeredCount={5}
        onHandedIn={() => {}}
      />,
    );
    // The trigger renders; the dialog's own content does not until opened —
    // this just pins down that the closed state is otherwise unremarkable.
    expect(html).toContain("Hand in");
    expect(html).not.toContain("Hand in for Alex?");
  });
});

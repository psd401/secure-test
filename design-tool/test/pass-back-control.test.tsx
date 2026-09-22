// Pass back (docs/pass-back-design.md), slice 2: the teacher's "Pass back".
// Same static-markup style as test/extend-time-control.test.tsx and
// test/hand-in-attempt-control.test.tsx — no testing-library / DOM harness
// exists in this repo, so these check the disabled-and-noted posture and the
// pure copy/predicate helpers the dialog renders. The click itself (opening
// the dialog, picking a deadline, submitting) is a hand-run row.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  PassBackControl,
  passBackCopy,
  passBackNeedsDeadline,
} from "../components/app/PassBackControl";
import { passBackErrorCopy } from "../lib/ui/errorCopy";

describe("PassBackControl", () => {
  test("enabled with no disabledReason", () => {
    const html = renderToStaticMarkup(
      <PassBackControl
        attemptId="a1"
        studentName="Alex"
        scoreCount={3}
        timed={false}
        onPassedBack={() => {}}
      />,
    );
    expect(html).toContain("Pass back");
    expect(html).not.toContain('disabled=""');
  });

  test("disabled with the caller's note as the title", () => {
    const html = renderToStaticMarkup(
      <PassBackControl
        attemptId="a1"
        studentName="Alex"
        scoreCount={0}
        timed={false}
        onPassedBack={() => {}}
        disabledReason="Not handed in yet."
      />,
    );
    expect(html).toContain('disabled=""');
    expect(html).toContain("Not handed in yet.");
  });
});

describe("passBackCopy", () => {
  test("names the score count and what happens next", () => {
    expect(passBackCopy("Alex", 3)).toBe(
      "Their answers stay; they can change them and hand in again. " +
        "Their 3 scores are kept as a record and the test is scored again " +
        "on the next hand-in.",
    );
  });

  test("a singular score count drops the plural s", () => {
    // PB-1 (2026-09-22): the verb agrees too.
    expect(passBackCopy("Alex", 1)).toContain("Their 1 score is kept as a record");
  });

  test("zero scores: the simpler line", () => {
    expect(passBackCopy("Alex", 0)).toBe(
      "Their answers stay; they can change them and hand in again. " +
        "The test is scored on the next hand-in.",
    );
  });
});

describe("passBackNeedsDeadline", () => {
  test("timed: true", () => {
    expect(passBackNeedsDeadline(true)).toBe(true);
  });

  test("untimed: false", () => {
    expect(passBackNeedsDeadline(false)).toBe(false);
  });
});

describe("passBackErrorCopy", () => {
  test("not_submitted", () => {
    expect(passBackErrorCopy("not_submitted").message).toBe("Not handed in yet.");
  });

  test("ends_at_required and ends_at_past both read as a picker hint", () => {
    expect(passBackErrorCopy("ends_at_required").message).toBe(
      "Pick a time in the future.",
    );
    expect(passBackErrorCopy("ends_at_past").message).toBe(
      "Pick a time in the future.",
    );
  });

  test("not_found and forbidden both read as not yours", () => {
    expect(passBackErrorCopy("not_found").message).toBe("Not yours to pass back.");
    expect(passBackErrorCopy("forbidden").message).toBe("Not yours to pass back.");
  });

  test("an unknown code shows itself for IT", () => {
    const copy = passBackErrorCopy("something_new");
    expect(copy.showCode).toBe(true);
  });
});

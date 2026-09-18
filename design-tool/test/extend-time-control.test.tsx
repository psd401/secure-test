// "Extend time" (teacher UI half of 889cf38's server-side extend routes).
// Same static-markup style as test/hand-in-all-control.test.tsx — no
// testing-library / DOM harness exists in this repo, so these check the
// disabled-and-noted posture and the pure copy/date helpers the dialog
// renders. The click itself (opening the dialog, typing a time, submitting)
// is a hand-run row.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ExtendTimeControl,
  defaultExtendValue,
  extendHint,
  extendStatusText,
  toIsoInstant,
} from "../components/app/ExtendTimeControl";

describe("ExtendTimeControl", () => {
  test("enabled with no disabledReason", () => {
    const html = renderToStaticMarkup(
      <ExtendTimeControl target={{ kind: "attempt", attemptId: "a1" }} onExtended={() => {}} />,
    );
    expect(html).toContain("Extend time");
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
    expect(extendStatusText("attempt", 1)).toBe("Extended.");
  });

  test("sitting: pluralizes the count", () => {
    expect(extendStatusText("sitting", 3)).toBe("Extended 3 students.");
    expect(extendStatusText("sitting", 1)).toBe("Extended 1 student.");
    expect(extendStatusText("sitting", 0)).toBe("Extended 0 students.");
  });
});

describe("defaultExtendValue", () => {
  test("tomorrow at 23:59, in the datetime-local shape", () => {
    const now = new Date(2026, 8, 17, 9, 0, 0); // Sep 17 2026, local
    expect(defaultExtendValue(now)).toBe("2026-09-18T23:59");
  });

  test("crosses a month boundary correctly", () => {
    const now = new Date(2026, 8, 30, 22, 0, 0); // Sep 30 2026
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

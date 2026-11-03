// CBA hand-run 2026-11-02, findings F-3 and F-5 (docs/design-tool-manual-checks.md,
// rows 953 and 945). Same static-markup style as test/hand-in-all-control.test.tsx
// — no DOM harness exists here, so this checks what the header renders; the
// per-row Pass back, the Counselors checkbox reset (F-4) and the row-level
// Change proctor message (F-6) are re-checked by hand.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MonitorView } from "../app/dashboard/[id]/monitor/[sittingId]/MonitorView";
import { itemErrorCopy } from "../lib/ui/errorCopy";

const props = {
  assessmentId: "a1",
  assessmentName: "CBA task",
  sittingId: "s1",
  code: "ABCDEF",
  status: "closed" as const,
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
};

describe("F-3: a proctor's Monitor offers only what a proctor can do", () => {
  test("a teacher's Monitor keeps Pass back everyone and the editor breadcrumb", () => {
    const html = renderToStaticMarkup(<MonitorView {...props} />);
    expect(html).toContain("Pass back everyone");
    expect(html).toContain('href="/dashboard/a1?tab=sessions"');
  });

  test("a proctor's has neither; the breadcrumb leads to their list", () => {
    const html = renderToStaticMarkup(
      <MonitorView
        {...props}
        proctor
        backHref="/dashboard/proctoring"
        backLabel="Back to competency assessments"
      />,
    );
    expect(html).not.toContain("Pass back everyone");
    expect(html).not.toContain('href="/dashboard/a1?tab=sessions"');
    expect(html).toContain('href="/dashboard/proctoring"');
    expect(html).toContain("Competency assessments");
  });
});

describe("F-5: removing an assigned option says why, in plain words", () => {
  test("option_assigned has its own message and no code", () => {
    const copy = itemErrorCopy("option_assigned");
    expect(copy.showCode).toBe(false);
    expect(copy.message).toContain("A student is assigned this option");
    expect(copy.message).toContain("Switch their assignment first");
  });

  test("F-9: option_in_record says the option is part of a record, with no advice that cannot work", () => {
    const copy = itemErrorCopy("option_in_record");
    expect(copy.showCode).toBe(false);
    expect(copy.message).toBe("A student's record uses this option, so it can't be removed.");
  });
});

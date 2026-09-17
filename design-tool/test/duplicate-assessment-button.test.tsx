// Duplicate (2026-09-16, James's decisions): the Assessments-list /
// Settings-tab duplicate action. Same static-markup style as
// test/archive-assessment-button.test.tsx — no testing-library / DOM harness
// exists in this repo yet (see test/error-boundaries.test.tsx), so the busy
// state and the navigation on success are hand-run rows.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DuplicateAssessmentButton } from "../app/dashboard/DuplicateAssessmentButton";

describe("DuplicateAssessmentButton", () => {
  test("reads Duplicate and is enabled at rest", () => {
    const html = renderToStaticMarkup(<DuplicateAssessmentButton id="a1" />);
    expect(html).toContain(">Duplicate<");
    expect(html).not.toContain("Duplicating");
    // `disabled:` prefixed utility classes are always present — only the
    // attribute itself says the button is busy.
    expect(html).not.toContain("disabled=");
  });

  test("renders no error until one happens — non-destructive, so no confirm either", () => {
    const html = renderToStaticMarkup(<DuplicateAssessmentButton id="a1" />);
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain("Couldn&#x27;t duplicate");
  });

  // The list row uses the small outline button beside Archive / Delete; the
  // Settings tab uses the default size, left-aligned, in its bordered block.
  test("the Settings-tab variant is the default size, start-aligned", () => {
    const list = renderToStaticMarkup(<DuplicateAssessmentButton id="a1" />);
    expect(list).toContain('data-size="sm"');
    expect(list).toContain("items-end");

    const settings = renderToStaticMarkup(
      <DuplicateAssessmentButton id="a1" size="default" align="start" />,
    );
    expect(settings).toContain('data-size="default"');
    expect(settings).toContain("items-start");
  });
});

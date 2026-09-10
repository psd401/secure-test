// D-2 / D-3 (docs/archive-and-delete-design.md): the Assessments-list /
// Settings-tab archive toggle. Same static-markup style as
// test/delete-draft-button.test.tsx — no testing-library / DOM harness
// exists in this repo yet (see test/error-boundaries.test.tsx).
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ArchiveAssessmentButton } from "../app/dashboard/ArchiveAssessmentButton";

describe("ArchiveAssessmentButton", () => {
  test("reads Archive for a live assessment", () => {
    const html = renderToStaticMarkup(<ArchiveAssessmentButton id="a1" archived={false} />);
    expect(html).toContain(">Archive<");
    expect(html).not.toContain(">Unarchive<");
  });

  test("reads Unarchive for an archived assessment", () => {
    const html = renderToStaticMarkup(<ArchiveAssessmentButton id="a1" archived={true} />);
    expect(html).toContain(">Unarchive<");
  });
});

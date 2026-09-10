// D-1 / D-4 (docs/archive-and-delete-design.md): the Assessments-list row
// action. No testing-library / DOM harness exists in this repo yet (see
// test/error-boundaries.test.tsx) — these check the same disabled-and-noted
// posture the confirm dialog relies on via static markup, same style as
// that file.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DeleteDraftButton } from "../app/dashboard/DeleteDraftButton";

describe("DeleteDraftButton", () => {
  test("enabled for a draft with no attempts", () => {
    const html = renderToStaticMarkup(
      <DeleteDraftButton id="a1" name="Quiz" questionCount={3} attemptCount={0} status="draft" />,
    );
    expect(html).toContain("Delete");
    expect(html).not.toContain("disabled=\"\"");
  });

  test("disabled with a title when Published", () => {
    const html = renderToStaticMarkup(
      <DeleteDraftButton id="a1" name="Quiz" questionCount={3} attemptCount={0} status="published" />,
    );
    expect(html).toContain("disabled=\"\"");
    expect(html).toContain("Unpublish to delete.");
  });

  test("disabled with the attempt count when attempts exist", () => {
    const html = renderToStaticMarkup(
      <DeleteDraftButton id="a1" name="Quiz" questionCount={3} attemptCount={2} status="draft" />,
    );
    expect(html).toContain("disabled=\"\"");
    expect(html).toContain("2 attempts — archive instead.");
  });

  test("singular attempt count reads naturally", () => {
    const html = renderToStaticMarkup(
      <DeleteDraftButton id="a1" name="Quiz" questionCount={3} attemptCount={1} status="draft" />,
    );
    expect(html).toContain("1 attempt — archive instead.");
  });
});

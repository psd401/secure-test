// Hand-check row 836 (2026-10-27): the new editor's save indicator says why a
// card is held — a deleted blank (F-5) or an unfinished AI short-answer key —
// in amber, not as a failed save.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AutosaveIndicator } from "../app/dashboard/[id]/AutosaveIndicator";

const render = (summary: Parameters<typeof AutosaveIndicator>[0]["summary"]) =>
  renderToStaticMarkup(
    <AutosaveIndicator summary={summary} questionNumber={(id) => Number(id.slice(1))} onJump={() => {}} onRetry={() => {}} />,
  );

describe("AutosaveIndicator waiting", () => {
  test("an unfinished credit key names its question", () => {
    const html = render({ kind: "waiting", itemIds: ["q2"], creditIds: ["q2"] });
    expect(html).toContain("Not saved yet — finish what earns credit in");
    expect(html).toContain("Question 2");
    expect(html).not.toContain("deleted blank");
    expect(html).not.toContain("didn&#x27;t save");
  });
  test("a deleted blank keeps its own wording", () => {
    const html = render({ kind: "waiting", itemIds: ["q1"] });
    expect(html).toContain("put back or remove the deleted blank in");
    expect(html).not.toContain("what earns credit");
  });
  test("both at once: each reason with its own questions", () => {
    const html = render({ kind: "waiting", itemIds: ["q1", "q3"], creditIds: ["q3"] });
    expect(html.indexOf("deleted blank")).toBeLessThan(html.indexOf("Question 1"));
    expect(html.indexOf("what earns credit")).toBeLessThan(html.indexOf("Question 3"));
  });
});

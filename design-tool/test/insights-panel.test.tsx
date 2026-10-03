// Class insights slice 3: the pure pieces behind the results page panel.
// No DOM harness here, so clicks stay manual rows.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  TEACHER_ONLY_LINE,
  insightsErrorCopy,
  questionAnchor,
  ratingMessage,
  reportCopyText,
  sectionParam,
  type PanelSections,
} from "../lib/insights/panelCopy";
import { ClassInsightsPanel } from "../components/app/ClassInsightsPanel";

const claim = (text: string) => ({
  text,
  citations: { items: [], tags: [], students: [] },
});

describe("class insights panel helpers", () => {
  test("copy text: teacher-only line, headings, dash claims, empty sections left out", () => {
    const sections: PanelSections = {
      strengths: [claim("Ada Example did well on Q1.")],
      growth: [],
      celebrations: [claim("Grace Sample led the class.")],
      next_steps: [claim("Reteach Q2."), claim("Small group on Q3.")],
    };
    expect(reportCopyText(sections)).toBe(
      [
        TEACHER_ONLY_LINE,
        "",
        "Strengths",
        "- Ada Example did well on Q1.",
        "",
        "Celebrations",
        "- Grace Sample led the class.",
        "",
        "Next steps for the whole class",
        "- Reteach Q2.",
        "- Small group on Q3.",
      ].join("\n"),
    );
  });

  test("section param maps all sections to __all__ and passes the rest through", () => {
    expect(sectionParam("")).toBe("__all__");
    expect(sectionParam("__none__")).toBe("__none__");
    expect(sectionParam("Period 2")).toBe("Period 2");
  });

  test("error copy per code", () => {
    expect(insightsErrorCopy("nothing_to_report")).toBe("No student has a scored answer yet.");
    expect(insightsErrorCopy("guardrail_blocked")).toContain("content safeguards");
    expect(insightsErrorCopy("provider_failed")).toBe("The AI could not write a report. Try again.");
    expect(insightsErrorCopy("weird")).toContain("Try again");
  });

  test("anchor ids and rating message", () => {
    expect(questionAnchor("Q3")).toBe("col-q3");
    expect(
      ratingMessage({ helpful: false, assessmentId: "A1", promptVersion: "v1", comment: "  too vague " }),
    ).toBe("class-insights rating: not helpful | assessment A1 | prompt v1\ntoo vague");
    expect(
      ratingMessage({ helpful: true, assessmentId: "A1", promptVersion: "v1", comment: "" }),
    ).toBe("class-insights rating: helpful | assessment A1 | prompt v1");
  });

  test("static markup renders the heading and the loading state", () => {
    const html = renderToStaticMarkup(
      <ClassInsightsPanel assessmentId="a" section="" canGenerate />,
    );
    expect(html).toContain("Class insights");
    expect(html).toContain("Loading");
  });
});

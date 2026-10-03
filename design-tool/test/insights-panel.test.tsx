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

import {
  CHAT_STARTERS,
  chatErrorCopy,
  counterText,
  readAnswersText,
  turnsLeftText,
} from "../lib/insights/panelCopy";
import { ClassInsightsChat } from "../components/app/ClassInsightsChat";

describe("class insights chat helpers (slice 5)", () => {
  test("error copy per code and guardrail stage", () => {
    expect(chatErrorCopy("thread_full")).toBe("This conversation is full. Start a new one.");
    expect(chatErrorCopy("guardrail_blocked", "input")).toBe(
      "Your question was blocked by content safeguards. Rephrase it and try again.",
    );
    expect(chatErrorCopy("guardrail_blocked", "output")).toBe(
      "The answer was withheld by content safeguards. Try again.",
    );
    expect(chatErrorCopy("provider_failed")).toBe("The AI could not answer. Try again.");
    expect(chatErrorCopy("nothing_to_report")).toBe("No student has a scored answer yet.");
    expect(chatErrorCopy("conflict")).toBe("Something changed while sending. Try again.");
    expect(chatErrorCopy("network")).toBe("Could not reach the server. Try again.");
    expect(chatErrorCopy("weird")).toContain("Try again");
  });

  test("counter, read-answers and turns-left text", () => {
    expect(counterText(10)).toBe("");
    expect(counterText(900)).toBe("900 / 1000");
    expect(readAnswersText(undefined)).toBe("");
    expect(readAnswersText(0)).toBe("");
    expect(readAnswersText(1)).toBe("Read 1 answer");
    expect(readAnswersText(4)).toBe("Read 4 answers");
    expect(turnsLeftText(11)).toBe("");
    expect(turnsLeftText(10)).toBe("10 messages left in this conversation");
    expect(turnsLeftText(1)).toBe("1 message left in this conversation");
    expect(turnsLeftText(0)).toBe("This conversation is full.");
  });

  test("starters avoid question numbers", () => {
    expect(CHAT_STARTERS.length).toBe(3);
    for (const s of CHAT_STARTERS) expect(/\bQ\d|question \d/i.test(s)).toBe(false);
  });

  test("static markup: heading, log, labelled input, Send; starters wait for the load", () => {
    const html = renderToStaticMarkup(<ClassInsightsChat assessmentId="a" section="" />);
    expect(html).toContain("Ask about this class");
    expect(html).toContain('role="log"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('for="class-insights-chat-input"');
    expect(html).toContain(">Send<");
    expect(html).not.toContain("Start a new conversation");
  });

  test("the panel shows the chat to editors only", () => {
    const edit = renderToStaticMarkup(<ClassInsightsPanel assessmentId="a" section="" canGenerate />);
    const view = renderToStaticMarkup(
      <ClassInsightsPanel assessmentId="a" section="" canGenerate={false} />,
    );
    expect(edit).toContain("Ask about this class");
    expect(view).not.toContain("Ask about this class");
  });
});

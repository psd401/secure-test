// Change a final score, slice 2: the dialog's pure logic and its static markup.
// No DOM harness in this repo — formatters and predicates, plus the button's
// server-rendered label.
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChangeScoreControl } from "../components/app/ChangeScoreControl";
import {
  canChange,
  causeLine,
  changeScoreErrorMessage,
  methodLabel,
  nowLine,
  parsePoints,
  pointsStep,
} from "../lib/scoring/changeScoreDialog";

describe("canChange", () => {
  test("any final, whatever the method; nothing else", () => {
    expect(canChange({ status: "final" })).toBe(true);
    expect(canChange({ status: "proposed" })).toBe(false);
    expect(canChange({ status: "superseded" })).toBe(false);
    expect(canChange(null)).toBe(false);
  });
});

describe("nowLine", () => {
  test("names the method in the page's words", () => {
    expect(nowLine({ points: 2, max_points: 4, method: "auto" })).toBe("Now 2 of 4 · auto");
    expect(nowLine({ points: 3, max_points: 4, method: "ai" })).toBe("Now 3 of 4 · AI");
    expect(nowLine({ points: 1, max_points: 1, method: "human" })).toBe("Now 1 of 1 · you");
    expect(methodLabel("odd")).toBe("odd");
  });
});

describe("points rules", () => {
  test("the queue's step rule", () => {
    expect(pointsStep(1)).toBe(0.5);
    expect(pointsStep(4)).toBe(1);
  });
  test("empty is no value, never 0; out of range refused", () => {
    expect(parsePoints("  ", 4).ok).toBe(false);
    expect(parsePoints("5", 4).ok).toBe(false);
    expect(parsePoints("-1", 4).ok).toBe(false);
    expect(parsePoints("abc", 4).ok).toBe(false);
    expect(parsePoints("0", 4)).toEqual({ ok: true, points: 0 });
    expect(parsePoints("2.5", 4)).toEqual({ ok: true, points: 2.5 });
  });
});

describe("changeScoreErrorMessage", () => {
  test("maps the route's codes to plain sentences", () => {
    expect(changeScoreErrorMessage("no_final")).toBe(
      "This answer has no final score to change — score it from the queue instead.",
    );
    expect(changeScoreErrorMessage("max_points_mismatch")).toBe("That score is outside the item's range.");
    expect(changeScoreErrorMessage("rubric_bounds")).toBe("That score is outside the item's range.");
    expect(changeScoreErrorMessage("not_found")).toBe("You cannot change this score.");
    expect(changeScoreErrorMessage("network")).toContain("Couldn't reach the server");
    expect(changeScoreErrorMessage("boom")).toContain("boom");
  });
});

describe("causeLine", () => {
  test("pass back and change, with and without a note", () => {
    expect(causeLine({ cause: "pass_back" })).toBe("set aside by pass back");
    expect(causeLine({ cause: "changed", replaced_by: { points: 3 } })).toBe("changed by teacher to 3");
    expect(
      causeLine({ cause: "changed", replaced_by: { points: 3, note: "rubric misread" } }),
    ).toBe("changed by teacher to 3 — rubric misread");
  });
});

describe("ChangeScoreControl markup", () => {
  test("renders a Change button (the dialog is portalled while closed)", () => {
    const html = renderToStaticMarkup(
      createElement(ChangeScoreControl, {
        responseId: "r1",
        questionLabel: "Q1",
        score: { points: 1, max_points: 1, method: "auto" },
        maxPoints: 1,
        rubric: null,
        onChanged: () => {},
      }),
    );
    expect(html).toContain("Change");
    expect(html).toContain("<button");
  });
});

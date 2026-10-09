// E11 slice 2 (docs/rescore-after-key-change-design.md): the Rescore control's
// words and the editor pointer's key comparison. Pure — the repo has no DOM
// harness, so a click stays a hand-run row.
import { describe, expect, test } from "bun:test";
import {
  RESCORE_NOTHING_TITLE,
  answerKeyChanged,
  doneLine,
  dryRunSummary,
  questionLine,
  rescoreButtonLabel,
  rescoreErrorMessage,
  sentBeforeLine,
} from "../lib/scoring/rescoreDialog";

describe("rescore dialog wording", () => {
  test("button label carries the count", () => {
    expect(rescoreButtonLabel(12)).toBe("Rescore with current key (12)");
    expect(rescoreButtonLabel(0)).toBe("Rescore with current key (0)");
  });

  test("summary names students and kept scores", () => {
    expect(dryRunSummary({ students_changed: 12, kept: 3, questions: [] })).toBe(
      "Rescoring changes 12 students' scores with the current answer keys. 3 scores you set yourself stay as they are. The earlier scores are kept on each student's page.",
    );
    expect(dryRunSummary({ students_changed: 1, kept: 1, questions: [] })).toBe(
      "Rescoring changes 1 student's score with the current answer keys. 1 score you set yourself stays as it is. The earlier scores are kept on each student's page.",
    );
    expect(dryRunSummary({ students_changed: 0, kept: 0, questions: [] })).toBe(
      `${RESCORE_NOTHING_TITLE}.`,
    );
  });

  test("question lines use the matrix's Q numbering", () => {
    expect(questionLine({ position: 2, changed: 12, kept: 0 })).toBe("Q3 — 12 answers change");
    expect(questionLine({ position: 0, changed: 1, kept: 2 })).toBe(
      "Q1 — 1 answer changes · 2 scores you set stay",
    );
    expect(questionLine({ position: 6, changed: 0, kept: 1 })).toBe("Q7 — 1 score you set stays");
  });

  test("done line and the gradebook sections (D-3)", () => {
    expect(
      doneLine({ written: 2, students_changed: 2, sections_sent_before: [], at: "2026-10-08T22:05:00.000Z" }),
    ).toBe("Rescored 2 students · 3:05 PM.");
    expect(sentBeforeLine([])).toBeNull();
    expect(sentBeforeLine(["Period 2"])).toBe(
      "Period 2 was already sent to PowerSchool — send it again to update.",
    );
    expect(sentBeforeLine(["Period 2", "Period 4", "Period 6"])).toBe(
      "Period 2, Period 4 and Period 6 were already sent to PowerSchool — send them again to update.",
    );
  });

  test("errors", () => {
    expect(rescoreErrorMessage("nothing_to_rescore")).toContain("Reload the page");
    expect(rescoreErrorMessage("http_500")).toBe("Couldn't rescore. Try again.");
  });
});

describe("answerKeyChanged (the editor's pointer)", () => {
  const mc = { stem: "Pick", correct_choice_ids: ["c1"], standards: [] as string[] };

  test("a key edit counts", () => {
    expect(answerKeyChanged(mc, { ...mc, correct_choice_ids: ["c2"] })).toBe(true);
    expect(answerKeyChanged({ correct_answer: "1/2" }, { correct_answer: "0.5" })).toBe(true);
    expect(
      answerKeyChanged({ blanks: [{ id: "b1", keys: ["a"] }] }, { blanks: [{ id: "b1", keys: ["a", "b"] }] }),
    ).toBe(true);
  });

  test("a standards-only save and a first save do not", () => {
    expect(answerKeyChanged(mc, { ...mc, standards: ["WA.MATH.1"] })).toBe(false);
    expect(answerKeyChanged(null, mc)).toBe(false);
  });
});

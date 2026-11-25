// B1 (docs/point-weighting-design.md, D1): the line that joins a weighted
// rubric question's score (on the question's points) to its criterion rows
// (on the rubric's own scale).
import { describe, expect, test } from "bun:test";
import type { Rubric } from "@secure-test/schema";
import { rubricScaleLine } from "../lib/reporting/rubricScoreView";
import { selectPrintFeedback } from "../lib/reporting/printFeedback";
import { buildFeedbackRelease, type FeedbackBlock } from "../lib/reporting/feedbackRelease";
import { packetScoreBlocks, type PacketContents, type PacketScoreRow } from "../lib/reporting/workPacket";
import { buildDocHtml } from "../lib/googleDocs/content";

// 4 + 4 = an 8-point analytic rubric, shown to families with feedback.
const RUBRIC = {
  style: "analytic",
  student_visibility: { during: false, with_feedback: true },
  criteria: ["a", "b"].map((id) => ({
    id,
    name: id === "a" ? "Ideas" : "Organization",
    levels: [1, 2, 3, 4].map((p) => ({ id: `${id}${p}`, label: `L${p}`, points: p })),
  })),
} as Rubric;

const picks = (a: number, b: number) => ({
  criterion_scores: [
    { criterion_id: "a", level_id: `a${a}`, points: a, rationale: "" },
    { criterion_id: "b", level_id: `b${b}`, points: b, rationale: "" },
  ],
});

describe("rubricScaleLine", () => {
  test("a weighted rubric question names both scales", () => {
    expect(rubricScaleLine(RUBRIC, { points: 3, max_points: 4 }, picks(4, 2))).toBe(
      "Rubric 6 of 8, scaled to 3 of 4 points",
    );
    expect(rubricScaleLine(RUBRIC, { points: 10, max_points: 10 }, picks(4, 4))).toBe(
      "Rubric 8 of 8, scaled to 10 of 10 points",
    );
  });

  test("null on the rubric's own scale (every unweighted question)", () => {
    expect(rubricScaleLine(RUBRIC, { points: 6, max_points: 8 }, picks(4, 2))).toBeNull();
  });

  test("null without a rubric or a score", () => {
    expect(rubricScaleLine(null, { points: 3, max_points: 4 }, picks(4, 2))).toBeNull();
    expect(rubricScaleLine(RUBRIC, null, picks(4, 2))).toBeNull();
  });

  test("a bare-points score is put back on the rubric scale from its share", () => {
    expect(rubricScaleLine(RUBRIC, { points: 1.5, max_points: 4 }, { note: "holistic" })).toBe(
      "Rubric 3 of 8, scaled to 1.5 of 4 points",
    );
    // 1 of 3 on an 8-point rubric rounds to 2 decimals.
    expect(rubricScaleLine(RUBRIC, { points: 1, max_points: 3 }, {})).toBe(
      "Rubric 2.67 of 8, scaled to 1 of 3 points",
    );
  });
});

describe("the family print page carries the line", () => {
  test("weighted: scale set; unweighted or no score given: null", () => {
    expect(selectPrintFeedback(RUBRIC, picks(4, 2), { points: 3, max_points: 4 })?.scale).toBe(
      "Rubric 6 of 8, scaled to 3 of 4 points",
    );
    expect(selectPrintFeedback(RUBRIC, picks(4, 2), { points: 6, max_points: 8 })?.scale).toBeNull();
    expect(selectPrintFeedback(RUBRIC, picks(4, 2))?.scale).toBeNull();
  });
});

// #240 review nit 2: the weighted branch of the release table, the packet's
// teacher copy and the Doc HTML, which #240 checked by reading only.
describe("the weighted line in the release table, the packet and the Doc", () => {
  const final = (points: number, max: number, a: number, b: number): PacketScoreRow => ({
    method: "human",
    status: "final",
    reviewed_by_sub: "t1",
    points,
    max_points: max,
    rationale: picks(a, b),
    created_at: new Date("2026-11-01T00:00:00Z"),
  });
  const contents: PacketContents = {
    teacher_score: true,
    ai_score: false,
    teacher_feedback: false,
    ai_feedback: false,
    rubric_table: true,
  };
  const releaseTable = (row: PacketScoreRow) =>
    buildFeedbackRelease(contents, {
      questions: [{ rubric: RUBRIC, scores: [row], teacher_feedback: null, answer_updated_at: null }],
      overall_teacher_feedback: null,
    }).questions[0]!.find((b) => b.kind === "rubric_table") as Extract<FeedbackBlock, { kind: "rubric_table" }>;

  test("release table: the line on a weighted question, null on the rubric's own scale", () => {
    expect(releaseTable(final(2.5, 4, 4, 1)).scale).toBe("Rubric 5 of 8, scaled to 2.5 of 4 points");
    expect(releaseTable(final(5, 8, 4, 1)).scale).toBeNull();
  });

  test("release table without points beside a score: no line", () => {
    const noScore = buildFeedbackRelease({ ...contents, teacher_score: false }, {
      questions: [{ rubric: RUBRIC, scores: [final(2.5, 4, 4, 1)], teacher_feedback: null, answer_updated_at: null }],
      overall_teacher_feedback: null,
    }).questions[0]!.find((b) => b.kind === "rubric_table") as Extract<FeedbackBlock, { kind: "rubric_table" }>;
    expect(noScore.scale).toBeNull();
  });

  test("packet teacher copy: the line on a weighted question, no key otherwise", () => {
    const [weighted] = packetScoreBlocks(contents, true, [final(2.5, 4, 4, 1)], [], RUBRIC);
    expect(weighted!.scale).toBe("Rubric 5 of 8, scaled to 2.5 of 4 points");
    const [plain] = packetScoreBlocks(contents, true, [final(5, 8, 4, 1)], [], RUBRIC);
    expect("scale" in plain!).toBe(false);
  });

  test("Doc HTML prints the line, escaped, under the table", () => {
    const html = buildDocHtml({
      studentName: "S",
      assessmentName: "T",
      draftAsOf: null,
      overall: releaseTable(final(2.5, 4, 4, 1)),
      essays: [],
      contents: { ...contents, prompt: false, sources: false },
    });
    expect(html).toContain("</table><p>Rubric 5 of 8, scaled to 2.5 of 4 points</p>");
  });
});

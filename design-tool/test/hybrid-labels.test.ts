// Hybrid scoring transparency, slice 1 (docs/hybrid-scoring-transparency-design.md):
// the words a teacher reads about how a score came to be. No string here was
// pinned by a test before this slice.
import { describe, expect, test } from "bun:test";
import { HYBRID_HINT, SCORING_LABEL } from "../app/dashboard/[id]/AssessmentEditor";
import {
  finalMethodWord,
  isAiUnreviewed,
  reviewQueueUrl,
  unreviewedCardLine,
  unreviewedCountLine,
  unreviewedQueueHref,
} from "../lib/scoring/methodLabel";
import { matchesSectionFilter, NO_SECTION } from "../lib/scoring/sectionFilter";

describe("finalMethodWord", () => {
  test("auto and human keep their words", () => {
    expect(finalMethodWord({ method: "auto", reviewed_by_sub: null }, "me")).toBe("auto-scored");
    expect(finalMethodWord({ method: "human", reviewed_by_sub: "me" }, "me")).toBe(
      "scored by you",
    );
  });

  test("an AI score no one reviewed says so (D-1)", () => {
    expect(finalMethodWord({ method: "ai", reviewed_by_sub: null }, "me")).toBe(
      "AI, not reviewed",
    );
  });

  test("an approved AI score says 'by you' only to the approver (4.1)", () => {
    expect(finalMethodWord({ method: "ai", reviewed_by_sub: "me" }, "me")).toBe(
      "AI, approved by you",
    );
    expect(finalMethodWord({ method: "ai", reviewed_by_sub: "co" }, "me")).toBe("AI, approved");
  });

  test("an unknown method falls through as itself", () => {
    expect(finalMethodWord({ method: "odd", reviewed_by_sub: null }, "me")).toBe("odd");
  });
});

describe("isAiUnreviewed", () => {
  test("only an AI row with no reviewer", () => {
    expect(isAiUnreviewed({ method: "ai", reviewed_by_sub: null })).toBe(true);
    expect(isAiUnreviewed({ method: "ai", reviewed_by_sub: "t" })).toBe(false);
    expect(isAiUnreviewed({ method: "auto", reviewed_by_sub: null })).toBe(false);
  });
});

describe("the editor's scoring select (HC-1, decision 4.2)", () => {
  test("Hybrid no longer promises a review of every score", () => {
    expect(SCORING_LABEL.hybrid).toBe("Hybrid (AI finalizes confident scores)");
    expect(SCORING_LABEL.hybrid).not.toContain("review");
    expect(HYBRID_HINT).toBe(
      "AI scores it is confident about count at once. You can still change any score.",
    );
  });
});

describe("slice 2: the count line, the links and the card line", () => {
  test("count line is null at 0 and agrees in number", () => {
    expect(unreviewedCountLine(0)).toBeNull();
    expect(unreviewedCountLine(1)).toBe("1 AI score was finalized without review");
    expect(unreviewedCountLine(3)).toBe("3 AI scores were finalized without review");
  });

  test("Review them carries the section and lands on the list", () => {
    expect(unreviewedQueueHref("a1", "")).toBe("/dashboard/a1/scoring#unreviewed");
    expect(unreviewedQueueHref("a1", "Period 2")).toBe(
      "/dashboard/a1/scoring?section=Period%202#unreviewed",
    );
    expect(reviewQueueUrl("a1", "")).toBe("/api/assessments/a1/review-queue");
    expect(reviewQueueUrl("a1", NO_SECTION)).toBe(
      "/api/assessments/a1/review-queue?section=__none__",
    );
  });

  test("the card line shows no confidence (D-5)", () => {
    expect(unreviewedCardLine({ points: 4, max_points: 5 })).toBe(
      "AI scored 4 / 5 · counted, not reviewed",
    );
  });

  test("section filter: all, none, one", () => {
    expect(matchesSectionFilter("P2", "")).toBe(true);
    expect(matchesSectionFilter(null, NO_SECTION)).toBe(true);
    expect(matchesSectionFilter("P2", NO_SECTION)).toBe(false);
    expect(matchesSectionFilter("P2", "P2")).toBe(true);
    expect(matchesSectionFilter("P3", "P2")).toBe(false);
  });
});

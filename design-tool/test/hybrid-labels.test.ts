// Hybrid scoring transparency, slice 1 (docs/hybrid-scoring-transparency-design.md):
// the words a teacher reads about how a score came to be. No string here was
// pinned by a test before this slice.
import { describe, expect, test } from "bun:test";
import { HYBRID_HINT, SCORING_LABEL } from "../app/dashboard/[id]/AssessmentEditor";
import { finalMethodWord, isAiUnreviewed } from "../lib/scoring/methodLabel";

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

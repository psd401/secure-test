// R-4 (docs/rubric-upload-design.md): the "Score with AI" button on a
// needs-manual card — the only UI path to a FIRST AI proposal for an
// `ai` / `hybrid` item. No testing-library / DOM harness exists in this repo
// (see test/delete-draft-button.test.tsx), so the branch is checked as the
// pure predicate the card renders through, plus the row's own static markup.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  offersAiScoring,
  ScoreWithAiRow,
} from "../app/dashboard/[id]/scoring/ScoringQueue";

function entry(
  scoring_method: string,
  proposed: unknown | null = null,
): { item: { scoring_method: string }; proposed: unknown | null } {
  return { item: { scoring_method }, proposed };
}

const aProposal = {
  score_id: "s1",
  points: 3,
  max_points: 4,
  rationale: null,
  scorer: "bedrock",
};

describe("offersAiScoring", () => {
  test("an ai item with no proposal offers a first AI score", () => {
    expect(offersAiScoring(entry("ai"))).toBe(true);
  });

  test("a hybrid item with no proposal offers one too", () => {
    expect(offersAiScoring(entry("hybrid"))).toBe(true);
  });

  test("a human item never offers one", () => {
    expect(offersAiScoring(entry("human"))).toBe(false);
  });

  test("an auto item never offers one", () => {
    expect(offersAiScoring(entry("auto"))).toBe(false);
  });

  test("an ai item that already has a proposal does not (the card shows Re-run AI)", () => {
    expect(offersAiScoring(entry("ai", aProposal))).toBe(false);
  });

  test("a hybrid item that already has a proposal does not", () => {
    expect(offersAiScoring(entry("hybrid", aProposal))).toBe(false);
  });
});

describe("ScoreWithAiRow", () => {
  test("renders the button label and the manual-scoring hint", () => {
    const html = renderToStaticMarkup(
      <ScoreWithAiRow busy={false} onClick={() => {}} />,
    );
    expect(html).toContain("Score with AI");
    expect(html).toContain("Or score it yourself below.");
    expect(html).not.toContain('disabled=""');
  });

  test("the button is disabled while another action is in flight", () => {
    const html = renderToStaticMarkup(
      <ScoreWithAiRow busy={true} onClick={() => {}} />,
    );
    expect(html).toContain('disabled=""');
  });
});

import { describe, expect, test } from "bun:test";
import {
  describeWithheldFilters,
  withheldFilterLabels,
  withholdFeedback,
} from "../lib/scoring/withheldFeedback";

describe("withheld AI feedback (2026-11-06)", () => {
  test("labels: detail first, type as fallback, de-duplicated in order", () => {
    expect(
      withheldFilterLabels([
        { type: "managed_word", detail: "PROFANITY" },
        { type: "content_filter", detail: "HATE" },
        { type: "managed_word", detail: "PROFANITY" },
        { type: "guardrail_intervened" },
      ]),
    ).toEqual(["PROFANITY", "HATE", "guardrail_intervened"]);
  });

  test("withholdFeedback blanks every feedback string and keeps the score", () => {
    const out = withholdFeedback({
      criterion_scores: [
        { criterion_id: "c1", level_id: "l3", points: 3, rationale: "blocked text" },
        { criterion_id: "c2", level_id: "l2", points: 2, rationale: "more" },
      ],
      points: 5,
      max_points: 8,
      overall_rationale: "blocked overall",
      confidence: 0.9,
    });
    expect(out).toEqual({
      criterion_scores: [
        { criterion_id: "c1", level_id: "l3", points: 3, rationale: "" },
        { criterion_id: "c2", level_id: "l2", points: 2, rationale: "" },
      ],
      points: 5,
      max_points: 8,
      overall_rationale: "",
      confidence: 0.9,
    });
  });

  test("teacher wording names known filters and passes unknown ones through readably", () => {
    expect(describeWithheldFilters(["PROFANITY", "HATE"])).toBe("profanity word list, hate");
    expect(describeWithheldFilters(["US_SOCIAL_SECURITY_NUMBER"])).toBe("us social security number");
    expect(describeWithheldFilters([])).toBe("unspecified");
  });
});

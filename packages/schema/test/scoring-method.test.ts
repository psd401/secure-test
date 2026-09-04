import { describe, expect, test } from "bun:test";
import { ItemSchema, ScoringMethodSchema } from "../src/index.js";

describe("scoring_method on the wire", () => {
  test("enum accepts the four methods and rejects others", () => {
    for (const m of ["auto", "ai", "human", "hybrid"]) {
      expect(ScoringMethodSchema.parse(m)).toBe(m);
    }
    expect(() => ScoringMethodSchema.parse("vibes")).toThrow();
    expect(() => ScoringMethodSchema.parse(null)).toThrow();
  });

  test("every item type carries an optional scoring_method", () => {
    const mc = ItemSchema.parse({
      type: "multiple_choice_single",
      id: "i1",
      stem: "s",
      choices: [
        { id: "a", text: "A" },
        { id: "b", text: "B" },
      ],
      scoring_method: "human",
    }) as { scoring_method?: string };
    expect(mc.scoring_method).toBe("human");

    const essay = ItemSchema.parse({
      type: "essay",
      id: "i2",
      stem: "s",
      scoring_method: "hybrid",
    }) as { scoring_method?: string };
    expect(essay.scoring_method).toBe("hybrid");
  });

  test("the bundle layer is permissive: type/rubric cross-rules are NOT enforced here", () => {
    // essay + auto is invalid at the design-tool write boundary, but the
    // wire schema accepts it — import clamps (same policy as accommodations).
    const parsed = ItemSchema.parse({
      type: "essay",
      id: "i3",
      stem: "s",
      scoring_method: "auto",
    }) as { scoring_method?: string };
    expect(parsed.scoring_method).toBe("auto");
  });

  test("absent scoring_method stays absent (byte-stable old bundles)", () => {
    const parsed = ItemSchema.parse({
      type: "short_text",
      id: "i4",
      stem: "s",
    }) as { scoring_method?: string };
    expect("scoring_method" in parsed).toBe(false);
  });
});

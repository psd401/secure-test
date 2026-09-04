import { describe, expect, test } from "bun:test";
import { mockMathTranslator } from "../lib/ai/mathTranslator/provider";
import {
  TranslateMathRequest,
  TranslateMathResult,
} from "../lib/ai/mathTranslator/types";

describe("TranslateMathRequest validation", () => {
  test("accepts a valid request", () => {
    const parsed = TranslateMathRequest.parse({ prompt: "one half" });
    expect(parsed.display_mode).toBe("inline");
  });

  test("rejects empty prompt", () => {
    expect(TranslateMathRequest.safeParse({ prompt: "" }).success).toBe(false);
  });

  test("rejects unknown display_mode", () => {
    expect(
      TranslateMathRequest.safeParse({ prompt: "x", display_mode: "huge" })
        .success,
    ).toBe(false);
  });
});

describe("mockMathTranslator", () => {
  test("id is 'mock'", () => {
    expect(mockMathTranslator.id).toBe("mock");
  });

  test("'one half' renders as \\frac{1}{2}", async () => {
    const r = await mockMathTranslator.translate({
      prompt: "one half",
      display_mode: "inline",
    });
    expect(r.latex).toBe("\\frac{1}{2}");
    expect(TranslateMathResult.parse(r)).toBeTruthy();
  });

  test("numeric fractions ('3/4') become \\frac{3}{4}", async () => {
    const r = await mockMathTranslator.translate({
      prompt: "3/4 of something",
      display_mode: "inline",
    });
    expect(r.latex).toBe("\\frac{3}{4}");
  });

  test("'x squared' becomes x^2", async () => {
    const r = await mockMathTranslator.translate({
      prompt: "x squared",
      display_mode: "inline",
    });
    expect(r.latex).toBe("x^2");
  });

  test("'square root of 9' becomes \\sqrt{9}", async () => {
    const r = await mockMathTranslator.translate({
      prompt: "square root of 9",
      display_mode: "inline",
    });
    expect(r.latex).toBe("\\sqrt{9}");
  });

  test("operator words become symbols ('2 plus 3 equals 5')", async () => {
    const r = await mockMathTranslator.translate({
      prompt: "2 plus 3 equals 5",
      display_mode: "inline",
    });
    expect(r.latex).toBe("2 + 3 = 5");
  });

  test("unrecognized input echoes back with the mock prefix", async () => {
    const r = await mockMathTranslator.translate({
      prompt: "something completely unparseable",
      display_mode: "inline",
    });
    expect(r.latex).toContain("[TRANSLATE-MOCK");
  });
});

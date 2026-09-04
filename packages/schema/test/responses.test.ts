import { describe, expect, test } from "bun:test";
import { ItemResponseSchema } from "../src/index.js";

describe("ItemResponseSchema", () => {
  const valid = [
    { type: "drawing_upload", upload_id: "11111111-1111-4111-8111-111111111111" },
    { type: "multiple_choice_single", choice_id: "c1" },
    { type: "multiple_choice_multi", choice_ids: ["c1", "c3"] },
    { type: "short_text", text: "photosynthesis" },
    { type: "short_text", text: "" }, // blank submission is representable
    { type: "essay", text: "A longer response spanning several sentences." },
  ] as const;

  test.each(valid.map((v) => [v.type, v] as const))(
    "accepts and round-trips a %s response",
    (_type, value) => {
      const parsed = ItemResponseSchema.parse(value);
      // JSON round-trip (jsonb storage) must be lossless.
      expect(ItemResponseSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(
        parsed,
      );
    },
  );

  test("rejects an unknown type discriminant", () => {
    expect(() =>
      ItemResponseSchema.parse({ type: "match", pairs: [] }),
    ).toThrow();
  });

  test("rejects a single-select response missing choice_id", () => {
    expect(() =>
      ItemResponseSchema.parse({ type: "multiple_choice_single" }),
    ).toThrow();
  });

  test("rejects a single-select response with an empty choice_id", () => {
    expect(() =>
      ItemResponseSchema.parse({ type: "multiple_choice_single", choice_id: "" }),
    ).toThrow();
  });

  test("rejects a multi-select response with an empty selection", () => {
    // No selection = no responses row, not an empty array.
    expect(() =>
      ItemResponseSchema.parse({ type: "multiple_choice_multi", choice_ids: [] }),
    ).toThrow();
  });

  test("rejects wrong-shaped payload under a valid discriminant", () => {
    expect(() =>
      ItemResponseSchema.parse({ type: "essay", choice_id: "c1" }),
    ).toThrow();
  });
});

// Phase 4 slice 47: match responses.
describe("MatchResponseSchema (via ItemResponseSchema)", () => {
  test("accepts a pair-id mapping", () => {
    const parsed = ItemResponseSchema.parse({
      type: "match",
      matches: { p1: "p2", p2: "p1" },
    });
    expect(parsed.type).toBe("match");
  });

  test("rejects an empty-string mapping value", () => {
    const r = ItemResponseSchema.safeParse({
      type: "match",
      matches: { p1: "" },
    });
    expect(r.success).toBe(false);
  });

  test("rejects a non-record matches payload", () => {
    const r = ItemResponseSchema.safeParse({
      type: "match",
      matches: ["p1", "p2"],
    });
    expect(r.success).toBe(false);
  });
});

// Phase 4 slice 48: order responses.
describe("OrderResponseSchema (via ItemResponseSchema)", () => {
  test("accepts an ordered id list", () => {
    const parsed = ItemResponseSchema.parse({
      type: "order",
      ordered_ids: ["s2", "s1", "s3"],
    });
    expect(parsed.type).toBe("order");
  });

  test("rejects an empty list", () => {
    const r = ItemResponseSchema.safeParse({ type: "order", ordered_ids: [] });
    expect(r.success).toBe(false);
  });

  test("rejects empty-string ids", () => {
    const r = ItemResponseSchema.safeParse({
      type: "order",
      ordered_ids: ["s1", ""],
    });
    expect(r.success).toBe(false);
  });
});

// Phase 4 slice 49: hotspot responses.
describe("HotspotResponseSchema (via ItemResponseSchema)", () => {
  test("accepts marked region ids", () => {
    const parsed = ItemResponseSchema.parse({
      type: "hotspot",
      region_ids: ["r1", "r3"],
    });
    expect(parsed.type).toBe("hotspot");
  });

  test("rejects an empty selection", () => {
    const r = ItemResponseSchema.safeParse({ type: "hotspot", region_ids: [] });
    expect(r.success).toBe(false);
  });
});

// Phase 4 slice 50: drawing_upload deliberately has NO response variant —
// student ingest is deferred to the student-app plan.
describe("drawing_upload responses (slice 50)", () => {
  test("ItemResponseSchema rejects type drawing_upload", () => {
    const r = ItemResponseSchema.safeParse({
      type: "drawing_upload",
      anything: true,
    });
    expect(r.success).toBe(false);
  });
});

// E3 slice 1: table responses — the filled cells, row id → column id → text.
describe("TableResponseSchema (via ItemResponseSchema)", () => {
  test("accepts filled cells and round-trips them", () => {
    const parsed = ItemResponseSchema.parse({
      type: "table",
      cells: { r1: { c1: "12", c2: "" }, r2: { c1: "1.5" } },
    });
    expect(parsed.type).toBe("table");
    if (parsed.type === "table") {
      expect(parsed.cells.r1?.c1).toBe("12");
      expect(parsed.cells.r1?.c2).toBe("");
    }
  });

  test("rejects a response with no cells at all — an all-blank table is the absence of a response", () => {
    expect(ItemResponseSchema.safeParse({ type: "table", cells: {} }).success).toBe(false);
    expect(ItemResponseSchema.safeParse({ type: "table", cells: { r1: {} } }).success).toBe(false);
  });

  test("rejects an empty row or column id", () => {
    expect(ItemResponseSchema.safeParse({ type: "table", cells: { "": { c1: "1" } } }).success).toBe(false);
    expect(ItemResponseSchema.safeParse({ type: "table", cells: { r1: { "": "1" } } }).success).toBe(false);
  });

  test("caps a cell at 500 characters", () => {
    const r = ItemResponseSchema.safeParse({ type: "table", cells: { r1: { c1: "x".repeat(501) } } });
    expect(r.success).toBe(false);
  });
});

import { describe, expect, test } from "bun:test";
import {
  DeliveryBundleSchema,
  DeliveryItemSchema,
} from "../src/delivery.js";

const CHOICES = [
  { id: "c1", text: "one" },
  { id: "c2", text: "two" },
];

describe("DeliveryItemSchema", () => {
  test("accepts every item type the authoring format can produce", () => {
    const items = [
      { type: "multiple_choice_single", id: "i1", stem: "s", choices: CHOICES },
      { type: "multiple_choice_multi", id: "i2", stem: "s", choices: CHOICES },
      { type: "short_text", id: "i3", stem: "s" },
      { type: "essay", id: "i4", stem: "s" },
      {
        type: "match",
        id: "i5",
        stem: "s",
        lefts: [{ id: "p1", text: "L1" }, { id: "p2", text: "L2" }],
        rights: [{ id: "p2", text: "R2" }, { id: "p1", text: "R1" }],
      },
      {
        type: "order",
        id: "i6",
        stem: "s",
        entries: [{ id: "e2", label: "B" }, { id: "e1", label: "A" }],
      },
      { type: "hotspot", id: "i7", stem: "s", regions: [] },
      { type: "drawing_upload", id: "i8", stem: "s" },
      {
        type: "table",
        id: "i9",
        stem: "s",
        columns: [{ id: "c1", label: "Trial 1" }],
        rows: [{ id: "r1", label: "Mass (g)" }],
      },
    ];
    for (const item of items) {
      expect(() => DeliveryItemSchema.parse(item)).not.toThrow();
    }
    // Guards against a type being added to authoring without a delivery shape.
    expect(items.length).toBe(9);
  });

  // Drawing background: the student bundle reuses DrawingCanvasSchema, so the
  // field has to survive the delivery parse or the client never sees the paper.
  test("a drawing item keeps canvas.background", () => {
    const parsed = DeliveryItemSchema.parse({
      type: "drawing_upload",
      id: "i8",
      stem: "Graph it",
      canvas: { width: 800, height: 600, background: "axes" },
    });
    if (parsed.type === "drawing_upload") {
      expect(parsed.canvas).toEqual({ width: 800, height: 600, background: "axes" });
    }
  });

  test("requires an explicit type — no legacy defaulting like ItemSchema", () => {
    expect(() =>
      DeliveryItemSchema.parse({ id: "i1", stem: "s", choices: CHOICES }),
    ).toThrow();
  });

  test("rejects an unknown type", () => {
    expect(() =>
      DeliveryItemSchema.parse({ type: "essay_v2", id: "i1", stem: "s" }),
    ).toThrow();
  });

  // The load-bearing property of this schema: there is no field for an answer
  // key, so a caller that forgets to drop one has it stripped rather than
  // shipped. Zod strips unknown keys by default; these assert it stays that way.
  test("strips answer-key fields that a caller leaks in", () => {
    const single = DeliveryItemSchema.parse({
      type: "multiple_choice_single",
      id: "i1",
      stem: "s",
      choices: CHOICES,
      correct_choice_id: "c1",
    });
    expect(single).not.toHaveProperty("correct_choice_id");

    const multi = DeliveryItemSchema.parse({
      type: "multiple_choice_multi",
      id: "i2",
      stem: "s",
      choices: CHOICES,
      correct_choice_ids: ["c1"],
    });
    expect(multi).not.toHaveProperty("correct_choice_ids");

    const short = DeliveryItemSchema.parse({
      type: "short_text",
      id: "i3",
      stem: "s",
      correct_answer: "42",
    });
    expect(short).not.toHaveProperty("correct_answer");

    const hotspot = DeliveryItemSchema.parse({
      type: "hotspot",
      id: "i7",
      stem: "s",
      regions: [{ id: "r1", x: 0, y: 0, w: 0.5, h: 0.5 }],
      correct_region_ids: ["r1"],
    });
    expect(hotspot).not.toHaveProperty("correct_region_ids");
    // regions survive — the client cannot draw the item without them.
    expect((hotspot as { regions: unknown[] }).regions.length).toBe(1);

    // E3 slice 1: the grid survives, the expected cell text does not.
    const table = DeliveryItemSchema.parse({
      type: "table",
      id: "i9",
      stem: "s",
      columns: [{ id: "c1", label: "Observed" }],
      rows: [{ id: "r1", label: "Middle" }],
      corner: "Chamber",
      cell_keys: { r1: { c1: "12" } },
    });
    expect(table).not.toHaveProperty("cell_keys");
    expect(JSON.stringify(table)).not.toContain("12");
    expect((table as { columns: unknown[] }).columns.length).toBe(1);
    expect((table as { corner?: string }).corner).toBe("Chamber");
  });

  test("strips scoring_method on every type", () => {
    const parsed = DeliveryItemSchema.parse({
      type: "essay",
      id: "i4",
      stem: "s",
      scoring_method: "ai",
    });
    expect(parsed).not.toHaveProperty("scoring_method");
  });

  test("match has no field that pairs a left to its right", () => {
    const parsed = DeliveryItemSchema.parse({
      type: "match",
      id: "i5",
      stem: "s",
      lefts: [{ id: "p1", text: "L1" }, { id: "p2", text: "L2" }],
      rights: [{ id: "p2", text: "R2" }, { id: "p1", text: "R1" }],
      pairs: [{ id: "p1", left: "L1", right: "R1" }],
    });
    expect(parsed).not.toHaveProperty("pairs");
  });

  test("order carries entries, never the authored sequence field", () => {
    const parsed = DeliveryItemSchema.parse({
      type: "order",
      id: "i6",
      stem: "s",
      entries: [{ id: "e2", label: "B" }, { id: "e1", label: "A" }],
      sequence: [{ id: "e1", label: "A" }, { id: "e2", label: "B" }],
    });
    expect(parsed).not.toHaveProperty("sequence");
  });

  test("match and order need at least two options to be answerable", () => {
    expect(() =>
      DeliveryItemSchema.parse({
        type: "match",
        id: "i5",
        stem: "s",
        lefts: [{ id: "p1", text: "L1" }],
        rights: [{ id: "p1", text: "R1" }],
      }),
    ).toThrow();
    expect(() =>
      DeliveryItemSchema.parse({
        type: "order",
        id: "i6",
        stem: "s",
        entries: [{ id: "e1", label: "A" }],
      }),
    ).toThrow();
  });
});

describe("DeliveryBundleSchema", () => {
  const base = {
    test_id: "11111111-1111-4111-8111-111111111111",
    title: "Quiz",
    items: [
      { type: "short_text", id: "i1", stem: "s" },
    ],
  };

  test("accepts a minimal bundle and omits absent optional keys", () => {
    const parsed = DeliveryBundleSchema.parse(base);
    expect(parsed).not.toHaveProperty("assets");
    expect(parsed).not.toHaveProperty("accommodations");
  });

  test("carries the effective accommodations, with their setting values", () => {
    const parsed = DeliveryBundleSchema.parse({
      ...base,
      accommodations: { spell_check: "On", color_contrast: "Black on Rose" },
      construct_altering: ["spell_check"],
    });
    // The value matters: "on" alone would not tell a client which contrast.
    expect(parsed.accommodations).toEqual({
      spell_check: "On",
      color_contrast: "Black on Rose",
    });
    expect(parsed.construct_altering).toEqual(["spell_check"]);
  });

  test("has no field for the authoring-side allowed list", () => {
    const parsed = DeliveryBundleSchema.parse({
      ...base,
      allowed_accommodations: ["spell_check"],
    });
    expect(parsed).not.toHaveProperty("allowed_accommodations");
  });

  test("rejects a non-uuid asset key", () => {
    expect(() =>
      DeliveryBundleSchema.parse({
        ...base,
        assets: { "not-a-uuid": { content_type: "image/png", base64: "AA==" } },
      }),
    ).toThrow();
  });

  test("accepts a uuid-keyed asset blob", () => {
    const parsed = DeliveryBundleSchema.parse({
      ...base,
      assets: {
        "22222222-2222-4222-8222-222222222222": {
          content_type: "image/png",
          base64: "AA==",
        },
      },
    });
    expect(Object.keys(parsed.assets ?? {}).length).toBe(1);
  });
});

// E5 slice 1: the student bundle carries item_sets with the same rules.
describe("DeliveryBundleSchema item_sets (E5 slice 1)", () => {
  const items = [
    { type: "essay", id: "i1", stem: "One" },
    { type: "essay", id: "i2", stem: "Two" },
  ];
  test("accepts a contiguous set and rejects a split one", () => {
    expect(
      DeliveryBundleSchema.safeParse({
        test_id: "t", title: "T", items,
        item_sets: [{ id: "s", stimulus: "Look at the graph.", layout: "own_page", item_ids: ["i1", "i2"] }],
      }).success,
    ).toBe(true);
    expect(
      DeliveryBundleSchema.safeParse({
        test_id: "t", title: "T", items: [...items, { type: "essay", id: "i3", stem: "Three" }],
        item_sets: [{ id: "s", stimulus: "x", item_ids: ["i1", "i3"] }],
      }).success,
    ).toBe(false);
  });

  // Multi-source stimulus slice 2: sources are student-facing, so the student
  // bundle carries the same shape the teacher bundle does (nothing here can
  // hold a key, so ADR 0016's two-format rule is untouched).
  test("carries sources and side_by_side; a set without the key parses as []", () => {
    const parsed = DeliveryBundleSchema.parse({
      test_id: "t", title: "T", items,
      item_sets: [{
        id: "s",
        stimulus: "Use all four sources.",
        layout: "side_by_side",
        sources: [{ label: "Source A", text: "A poem\nin two lines" }, { label: "Source B", text: "An article." }],
        item_ids: ["i1", "i2"],
      }],
    });
    expect(parsed.item_sets![0]!.layout).toBe("side_by_side");
    expect(parsed.item_sets![0]!.sources.map((s) => s.label)).toEqual(["Source A", "Source B"]);
    const older = DeliveryBundleSchema.parse({
      test_id: "t", title: "T", items,
      item_sets: [{ id: "s", stimulus: "x", item_ids: ["i1", "i2"] }],
    });
    expect(older.item_sets![0]!.sources).toEqual([]);
  });

  test("rejects a 13th source and an empty label", () => {
    const withSources = (sources: unknown) => ({
      test_id: "t", title: "T", items,
      item_sets: [{ id: "s", stimulus: "x", sources, item_ids: ["i1", "i2"] }],
    });
    expect(DeliveryBundleSchema.safeParse(withSources(Array.from({ length: 13 }, (_, i) => ({ label: `S${i}`, text: "x" })))).success).toBe(false);
    expect(DeliveryBundleSchema.safeParse(withSources([{ label: "", text: "x" }])).success).toBe(false);
  });
});

// Client paging: the bundle-level layout flag, optional, "scroll" | "paged".
describe("DeliveryBundleSchema layout (client paging)", () => {
  test("accepts paged, accepts absence, rejects other values", () => {
    const base = { test_id: "t", title: "t", items: [] };
    expect(DeliveryBundleSchema.parse({ ...base, layout: "paged" }).layout).toBe("paged");
    expect(DeliveryBundleSchema.parse(base).layout).toBeUndefined();
    expect(DeliveryBundleSchema.safeParse({ ...base, layout: "sideways" }).success).toBe(false);
  });
});

// Client paging follow-up: the answered ids, optional, never a key.
describe("DeliveryBundleSchema answered_item_ids", () => {
  test("accepts a list of ids, accepts absence, rejects an empty id", () => {
    const base = { test_id: "t", title: "t", items: [] };
    expect(DeliveryBundleSchema.parse({ ...base, answered_item_ids: ["a", "b"] }).answered_item_ids).toEqual(["a", "b"]);
    expect(DeliveryBundleSchema.parse(base).answered_item_ids).toBeUndefined();
    expect(DeliveryBundleSchema.safeParse({ ...base, answered_item_ids: [""] }).success).toBe(false);
  });
});

// P-1 (docs/resume-prefill-design.md): this attempt's saved answers and the
// drawing bytes they name. The values are the student-response union, so the
// field cannot express anything but an answer a student posted.
describe("DeliveryBundleSchema saved_responses / saved_uploads", () => {
  const base = { test_id: "t", title: "t", items: [] };
  const UPLOAD_ID = "33333333-3333-4333-8333-333333333333";

  test("both are absent by default", () => {
    const parsed = DeliveryBundleSchema.parse(base);
    expect(parsed).not.toHaveProperty("saved_responses");
    expect(parsed).not.toHaveProperty("saved_uploads");
  });

  test("carries every response shape verbatim, keyed by item id", () => {
    const saved_responses = {
      i1: { type: "multiple_choice_single", choice_id: "c1" },
      i2: { type: "multiple_choice_multi", choice_ids: ["c1", "c2"] },
      i3: { type: "short_text", text: "42" },
      i4: { type: "essay", text: "words" },
      i5: { type: "match", matches: { l1: "r1" } },
      i6: { type: "order", ordered_ids: ["e2", "e1"] },
      i7: { type: "hotspot", region_ids: ["r1"] },
      i8: { type: "drawing_upload", upload_id: UPLOAD_ID },
      i9: { type: "table", cells: { r1: { c1: "12" } } },
    };
    const parsed = DeliveryBundleSchema.parse({ ...base, saved_responses });
    expect(parsed.saved_responses).toEqual(saved_responses);
  });

  test("refuses a value whose type is not a response type", () => {
    expect(
      DeliveryBundleSchema.safeParse({
        ...base,
        saved_responses: { i1: { type: "essay_v2", text: "x" } },
      }).success,
    ).toBe(false);
    // Nor an item shape wearing a response's clothes: a stray key field on a
    // value is stripped by the union member, never carried.
    const parsed = DeliveryBundleSchema.parse({
      ...base,
      saved_responses: { i1: { type: "short_text", text: "x", correct_answer: "42" } },
    });
    expect(parsed.saved_responses!.i1).not.toHaveProperty("correct_answer");
    expect(JSON.stringify(parsed)).not.toContain("42");
  });

  test("refuses an empty item id key", () => {
    expect(
      DeliveryBundleSchema.safeParse({
        ...base,
        saved_responses: { "": { type: "essay", text: "x" } },
      }).success,
    ).toBe(false);
  });

  test("saved_uploads is a uuid-keyed blob map, like assets", () => {
    const parsed = DeliveryBundleSchema.parse({
      ...base,
      saved_uploads: { [UPLOAD_ID]: { content_type: "image/png", base64: "AA==" } },
    });
    expect(parsed.saved_uploads?.[UPLOAD_ID]?.content_type).toBe("image/png");
    expect(
      DeliveryBundleSchema.safeParse({
        ...base,
        saved_uploads: { "not-a-uuid": { content_type: "image/png", base64: "AA==" } },
      }).success,
    ).toBe(false);
  });
});

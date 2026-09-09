import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { ItemBundleSchema, ItemSchema, RubricSchema } from "../src/items.js";

const here = dirname(fileURLToPath(import.meta.url));
const pocBItemsJsonPath = resolve(
  here,
  "../../../poc-b-test-loop/client/Sources/PocBClient/Resources/items.json",
);

describe("ItemBundleSchema round-trip with PoC-B items.json", () => {
  test("parses the live PoC-B fixture without errors", () => {
    const raw = JSON.parse(readFileSync(pocBItemsJsonPath, "utf8"));
    const parsed = ItemBundleSchema.parse(raw);
    expect(parsed.test_id).toBe("poc-b-sample-test");
    expect(parsed.items.length).toBeGreaterThanOrEqual(3);
    for (const item of parsed.items) {
      expect(typeof item.id).toBe("string");
      if (item.type === "multiple_choice_single" || item.type === "multiple_choice_multi") {
        expect(item.choices.length).toBeGreaterThan(0);
      }
    }
  });

  test("the PoC-B fixture now exercises all three item types", () => {
    const raw = JSON.parse(readFileSync(pocBItemsJsonPath, "utf8"));
    const parsed = ItemBundleSchema.parse(raw);
    const types = new Set(parsed.items.map((i) => i.type));
    expect(types.has("multiple_choice_single")).toBe(true);
    expect(types.has("multiple_choice_multi")).toBe(true);
    expect(types.has("short_text")).toBe(true);
  });
});

describe("backward-compat: items without a `type` field", () => {
  test("default to multiple_choice_single", () => {
    const legacy = {
      id: "q1",
      stem: "What is 2+2?",
      choices: [
        { id: "a", text: "3" },
        { id: "b", text: "4" },
      ],
      correct_choice_id: "b",
    };
    const parsed = ItemSchema.parse(legacy);
    expect(parsed.type).toBe("multiple_choice_single");
    if (parsed.type === "multiple_choice_single") {
      expect(parsed.correct_choice_id).toBe("b");
    }
  });
});

describe("ItemSchema discriminated union", () => {
  test("multi-select MC parses with correct_choice_ids", () => {
    const parsed = ItemSchema.parse({
      type: "multiple_choice_multi",
      id: "qm",
      stem: "Pick the primary colors",
      choices: [
        { id: "r", text: "Red" },
        { id: "g", text: "Green" },
        { id: "b", text: "Blue" },
      ],
      correct_choice_ids: ["r", "b"],
    });
    expect(parsed.type).toBe("multiple_choice_multi");
    if (parsed.type === "multiple_choice_multi") {
      expect(parsed.correct_choice_ids).toEqual(["r", "b"]);
    }
  });

  test("short_text parses with correct_answer and no choices", () => {
    const parsed = ItemSchema.parse({
      type: "short_text",
      id: "qs",
      stem: "Capital of WA?",
      correct_answer: "Olympia",
    });
    expect(parsed.type).toBe("short_text");
    if (parsed.type === "short_text") {
      expect(parsed.correct_answer).toBe("Olympia");
    }
  });

  test("essay parses with stem only (metadata optional)", () => {
    const parsed = ItemSchema.parse({
      type: "essay",
      id: "qe",
      stem: "Defend your thesis in two paragraphs.",
    });
    expect(parsed.type).toBe("essay");
    if (parsed.type === "essay") {
      expect(parsed.max_word_count).toBeUndefined();
      expect(parsed.placeholder).toBeUndefined();
    }
  });

  test("essay carries max_word_count + placeholder when present", () => {
    const parsed = ItemSchema.parse({
      type: "essay",
      id: "qe2",
      stem: "Explain.",
      max_word_count: 250,
      placeholder: "Write your response here…",
    });
    if (parsed.type === "essay") {
      expect(parsed.max_word_count).toBe(250);
      expect(parsed.placeholder).toBe("Write your response here…");
    }
  });

  test("essay rejects a non-positive max_word_count", () => {
    const result = ItemSchema.safeParse({
      type: "essay",
      id: "qe3",
      stem: "?",
      max_word_count: 0,
    });
    expect(result.success).toBe(false);
  });

  // 2026-09-01 (design-tool slice B, wire schema loosened in slice C): a
  // keyless multi-select is a legal draft, so an empty list parses. The
  // readiness checklist, not the schema, is what flags a missing key.
  test("multi-select with empty correct_choice_ids is accepted (keyless draft)", () => {
    const result = ItemSchema.safeParse({
      type: "multiple_choice_multi",
      id: "x",
      stem: "?",
      choices: [
        { id: "a", text: "A" },
        { id: "b", text: "B" },
      ],
      correct_choice_ids: [],
    });
    expect(result.success).toBe(true);
    if (result.success && result.data.type === "multiple_choice_multi") {
      expect(result.data.correct_choice_ids).toEqual([]);
    }
  });

  test("MC with only one choice is rejected", () => {
    const result = ItemSchema.safeParse({
      type: "multiple_choice_single",
      id: "x",
      stem: "?",
      choices: [{ id: "a", text: "only one" }],
      correct_choice_id: "a",
    });
    expect(result.success).toBe(false);
  });
});

describe("essay rubric (slice 33)", () => {
  const lvl = (label: string, points: number, descriptor?: string) => ({
    id: label,
    label,
    points,
    ...(descriptor ? { descriptor } : {}),
  });
  const analyticRubric = {
    style: "analytic" as const,
    criteria: [
      { id: "c1", name: "Thesis", levels: [lvl("Weak", 0), lvl("Strong", 2)] },
      {
        id: "c2",
        name: "Evidence",
        levels: [lvl("None", 0), lvl("Some", 1), lvl("Ample", 2)],
      },
    ],
  };

  test("essay carries a valid analytic rubric", () => {
    const parsed = ItemSchema.parse({
      type: "essay",
      id: "e",
      stem: "x",
      rubric: analyticRubric,
    });
    if (parsed.type === "essay") {
      expect(parsed.rubric?.style).toBe("analytic");
      expect(parsed.rubric?.criteria.length).toBe(2);
    }
  });

  test("holistic must have exactly one criterion", () => {
    const ok = RubricSchema.safeParse({
      style: "holistic",
      criteria: [
        { id: "o", name: "Overall", levels: [lvl("1", 1), lvl("6", 6)] },
      ],
    });
    expect(ok.success).toBe(true);
    const bad = RubricSchema.safeParse({
      style: "holistic",
      criteria: analyticRubric.criteria,
    });
    expect(bad.success).toBe(false);
  });

  test("single_point requires exactly one level per criterion", () => {
    const ok = RubricSchema.safeParse({
      style: "single_point",
      criteria: [
        {
          id: "c",
          name: "Focus",
          levels: [lvl("Target", 3, "Maintains a clear focus")],
        },
      ],
    });
    expect(ok.success).toBe(true);
    const bad = RubricSchema.safeParse({
      style: "single_point",
      criteria: [
        { id: "c", name: "Focus", levels: [lvl("a", 1), lvl("b", 2)] },
      ],
    });
    expect(bad.success).toBe(false);
  });

  test("analytic criteria need at least two levels", () => {
    const bad = RubricSchema.safeParse({
      style: "analytic",
      criteria: [{ id: "c", name: "X", levels: [lvl("only", 1)] }],
    });
    expect(bad.success).toBe(false);
  });

  test("rejects a negative level points value", () => {
    const bad = RubricSchema.safeParse({
      style: "analytic",
      criteria: [{ id: "c", name: "X", levels: [lvl("a", -1), lvl("b", 2)] }],
    });
    expect(bad.success).toBe(false);
  });

  test("student_visibility flags round-trip", () => {
    const parsed = RubricSchema.parse({
      ...analyticRubric,
      student_visibility: { during_test: true, with_feedback: false },
    });
    expect(parsed.student_visibility?.during_test).toBe(true);
    expect(parsed.student_visibility?.with_feedback).toBe(false);
  });
});

describe("ItemBundleSchema — bundled assets (slice 15)", () => {
  test("a bundle with no `assets` field parses (backward compat)", () => {
    const parsed = ItemBundleSchema.parse({
      test_id: "no-assets",
      title: "x",
      items: [],
    });
    expect(parsed.assets).toBeUndefined();
  });

  test("accepts a bundle with one valid asset entry", () => {
    const parsed = ItemBundleSchema.parse({
      test_id: "with-asset",
      title: "x",
      items: [],
      assets: {
        "11111111-1111-1111-1111-111111111111": {
          content_type: "image/png",
          base64: "iVBORw0KGgo=",
        },
      },
    });
    expect(Object.keys(parsed.assets!).length).toBe(1);
  });

  test("rejects an asset key that isn't a uuid", () => {
    const result = ItemBundleSchema.safeParse({
      test_id: "bad-key",
      title: "x",
      items: [],
      assets: {
        "not-a-uuid": { content_type: "image/png", base64: "x" },
      },
    });
    expect(result.success).toBe(false);
  });

  test("rejects an asset entry missing content_type", () => {
    const result = ItemBundleSchema.safeParse({
      test_id: "x",
      title: "x",
      items: [],
      assets: {
        "11111111-1111-1111-1111-111111111111": { base64: "x" },
      },
    });
    expect(result.success).toBe(false);
  });
});

describe("ItemSchema rejects malformed input", () => {
  test("missing required `stem` produces a clear error path", () => {
    const bad = {
      type: "multiple_choice_single",
      id: "q1",
      choices: [
        { id: "a", text: "x" },
        { id: "b", text: "y" },
      ],
      correct_choice_id: "a",
    };
    const result = ItemSchema.safeParse(bad);
    expect(result.success).toBe(false);
    if (!result.success) {
      const stemIssue = result.error.issues.find(
        (i) => i.path[0] === "stem",
      );
      expect(stemIssue).toBeDefined();
    }
  });

  test("unknown `type` value is rejected", () => {
    // `essay` became a valid type in slice 32; use a still-unsupported type
    // here to keep pinning the union's rejection of unknown discriminants.
    const result = ItemSchema.safeParse({
      type: "fill_in_blank",
      id: "x",
      stem: "?",
    });
    expect(result.success).toBe(false);
  });
});

describe("ItemBundleSchema — accommodations (slice 21)", () => {
  test("bundle without accommodations fields parses", () => {
    const parsed = ItemBundleSchema.parse({
      test_id: "no-accoms",
      title: "x",
      items: [],
    });
    expect(parsed.allowed_accommodations).toBeUndefined();
    expect(parsed.construct_altering).toBeUndefined();
  });

  test("bundle carrying only allowed_accommodations parses", () => {
    const parsed = ItemBundleSchema.parse({
      test_id: "allowed-only",
      title: "x",
      items: [],
      allowed_accommodations: ["color_contrast", "highlighter"],
    });
    expect(parsed.allowed_accommodations).toEqual([
      "color_contrast",
      "highlighter",
    ]);
    expect(parsed.construct_altering).toBeUndefined();
  });

  test("bundle carrying both arrays parses (subset is the importer's job)", () => {
    // The wire schema does NOT enforce subset — keeping it permissive
    // means importers can clamp lenient and surface a count. This test
    // pins the permissive contract.
    const parsed = ItemBundleSchema.parse({
      test_id: "both",
      title: "x",
      items: [],
      allowed_accommodations: ["color_contrast"],
      construct_altering: ["tts_for_ela_reading"], // not in allowed
    });
    expect(parsed.construct_altering).toEqual(["tts_for_ela_reading"]);
  });

  test("non-string entries are rejected", () => {
    const result = ItemBundleSchema.safeParse({
      test_id: "bad",
      title: "x",
      items: [],
      allowed_accommodations: [123, "ok"],
    });
    expect(result.success).toBe(false);
  });
});

// Phase 4 slice 47: match items on the wire.
describe("MatchItemSchema (via ItemSchema)", () => {
  const valid = {
    type: "match",
    id: "m1",
    stem: "Match each animal to its sound",
    pairs: [
      { id: "p1", left: "Dog", right: "Woof" },
      { id: "p2", left: "Cat", right: "Meow" },
    ],
  };

  test("accepts a valid match item and round-trips pairs", () => {
    const parsed = ItemSchema.parse(valid);
    expect(parsed.type).toBe("match");
    if (parsed.type === "match") {
      expect(parsed.pairs).toEqual(valid.pairs);
    }
  });

  test("rejects fewer than two pairs", () => {
    const r = ItemSchema.safeParse({ ...valid, pairs: [valid.pairs[0]] });
    expect(r.success).toBe(false);
  });

  test("rejects a pair with an empty side", () => {
    const r = ItemSchema.safeParse({
      ...valid,
      pairs: [
        { id: "p1", left: "", right: "Woof" },
        { id: "p2", left: "Cat", right: "Meow" },
      ],
    });
    expect(r.success).toBe(false);
  });

  test("a bundle containing a match item parses", () => {
    const bundle = ItemBundleSchema.parse({
      test_id: "t1",
      title: "With match",
      items: [valid],
    });
    expect(bundle.items[0]!.type).toBe("match");
  });
});

// Phase 4 slice 48: order items on the wire.
describe("OrderItemSchema (via ItemSchema)", () => {
  const valid = {
    type: "order",
    id: "o1",
    stem: "Put the steps in order",
    sequence: [
      { id: "s1", label: "First" },
      { id: "s2", label: "Second" },
    ],
  };

  test("accepts a valid order item and round-trips the sequence", () => {
    const parsed = ItemSchema.parse(valid);
    expect(parsed.type).toBe("order");
    if (parsed.type === "order") {
      expect(parsed.sequence).toEqual(valid.sequence);
    }
  });

  test("rejects fewer than two entries", () => {
    const r = ItemSchema.safeParse({ ...valid, sequence: [valid.sequence[0]] });
    expect(r.success).toBe(false);
  });

  test("rejects an entry with an empty label", () => {
    const r = ItemSchema.safeParse({
      ...valid,
      sequence: [
        { id: "s1", label: "" },
        { id: "s2", label: "Second" },
      ],
    });
    expect(r.success).toBe(false);
  });

  test("a bundle containing an order item parses", () => {
    const bundle = ItemBundleSchema.parse({
      test_id: "t1",
      title: "With order",
      items: [valid],
    });
    expect(bundle.items[0]!.type).toBe("order");
  });
});

// Phase 4 slice 49: hotspot items on the wire.
describe("HotspotItemSchema (via ItemSchema)", () => {
  const valid = {
    type: "hotspot",
    id: "h1",
    stem: "Mark the state capital on the map",
    image_asset_id: "22222222-2222-2222-2222-222222222222",
    regions: [
      { id: "r1", x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
      { id: "r2", x: 0.5, y: 0.5, w: 0.3, h: 0.3 },
    ],
    correct_region_ids: ["r1"],
  };

  test("accepts a configured hotspot and round-trips regions + key", () => {
    const parsed = ItemSchema.parse(valid);
    expect(parsed.type).toBe("hotspot");
    if (parsed.type === "hotspot") {
      expect(parsed.regions).toEqual(valid.regions);
      expect(parsed.correct_region_ids).toEqual(["r1"]);
    }
  });

  test("accepts a draft hotspot (no image, no regions)", () => {
    const r = ItemSchema.safeParse({ type: "hotspot", id: "h2", stem: "Draft" });
    expect(r.success).toBe(true);
  });

  test("rejects out-of-range region coordinates", () => {
    const r = ItemSchema.safeParse({
      ...valid,
      regions: [{ id: "r1", x: 1.2, y: 0, w: 0.1, h: 0.1 }],
    });
    expect(r.success).toBe(false);
  });

  test("a bundle containing a hotspot item parses", () => {
    const bundle = ItemBundleSchema.parse({
      test_id: "t1",
      title: "With hotspot",
      items: [valid],
    });
    expect(bundle.items[0]!.type).toBe("hotspot");
  });
});

// Phase 4 slice 50: drawing/upload items (authoring-only) on the wire.
describe("DrawingUploadItemSchema (via ItemSchema)", () => {
  test("accepts a configured drawing item", () => {
    const parsed = ItemSchema.parse({
      type: "drawing_upload",
      id: "d1",
      stem: "Draw the water cycle",
      prompt_asset_id: "88888888-8888-8888-8888-888888888888",
      canvas: { width: 800, height: 600 },
    });
    expect(parsed.type).toBe("drawing_upload");
    if (parsed.type === "drawing_upload") {
      expect(parsed.canvas).toEqual({ width: 800, height: 600 });
    }
  });

  test("accepts a bare prompt (no reference image, no canvas)", () => {
    const r = ItemSchema.safeParse({
      type: "drawing_upload",
      id: "d2",
      stem: "Sketch it",
    });
    expect(r.success).toBe(true);
  });

  test("rejects out-of-range canvas dimensions", () => {
    const r = ItemSchema.safeParse({
      type: "drawing_upload",
      id: "d3",
      stem: "Tiny",
      canvas: { width: 10, height: 600 },
    });
    expect(r.success).toBe(false);
  });

  // Drawing background (docs/drawing-background-design.md): the only two
  // values, and the absence of the field, are the whole vocabulary.
  test("accepts canvas.background grid and axes", () => {
    for (const background of ["grid", "axes"] as const) {
      const parsed = ItemSchema.parse({
        type: "drawing_upload",
        id: "d4",
        stem: "Graph it",
        canvas: { width: 800, height: 600, background },
      });
      if (parsed.type === "drawing_upload") {
        expect(parsed.canvas).toEqual({ width: 800, height: 600, background });
      }
    }
  });

  test("a canvas with no background parses as blank (field absent)", () => {
    const parsed = ItemSchema.parse({
      type: "drawing_upload",
      id: "d5",
      stem: "Sketch it",
      canvas: { width: 800, height: 600 },
    });
    if (parsed.type === "drawing_upload") {
      expect(parsed.canvas).toEqual({ width: 800, height: 600 });
      expect(parsed.canvas?.background).toBeUndefined();
    }
  });

  test("rejects an unknown background value", () => {
    const r = ItemSchema.safeParse({
      type: "drawing_upload",
      id: "d6",
      stem: "Dots please",
      canvas: { width: 800, height: 600, background: "dots" },
    });
    expect(r.success).toBe(false);
  });
});

// E5 slice 1: item sets on the wire — contiguous, exclusive, referencing
// bundle items; optional so older bundles parse unchanged.
describe("ItemBundleSchema item_sets (E5 slice 1)", () => {
  const items = [
    { type: "essay", id: "i1", stem: "One" },
    { type: "essay", id: "i2", stem: "Two" },
    { type: "essay", id: "i3", stem: "Three" },
  ];
  const base = { test_id: "t", title: "T", items };

  test("a contiguous set parses; layout defaults to inline", () => {
    const parsed = ItemBundleSchema.parse({
      ...base,
      item_sets: [{ id: "s1", stimulus: "Read this.", item_ids: ["i1", "i2"] }],
    });
    expect(parsed.item_sets?.[0]?.layout).toBe("inline");
  });

  test("a bundle without item_sets still parses (older bundles)", () => {
    expect(ItemBundleSchema.parse(base).item_sets).toBeUndefined();
  });

  test("rejects a set whose items are not contiguous", () => {
    const r = ItemBundleSchema.safeParse({
      ...base,
      item_sets: [{ id: "s1", stimulus: "x", item_ids: ["i1", "i3"] }],
    });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.success ? "" : r.error.issues)).toContain("not contiguous");
  });

  test("rejects an unknown item id and an item claimed by two sets", () => {
    expect(
      ItemBundleSchema.safeParse({
        ...base,
        item_sets: [{ id: "s1", stimulus: "x", item_ids: ["nope"] }],
      }).success,
    ).toBe(false);
    expect(
      ItemBundleSchema.safeParse({
        ...base,
        item_sets: [
          { id: "s1", stimulus: "x", item_ids: ["i1", "i2"] },
          { id: "s2", stimulus: "y", item_ids: ["i2", "i3"] },
        ],
      }).success,
    ).toBe(false);
  });

  test("rejects an unknown layout and an empty item list", () => {
    expect(
      ItemBundleSchema.safeParse({
        ...base,
        item_sets: [{ id: "s1", stimulus: "x", layout: "sideways", item_ids: ["i1"] }],
      }).success,
    ).toBe(false);
    expect(
      ItemBundleSchema.safeParse({
        ...base,
        item_sets: [{ id: "s1", stimulus: "x", item_ids: [] }],
      }).success,
    ).toBe(false);
  });
});

// Multi-source stimulus slice 2 (docs/multi-source-stimulus-design.md): a set
// may carry ordered labelled sources, and `side_by_side` is a third layout.
describe("ItemSetSchema sources (multi-source stimulus slice 2)", () => {
  const items = [
    { type: "essay", id: "i1", stem: "One" },
    { type: "essay", id: "i2", stem: "Two" },
  ];
  const base = { test_id: "t", title: "T", items };
  const set = (extra: Record<string, unknown>) => ({
    ...base,
    item_sets: [{ id: "s1", stimulus: "Read the four sources.", item_ids: ["i1"], ...extra }],
  });

  test("sources parse in order and keep their labels", () => {
    const parsed = ItemBundleSchema.parse(
      set({
        sources: [
          { label: "Source A", text: "Two roads diverged\nin a yellow wood" },
          { label: "Source B", text: "Public transit ridership fell." },
        ],
      }),
    );
    expect(parsed.item_sets![0]!.sources.map((s) => s.label)).toEqual(["Source A", "Source B"]);
    expect(parsed.item_sets![0]!.sources[0]!.text).toContain("\n");
  });

  test("a set without the key parses with sources: [] (older bundles)", () => {
    expect(ItemBundleSchema.parse(set({})).item_sets![0]!.sources).toEqual([]);
  });

  test("side_by_side is accepted; an unknown layout is still rejected", () => {
    expect(ItemBundleSchema.parse(set({ layout: "side_by_side" })).item_sets![0]!.layout).toBe("side_by_side");
    expect(ItemBundleSchema.safeParse(set({ layout: "beside" })).success).toBe(false);
  });

  test("bounds: at most 12 sources, label 1–80 trimmed, text 20 000", () => {
    const many = Array.from({ length: 13 }, (_, i) => ({ label: `S${i}`, text: "x" }));
    expect(ItemBundleSchema.safeParse(set({ sources: many })).success).toBe(false);
    expect(ItemBundleSchema.safeParse(set({ sources: [{ label: "", text: "x" }] })).success).toBe(false);
    expect(ItemBundleSchema.safeParse(set({ sources: [{ label: "   ", text: "x" }] })).success).toBe(false);
    expect(ItemBundleSchema.safeParse(set({ sources: [{ label: "a".repeat(81), text: "x" }] })).success).toBe(false);
    expect(
      ItemBundleSchema.safeParse(set({ sources: [{ label: "Source A", text: "x".repeat(20001) }] })).success,
    ).toBe(false);
    // An empty text is legal on the wire — the editor saves a source before
    // the teacher pastes into it; readiness is what flags it.
    expect(ItemBundleSchema.safeParse(set({ sources: [{ label: "Source A", text: "" }] })).success).toBe(true);
  });

  test("a label is trimmed on the way through", () => {
    const parsed = ItemBundleSchema.parse(set({ sources: [{ label: "  Source A  ", text: "x" }] }));
    expect(parsed.item_sets![0]!.sources[0]!.label).toBe("Source A");
  });
});

// E12 slice 1: the teacher bundle may carry a set's source link; the
// delivery bundle may flag a missing source answer. Both optional.
describe("item set source (E12)", () => {
  test("teacher bundle accepts and round-trips a set source", () => {
    const { ItemBundleSchema } = require("../src/index");
    const r = ItemBundleSchema.safeParse({
      test_id: "t",
      title: "T",
      items: [{ type: "essay", id: "e1", stem: "Write" }],
      item_sets: [{ id: "s1", stimulus: "Your outline:", item_ids: ["e1"], source: { assessment_id: "a-outline", item_id: "q-outline" } }],
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.item_sets![0]!.source).toEqual({ assessment_id: "a-outline", item_id: "q-outline" });
  });
});

// E3 slice 1: table items on the wire (docs/e3-table-item-design.md).
describe("TableItemSchema (via ItemSchema)", () => {
  const valid = {
    type: "table",
    id: "t1",
    stem: "Enter the values from your calculations in the table below.",
    columns: [
      { id: "c1", label: "End with glucose" },
      { id: "c2", label: "Middle" },
      { id: "c3", label: "Total" },
    ],
    rows: [
      { id: "r1", label: "Observed (o)" },
      { id: "r2", label: "Difference squared $(o-e)^2$" },
    ],
    corner: "Chamber positions",
    cell_keys: { r1: { c1: "12", c3: "30" } },
  };

  test("accepts a keyed table and round-trips columns, rows, corner and keys", () => {
    const parsed = ItemSchema.parse(valid);
    expect(parsed.type).toBe("table");
    if (parsed.type === "table") {
      expect(parsed.columns).toEqual(valid.columns);
      expect(parsed.rows).toEqual(valid.rows);
      expect(parsed.corner).toBe("Chamber positions");
      expect(parsed.cell_keys).toEqual(valid.cell_keys);
    }
  });

  test("accepts a keyless table (a legal draft) and a blank row label (D-5)", () => {
    const r = ItemSchema.safeParse({
      type: "table",
      id: "t2",
      stem: "Record five trials",
      columns: [{ id: "c1", label: "Mass (g)" }],
      rows: [{ id: "r1", label: "" }, { id: "r2", label: "" }],
    });
    expect(r.success).toBe(true);
  });

  test("rejects a table with no columns or no rows", () => {
    expect(ItemSchema.safeParse({ ...valid, columns: [] }).success).toBe(false);
    expect(ItemSchema.safeParse({ ...valid, rows: [] }).success).toBe(false);
  });

  test("rejects a blank column label and an empty key string", () => {
    expect(
      ItemSchema.safeParse({ ...valid, columns: [{ id: "c1", label: "" }] }).success,
    ).toBe(false);
    expect(
      ItemSchema.safeParse({ ...valid, cell_keys: { r1: { c1: "" } } }).success,
    ).toBe(false);
  });

  test("a bundle containing a table item parses", () => {
    const bundle = ItemBundleSchema.parse({
      test_id: "t1",
      title: "With table",
      items: [valid],
    });
    expect(bundle.items[0]!.type).toBe("table");
  });
});

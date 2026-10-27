// Editor redesign Phase 5 slice B (ADR 0019): the interactive preview's
// editor-page logic, headlessly — the bundle it posts (the key boundary,
// ADR 0019 risk 7), the protocol checks on what the frame sends, and the
// local scoring against the editor's key. The frame document itself is
// test/preview-shell.test.ts.
import { describe, expect, test } from "bun:test";
import { DeliveryBundleSchema, type ItemResponse } from "@secure-test/schema";
import type { ItemType } from "../db/schema";
import { ITEM_TYPES } from "../db/schema";
import {
  defaultItemFor,
  rowToView,
  type ItemRow as EditorItemRow,
  type ItemSetView,
  type ItemView,
} from "../app/dashboard/[id]/editorModel";
import {
  buildPreviewBundle,
  createPreviewSealer,
  previewAssetIds,
  stableShuffle,
  viewToRow,
  type PreviewSealer,
} from "../lib/preview/interactive/bundle";
import {
  PREVIEW_PROTOCOL,
  PREVIEW_PROTOCOL_VERSION,
  acceptReady,
  parseFrameMessage,
  type TtsRequest,
} from "../lib/preview/interactive/protocol";
import { scorePreview, unsealResponse } from "../lib/preview/interactive/score";
import { utteranceFor, wordAt } from "../lib/preview/interactive/speech";

const ASSESSMENT = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Preview fixture",
  calculator_mode: "none" as const,
  calculator_preset: "full" as const,
  allow_highlighting: false,
};
const ASSET = "22222222-2222-4222-8222-222222222222";

// Sentinels: each answer-key VALUE the fixtures carry. None may appear in
// the posted payload.
const KEY_SENTINELS = [
  "shortkeyvalue",
  "tablekeyvalue",
  "blankkeyvalue",
  "rubricsecretdescriptor",
];

function view(id: string, type: ItemType, patch: Partial<ItemView>): ItemView {
  return { ...defaultItemFor(type), id, position: 0, stem: `Stem ${id}`, ...patch } as ItemView;
}

/** One keyed question of every item type. */
function keyedFixtures(): ItemView[] {
  const list: ItemView[] = [
    view("q-mc", "multiple_choice_single", {
      choices: [{ id: "c1", text: "One" }, { id: "c2", text: "Two" }],
      correct_choice_ids: ["c2"],
    }),
    view("q-multi", "multiple_choice_multi", {
      choices: [{ id: "m1", text: "A" }, { id: "m2", text: "B" }, { id: "m3", text: "C" }],
      correct_choice_ids: ["m1", "m3"],
    }),
    view("q-short", "short_text", { correct_answer: "shortkeyvalue", exact_form: true }),
    view("q-essay", "essay", {
      rubric: {
        style: "holistic",
        criteria: [
          {
            id: "cr1",
            name: "Argument",
            levels: [
              { id: "l1", label: "Low", points: 0, descriptor: "rubricsecretdescriptor" },
              { id: "l2", label: "High", points: 2 },
            ],
          },
        ],
      },
    }),
    view("q-match", "match", {
      pairs: [
        { id: "p1", left: "Cat", right: "Kitten" },
        { id: "p2", left: "Dog", right: "Puppy" },
        { id: "p3", left: "Cow", right: "Calf" },
      ],
    }),
    view("q-order", "order", {
      sequence: [
        { id: "s1", label: "First" },
        { id: "s2", label: "Second" },
        { id: "s3", label: "Third" },
      ],
    }),
    view("q-hot", "hotspot", {
      image_asset_id: ASSET,
      regions: [
        { id: "r1", x: 0, y: 0, w: 0.5, h: 0.5 },
        { id: "r2", x: 0.5, y: 0.5, w: 0.4, h: 0.4 },
      ],
      correct_region_ids: ["r2"],
    }),
    view("q-draw", "drawing_upload", { canvas: { width: 800, height: 600, background: "grid" } }),
    view("q-table", "table", {
      columns: [{ id: "c1", label: "Observed" }, { id: "c2", label: "Expected" }],
      rows: [{ id: "r1", label: "Middle" }, { id: "r2", label: "Total" }],
      cell_keys: { r1: { c1: "tablekeyvalue" }, r2: { c2: "7" } },
    }),
    view("q-blank", "fill_blank", {
      stem: "The [[b1]] side is wet; the [[b2]] side is dry.",
      blanks: [
        {
          id: "b1",
          kind: "dropdown",
          options: [{ id: "o2", text: "leeward" }, { id: "o1", text: "windward" }],
          correct_option_id: "o1",
        },
        { id: "b2", kind: "text", keys: ["blankkeyvalue"], exact_form: true },
      ],
    }),
    view("q-graph", "graph", {
      board: { x: [-10, 10], y: [-10, 10], grid: 1, snap: "1", tools: ["point", "line"], max_objects: 2 },
      graph_key: { objects: [{ tool: "point", points: [[3, 4]] }], scoring: "all" },
    }),
  ];
  return list.map((item, position) => ({ ...item, position }));
}

function build(items: ItemView[], opts: { sets?: ItemSetView[]; saved?: Record<string, ItemResponse>; sealer?: PreviewSealer } = {}) {
  const sealer = opts.sealer ?? createPreviewSealer();
  const result = buildPreviewBundle({
    assessment: ASSESSMENT,
    items,
    sets: opts.sets ?? [],
    layout: "scroll",
    tts: false,
    assets: { [ASSET]: { content_type: "image/png", base64: "iVBORw0KGgo=" } },
    saved: opts.saved ?? {},
    sealer,
  });
  return { ...result, sealer };
}

describe("the posted bundle (ADR 0019 risk 7: no key reaches the frame)", () => {
  test("the fixtures cover every item type", () => {
    expect(new Set(keyedFixtures().map((i) => i.type))).toEqual(new Set(ITEM_TYPES));
  });

  test("every keyed type is shown, and no key field or key value is in the payload", () => {
    const { bundle, skipped } = build(keyedFixtures());
    expect(skipped).toEqual([]);
    expect(bundle.items.map((i) => i.id)).toEqual(keyedFixtures().map((i) => i.id));
    const raw = JSON.stringify(bundle);
    for (const field of [
      "correct_choice_id",
      "correct_answer",
      "correct_region_ids",
      "cell_keys",
      "correct_option_id",
      '"keys"',
      "exact_form",
      "graph_key",
      "scoring_method",
      "pairs",
      "sequence",
    ]) {
      expect(raw).not.toContain(field);
    }
    for (const sentinel of KEY_SENTINELS) expect(raw).not.toContain(sentinel);
    // It is a delivery bundle, by the student's own schema.
    expect(DeliveryBundleSchema.safeParse(bundle).success).toBe(true);
  });

  test("match and order carry sealed ids only: no authoring id, and no left shares a right's id", () => {
    const { bundle } = build(keyedFixtures());
    const match = bundle.items.find((i) => i.id === "q-match");
    const order = bundle.items.find((i) => i.id === "q-order");
    if (match?.type !== "match" || order?.type !== "order") throw new Error("fixture types");
    const lefts = match.lefts.map((l) => l.id);
    const rights = match.rights.map((r) => r.id);
    for (const id of [...lefts, ...rights, ...order.entries.map((e) => e.id)]) {
      expect(id).toMatch(/^[0-9a-f]{24}$/);
    }
    expect(lefts.filter((id) => rights.includes(id))).toEqual([]);
    expect(JSON.stringify(match)).not.toMatch(/"p[123]"/);
    expect(JSON.stringify(order)).not.toMatch(/"s[123]"/);
  });

  test("a visible-during-test rubric rides, as on the student's bundle", () => {
    const essay = keyedFixtures().find((i) => i.type === "essay")!;
    const shown = { ...essay, rubric: { ...essay.rubric!, student_visibility: { during_test: true } } };
    const { bundle } = build([shown]);
    expect(JSON.stringify(bundle)).toContain("rubricsecretdescriptor");
  });

  test("sealed ids and the shuffled order are stable across rebuilds of one editor session", () => {
    const sealer = createPreviewSealer();
    const a = build(keyedFixtures(), { sealer }).bundle;
    const b = build(keyedFixtures(), { sealer }).bundle;
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    // A new session mints new ids.
    expect(JSON.stringify(build(keyedFixtures()).bundle)).not.toBe(JSON.stringify(a));
  });

  test("viewToRow is the inverse of the editor's row → card flattening", () => {
    for (const item of keyedFixtures()) {
      const row = viewToRow(item);
      const back = rowToView({ ...row, position: item.position, standards: item.standards } as EditorItemRow);
      expect(viewToRow(back)).toEqual(row);
      expect(back.type).toBe(item.type);
      expect(back.stem).toBe(item.stem);
    }
  });

  test("a draft that the delivery schema refuses is left out and listed, not fatal", () => {
    const items = [
      view("ok", "short_text", { position: 0 }),
      view("one-choice", "multiple_choice_single", { position: 1, choices: [{ id: "c1", text: "Only" }] }),
    ];
    const { bundle, skipped } = build(items);
    expect(bundle.items.map((i) => i.id)).toEqual(["ok"]);
    expect(skipped).toEqual([{ itemId: "one-choice", what: "question" }]);
  });

  test("stimulus sets ride as the student's do; a set with an unlabelled source is listed", () => {
    const items = [
      view("a", "short_text", { position: 0, item_set_id: "set1" }),
      view("b", "short_text", { position: 1, item_set_id: "set1" }),
      view("c", "short_text", { position: 2, item_set_id: "set2" }),
    ];
    const sets: ItemSetView[] = [
      { id: "set1", stimulus_text: "Read this.", sources: [{ label: "Poem", text: "Roses" }], layout: "inline" },
      { id: "set2", stimulus_text: "Draft", sources: [{ label: "", text: "x" }], layout: "inline" },
    ];
    const { bundle, skipped } = build(items, { sets });
    expect(bundle.item_sets).toEqual([
      { id: "set1", stimulus: "Read this.", sources: [{ label: "Poem", text: "Roses" }], layout: "inline", item_ids: ["a", "b"] },
    ]);
    expect(skipped).toEqual([{ itemId: "c", what: "stimulus" }]);
  });

  test("answers given so far ride as saved_responses — only for a question of the same type", () => {
    const items = [view("q1", "short_text", { position: 0 }), view("q2", "essay", { position: 1 })];
    const { bundle } = build(items, {
      saved: {
        q1: { type: "short_text", text: "hello" },
        q2: { type: "short_text", text: "type changed since" },
        gone: { type: "short_text", text: "deleted question" },
      },
    });
    expect(bundle.saved_responses).toEqual({ q1: { type: "short_text", text: "hello" } });
    expect(bundle.answered_item_ids).toEqual(["q1"]);
  });

  test("the read-aloud and paged views mirror what the student's bundle carries", () => {
    const sealer = createPreviewSealer();
    const result = buildPreviewBundle({
      assessment: ASSESSMENT,
      items: [view("q1", "short_text", {})],
      sets: [],
      layout: "paged",
      tts: true,
      assets: {},
      saved: {},
      sealer,
    });
    expect(result.bundle.layout).toBe("paged");
    expect(result.bundle.accommodations).toEqual({ tts_test_content: "Stimuli+Items", tts_student_responses: "On" });
  });

  test("pictures: every asset a stem, choice, config or stimulus names, and only those ride", () => {
    const items = [
      view("q1", "multiple_choice_single", {
        stem: `See ![a map](asset:${ASSET})`,
        choices: [{ id: "c1", text: "x" }, { id: "c2", text: "y" }],
      }),
    ];
    expect(previewAssetIds(items, [])).toEqual([ASSET]);
    expect(Object.keys(build(items).bundle.assets ?? {})).toEqual([ASSET]);
    expect(build([view("q2", "short_text", {})]).bundle.assets).toBeUndefined();
  });

  test("stableShuffle sorts by id and does not mutate its input", () => {
    const input = [{ id: "b" }, { id: "a" }, { id: "c" }];
    expect(stableShuffle(input).map((x) => x.id)).toEqual(["a", "b", "c"]);
    expect(input.map((x) => x.id)).toEqual(["b", "a", "c"]);
  });
});

describe("the sealer", () => {
  test("seal is stable, unseal reverses it, and the two match sides never collide", () => {
    let n = 0;
    const sealer = createPreviewSealer(() => String(++n).padStart(24, "0"));
    const left = sealer.seal("q", "p1", "left");
    expect(sealer.seal("q", "p1", "left")).toBe(left);
    expect(sealer.seal("q", "p1", "right")).not.toBe(left);
    expect(sealer.unseal("q", left, "left")).toBe("p1");
    expect(sealer.unseal("q", left, "right")).toBeNull();
    expect(sealer.unseal("other", left, "left")).toBeNull();
  });

  test("a minted id that is already taken is minted again", () => {
    const ids = ["x", "x", "y"];
    const sealer = createPreviewSealer(() => ids.shift()!);
    expect(sealer.seal("q", "a", "order")).toBe("x");
    expect(sealer.seal("q", "b", "order")).toBe("y");
  });
});

describe("the protocol: what the editor page accepts from the frame", () => {
  const frame = { name: "our iframe's contentWindow" };
  const port = { name: "port" };
  const ready = { type: PREVIEW_PROTOCOL, kind: "ready", version: PREVIEW_PROTOCOL_VERSION };

  test("ready is accepted only from our own frame, in the bootstrap's shape, with one port", () => {
    expect(acceptReady({ source: frame, data: ready, ports: [port] }, frame)).toBe(port);
    // Another window (any page can postMessage the editor) — refused.
    expect(acceptReady({ source: { other: true }, data: ready, ports: [port] }, frame)).toBeNull();
    expect(acceptReady({ source: null, data: ready, ports: [port] }, null)).toBeNull();
    expect(acceptReady({ source: frame, data: { ...ready, version: 2 }, ports: [port] }, frame)).toBeNull();
    expect(acceptReady({ source: frame, data: { ...ready, type: "other" }, ports: [port] }, frame)).toBeNull();
    expect(acceptReady({ source: frame, data: "ready", ports: [port] }, frame)).toBeNull();
    expect(acceptReady({ source: frame, data: ready, ports: [] }, frame)).toBeNull();
    expect(acceptReady({ source: frame, data: ready, ports: [port, port] }, frame)).toBeNull();
  });

  test("a response is accepted in the renderer's exact shape and refused otherwise", () => {
    const body = { item_id: "q1", response: { type: "multiple_choice_single", choice_id: "c2" } };
    expect(parseFrameMessage({ kind: "bridge", handler: "response", body })).toEqual({
      kind: "response",
      item_id: "q1",
      response: { type: "multiple_choice_single", choice_id: "c2" },
    });
    expect(parseFrameMessage({ kind: "bridge", handler: "response", body: { ...body, extra: 1 } })).toBeNull();
    expect(
      parseFrameMessage({ kind: "bridge", handler: "response", body: { item_id: "q1", response: { type: "nope" } } }),
    ).toBeNull();
    expect(parseFrameMessage({ kind: "bridge", handler: "response", body: { item_id: "", response: body.response } })).toBeNull();
    expect(parseFrameMessage({ kind: "bridge", handler: "response", body: null })).toBeNull();
  });

  test("withdraw and submit", () => {
    expect(parseFrameMessage({ kind: "bridge", handler: "withdraw", body: { item_id: "q1" } })).toEqual({
      kind: "withdraw",
      item_id: "q1",
    });
    expect(parseFrameMessage({ kind: "bridge", handler: "submit", body: { confirm: true } })).toEqual({ kind: "submit" });
    expect(parseFrameMessage({ kind: "bridge", handler: "submit", body: {} })).toBeNull();
  });

  test("read-aloud requests are validated; upload / timer / home / stt are ignored; anything else is dropped", () => {
    const speak = { action: "speak", id: "stem-1:1", rate: "normal", segments: [{ kind: "text", text: "Hi" }, { kind: "math", tex: "x^2" }] } satisfies TtsRequest;
    expect(parseFrameMessage({ kind: "bridge", handler: "tts", body: speak })).toEqual({ kind: "tts", request: speak });
    expect(parseFrameMessage({ kind: "bridge", handler: "tts", body: { action: "stop" } })).toEqual({
      kind: "tts",
      request: { action: "stop" },
    });
    expect(parseFrameMessage({ kind: "bridge", handler: "tts", body: { ...speak, rate: "warp" } })).toBeNull();
    expect(
      parseFrameMessage({ kind: "bridge", handler: "tts", body: { ...speak, segments: [{ kind: "html", html: "<b>" }] } }),
    ).toBeNull();
    for (const handler of ["upload", "timer", "home", "stt"] as const) {
      expect(parseFrameMessage({ kind: "bridge", handler, body: null })).toEqual({ kind: "ignored", handler });
    }
    expect(parseFrameMessage({ kind: "bridge", handler: "fetch", body: {} })).toBeNull();
    expect(parseFrameMessage({ kind: "bridge", handler: "__proto__", body: {} })).toBeNull();
  });

  test("the bootstrap's own messages", () => {
    expect(parseFrameMessage({ kind: "rendered", linked: true, items: 3 })).toEqual({ kind: "rendered", linked: true, items: 3 });
    expect(parseFrameMessage({ kind: "rendered", linked: "yes", items: 3 })).toBeNull();
    expect(parseFrameMessage({ kind: "rendered", linked: true, items: -1 })).toBeNull();
    expect(parseFrameMessage({ kind: "jump", item_id: "q1" })).toEqual({ kind: "jump", item_id: "q1" });
    expect(parseFrameMessage({ kind: "jump", item_id: 5 })).toBeNull();
    expect(parseFrameMessage({ kind: "error", message: "x".repeat(1000) })).toEqual({ kind: "error", message: "x".repeat(300) });
  });

  test("non-objects and unknown kinds are dropped", () => {
    for (const data of [null, undefined, "load", 1, [], { kind: "load", payload: {} }, { kind: "eval", code: "1" }]) {
      expect(parseFrameMessage(data)).toBeNull();
    }
  });
});

describe("local scoring against the editor's key", () => {
  test("every auto-scored type, right answers given through the sealed ids the frame saw", () => {
    const items = keyedFixtures();
    const { bundle, sealer } = build(items);
    const match = bundle.items.find((i) => i.id === "q-match");
    const order = bundle.items.find((i) => i.id === "q-order");
    if (match?.type !== "match" || order?.type !== "order") throw new Error("fixture types");
    const answers: Record<string, ItemResponse> = {
      "q-mc": { type: "multiple_choice_single", choice_id: "c2" },
      "q-multi": { type: "multiple_choice_multi", choice_ids: ["m3", "m1"] },
      "q-short": { type: "short_text", text: "  SHORTKEYVALUE " },
      "q-essay": { type: "essay", text: "An essay" },
      "q-match": {
        type: "match",
        matches: Object.fromEntries(
          ["p1", "p2", "p3"].map((p) => [sealer.seal("q-match", p, "left"), sealer.seal("q-match", p, "right")]),
        ),
      },
      "q-order": { type: "order", ordered_ids: ["s1", "s2", "s3"].map((s) => sealer.seal("q-order", s, "order")) },
      "q-hot": { type: "hotspot", region_ids: ["r2"] },
      "q-table": { type: "table", cells: { r1: { c1: "tablekeyvalue" }, r2: { c2: "6" } } },
      "q-blank": { type: "fill_blank", answers: { b1: "o1", b2: "blankkeyvalue" } },
      "q-graph": { type: "graph", objects: [{ tool: "point", points: [[3, 4]] }] },
    };
    const score = scorePreview(items, answers, sealer);
    const byId = Object.fromEntries(score.rows.map((r) => [r.itemId, r]));
    expect(byId["q-mc"]).toMatchObject({ outcome: "correct", points: 1, max: 1, number: 1 });
    expect(byId["q-multi"]).toMatchObject({ outcome: "correct", points: 1 });
    expect(byId["q-short"]).toMatchObject({ outcome: "correct", points: 1 });
    expect(byId["q-essay"]).toMatchObject({ outcome: "by_hand", points: null });
    expect(byId["q-match"]).toMatchObject({ outcome: "correct", points: 1 });
    expect(byId["q-order"]).toMatchObject({ outcome: "correct", points: 1 });
    expect(byId["q-hot"]).toMatchObject({ outcome: "correct", points: 1 });
    expect(byId["q-draw"]).toMatchObject({ outcome: "by_hand" });
    expect(byId["q-table"]).toMatchObject({ outcome: "partly", points: 1, max: 2 });
    expect(byId["q-blank"]).toMatchObject({ outcome: "correct", points: 2, max: 2 });
    expect(byId["q-graph"]).toMatchObject({ outcome: "correct", points: 1, max: 1 });
    expect(score.points).toBe(10);
    expect(score.max).toBe(11);
  });

  test("wrong, unanswered, a type mismatch and an unkeyed question", () => {
    const items = [
      view("a", "multiple_choice_single", { position: 0, choices: [{ id: "c1", text: "1" }, { id: "c2", text: "2" }], correct_choice_ids: ["c2"] }),
      view("b", "short_text", { position: 1, correct_answer: "x" }),
      view("c", "short_text", { position: 2, correct_answer: "y" }),
      view("d", "short_text", { position: 3, correct_answer: "" }),
      view("e", "short_text", { position: 4, correct_answer: "z", scoring_method: "human" }),
    ];
    const score = scorePreview(
      items,
      { a: { type: "multiple_choice_single", choice_id: "c1" }, c: { type: "essay", text: "y" } },
      createPreviewSealer(),
    );
    expect(score.rows.map((r) => r.outcome)).toEqual(["wrong", "unanswered", "unanswered", "no_key", "by_hand"]);
    expect(score.points).toBe(0);
    expect(score.max).toBe(3);
  });

  test("a match or order answer naming ids this sealer never minted counts as unanswered", () => {
    const items = keyedFixtures().filter((i) => i.type === "match" || i.type === "order");
    const sealer = createPreviewSealer();
    build(items, { sealer });
    const forged: Record<string, ItemResponse> = {
      "q-match": { type: "match", matches: { p1: "p1", p2: "p2", p3: "p3" } },
      "q-order": { type: "order", ordered_ids: ["s1", "s2", "s3"] },
    };
    expect(scorePreview(items, forged, sealer).rows.map((r) => r.outcome)).toEqual(["unanswered", "unanswered"]);
    expect(unsealResponse(items[0]!, forged["q-match"]!, sealer)).toBeNull();
  });

  test("a match answer with the wrong pairing is wrong", () => {
    const items = keyedFixtures().filter((i) => i.type === "match");
    const sealer = createPreviewSealer();
    build(items, { sealer });
    const s = (id: string, side: "left" | "right") => sealer.seal("q-match", id, side);
    const answer: ItemResponse = {
      type: "match",
      matches: { [s("p1", "left")]: s("p2", "right"), [s("p2", "left")]: s("p1", "right"), [s("p3", "left")]: s("p3", "right") },
    };
    expect(scorePreview(items, { "q-match": answer }, sealer).rows[0]).toMatchObject({ outcome: "wrong", points: 0 });
  });
});

describe("read-aloud: segments → one utterance → word ranges", () => {
  test("text and formulas join with spaces; a word maps back to its segment and offset", () => {
    const u = utteranceFor([
      { kind: "text", text: "Solve for" },
      { kind: "math", tex: "x^2" },
      { kind: "text", text: "costs \\$5 now" },
    ]);
    expect(u.text.startsWith("Solve for ")).toBe(true);
    expect(u.text.endsWith(" costs $5 now")).toBe(true);
    expect(wordAt(u, 6, 3)).toEqual({ segment: 0, offset: 6, length: 3 });
    const mathStart = u.spans[1]!.start;
    expect(wordAt(u, mathStart, 2)).toEqual({ segment: 1, offset: 0, length: 0 });
    const third = u.spans[2]!.start;
    // No charLength (some browsers): the word runs to the next space.
    expect(wordAt(u, third + 6)).toEqual({ segment: 2, offset: 6, length: 2 });
    // The space between segments is no word.
    expect(wordAt(u, u.spans[0]!.end)).toBeNull();
  });

  test("an empty segment is skipped without shifting the others", () => {
    const u = utteranceFor([{ kind: "text", text: "" }, { kind: "text", text: "Hi" }]);
    expect(u.text).toBe("Hi");
    expect(wordAt(u, 0, 2)).toEqual({ segment: 1, offset: 0, length: 2 });
  });
});

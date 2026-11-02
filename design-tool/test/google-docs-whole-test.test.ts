// U-25 slice 4 (docs/google-docs-whole-test-design.md): the whole-test Doc's
// per-type answers (lib/googleDocs/wholeTest.ts) and their HTML
// (lib/googleDocs/content.ts). Pure — no database, no Drive.
import { describe, expect, test } from "bun:test";
import { buildDocHtml, docAnswerHtml, type EssaySection, type ReleaseContents } from "../lib/googleDocs/content";
import {
  pictureKey,
  questionPictures,
  wholeTestAnswer,
  type WholeTestItem,
} from "../lib/googleDocs/wholeTest";

const NONE: ReleaseContents = {
  prompt: false,
  sources: false,
  teacher_score: false,
  ai_score: false,
  teacher_feedback: false,
  ai_feedback: false,
  rubric_table: false,
};

const BOARD = { x: [-10, 10] as [number, number], y: [-10, 10] as [number, number], grid: 1, snap: "1", tools: ["point" as const, "line" as const], max_objects: 2 };
const LINE = { tool: "line" as const, points: [[0, 1], [1, 3]] as [number, number][] };

function resp(response: Record<string, unknown>) {
  return { id: "11111111-1111-4111-8111-111111111111", response };
}

const MC: WholeTestItem = {
  type: "multiple_choice_single",
  stem: "Pick one",
  choices: [
    { id: "a", text: "Apple" },
    { id: "b", text: "Banana" },
    { id: "c", text: "Cherry" },
  ],
  config: {},
};

describe("wholeTestAnswer", () => {
  test("single choice lists every option, the student's marked (D-12)", () => {
    const a = wholeTestAnswer(MC, resp({ type: "multiple_choice_single", choice_id: "b" }), 1);
    expect(a).toEqual({
      kind: "choices",
      options: [
        { text: "Apple", chosen: false },
        { text: "Banana", chosen: true },
        { text: "Cherry", chosen: false },
      ],
    });
  });

  test("multi choice marks each pick", () => {
    const item = { ...MC, type: "multiple_choice_multi" };
    const a = wholeTestAnswer(item, resp({ type: "multiple_choice_multi", choice_ids: ["a", "c"] }), 1);
    expect(a.kind === "choices" && a.options.map((o) => o.chosen)).toEqual([true, false, true]);
  });

  test("no response, an empty pick, or a response of another type is no answer", () => {
    expect(wholeTestAnswer(MC, null, 1)).toEqual({ kind: "none" });
    expect(wholeTestAnswer({ ...MC, type: "multiple_choice_multi" }, resp({ type: "multiple_choice_multi", choice_ids: [] }), 1)).toEqual({ kind: "none" });
    expect(wholeTestAnswer(MC, resp({ type: "short_text", text: "x" }), 1)).toEqual({ kind: "none" });
  });

  test("match shows the student's pairing in the authored left order", () => {
    const item: WholeTestItem = {
      type: "match",
      stem: "Match",
      config: {
        pairs: [
          { id: "p1", left: "Cat", right: "Meow" },
          { id: "p2", left: "Dog", right: "Woof" },
          { id: "p3", left: "Cow", right: "Moo" },
        ],
      },
    };
    const a = wholeTestAnswer(item, resp({ type: "match", matches: { p1: "p2", p2: "p1" } }), 1);
    expect(a).toEqual({ kind: "lines", lines: ["Cat → Woof", "Dog → Meow", "Cow → (none)"] });
  });

  test("order shows the student's order", () => {
    const item: WholeTestItem = {
      type: "order",
      stem: "Order",
      config: { sequence: [{ id: "e1", label: "First" }, { id: "e2", label: "Second" }] },
    };
    const a = wholeTestAnswer(item, resp({ type: "order", ordered_ids: ["e2", "e1"] }), 1);
    expect(a).toEqual({ kind: "lines", ordered: true, lines: ["Second", "First"] });
  });

  test("hotspot: a count and the item's picture (1.1)", () => {
    const item: WholeTestItem = {
      type: "hotspot",
      stem: "Click",
      config: { image_asset_id: "22222222-2222-4222-8222-222222222222" },
    };
    expect(wholeTestAnswer(item, resp({ type: "hotspot", region_ids: ["r1", "r2"] }), 3)).toEqual({
      kind: "lines",
      lines: ["You picked 2 areas."],
    });
    expect(questionPictures(item, 3)).toEqual([
      { ref: { kind: "asset", asset_id: "22222222-2222-4222-8222-222222222222" }, alt: "Picture for question 3" },
    ]);
  });

  test("drawing: the upload as a picture", () => {
    const item: WholeTestItem = { type: "drawing_upload", stem: "Draw", config: {} };
    const a = wholeTestAnswer(item, resp({ type: "drawing_upload", upload_id: "u1" }), 2);
    expect(a.kind).toBe("picture");
    if (a.kind === "picture") {
      expect(pictureKey(a.picture.ref)).toBe("upload:11111111-1111-4111-8111-111111111111");
      expect(a.picture.alt).toBe("Drawing for question 2");
    }
  });

  test("table: the student's cells, a dash when empty", () => {
    const item: WholeTestItem = {
      type: "table",
      stem: "Fill",
      config: {
        columns: [{ id: "c1", label: "x" }, { id: "c2", label: "y" }],
        rows: [{ id: "r1", label: "A" }],
        corner: "Row",
      },
    };
    const a = wholeTestAnswer(item, resp({ type: "table", cells: { r1: { c1: "4" } } }), 1);
    expect(a).toEqual({ kind: "table", corner: "Row", columns: ["x", "y"], rows: [{ label: "A", cells: ["4", "—"] }] });
  });

  test("fill in the blank: the sentence with the student's answers", () => {
    const item: WholeTestItem = {
      type: "fill_blank",
      stem: "The sky is [[b1]] and grass is [[b2]].",
      config: {
        blanks: [
          { id: "b1", kind: "text", keys: ["blue"] },
          { id: "b2", kind: "dropdown", options: [{ id: "o1", text: "green" }, { id: "o2", text: "red" }], correct_option_id: "o1" },
        ],
      },
    };
    const a = wholeTestAnswer(item, resp({ type: "fill_blank", answers: { b1: "grey", b2: "o2" } }), 1);
    expect(a).toEqual({
      kind: "fill_blank",
      segments: [{ text: "The sky is " }, { answer: "grey" }, { text: " and grass is " }, { answer: "red" }, { text: "." }],
      unplaced: [],
    });
  });

  test("graph: the objects in words, unmarked (1.2)", () => {
    const item: WholeTestItem = { type: "graph", stem: "Graph", config: { graph_board: BOARD } };
    const a = wholeTestAnswer(item, resp({ type: "graph", objects: [LINE] }), 1);
    expect(a.kind).toBe("lines");
    if (a.kind === "lines") {
      expect(a.lines).toHaveLength(1);
      expect(a.lines[0]).toContain("y");
    }
  });
});

describe("D-11: no key reaches the Doc", () => {
  // Every key field set to a marker the student did NOT give; the HTML of
  // every answer must not contain it, nor a ✓ / ✗ / "expected".
  const SECRET = "ZZKEYZZ";
  const cases: Array<[WholeTestItem & Record<string, unknown>, Record<string, unknown>]> = [
    [
      { ...MC, correct_choice_ids: ["a"], correct_answer: SECRET },
      { type: "multiple_choice_single", choice_id: "b" },
    ],
    [
      {
        type: "table",
        stem: "T",
        config: {
          columns: [{ id: "c1", label: "x" }],
          rows: [{ id: "r1", label: "A" }],
          cell_keys: { r1: { c1: SECRET } },
        } as WholeTestItem["config"],
      },
      { type: "table", cells: { r1: { c1: "4" } } },
    ],
    [
      {
        type: "fill_blank",
        stem: "Go [[b1]] [[b2]]",
        config: {
          blanks: [
            { id: "b1", kind: "text", keys: [SECRET] },
            { id: "b2", kind: "dropdown", options: [{ id: "o1", text: SECRET }, { id: "o2", text: "no" }], correct_option_id: "o1" },
          ],
        },
      },
      { type: "fill_blank", answers: { b1: "wrong", b2: "o2" } },
    ],
    [
      {
        type: "hotspot",
        stem: "H",
        config: { image_asset_id: "22222222-2222-4222-8222-222222222222", correct_region_ids: [SECRET] } as WholeTestItem["config"],
      },
      { type: "hotspot", region_ids: ["r1"] },
    ],
    [
      {
        type: "graph",
        stem: "G",
        config: { graph_board: BOARD, graph_key: { objects: [LINE], scoring: "all" } } as WholeTestItem["config"],
      },
      { type: "graph", objects: [{ tool: "point", points: [[2, 2]] }] },
    ],
  ];

  test.each(cases.map((c, i) => [c[0].type, i] as const))("%s", (_type, i) => {
    const [item, response] = cases[i]!;
    const html = docAnswerHtml(wholeTestAnswer(item, resp(response), 1));
    expect(html).not.toContain(SECRET);
    expect(html).not.toMatch(/[✓✗]|expected|correct/i);
  });
});

describe("buildDocHtml whole test", () => {
  const section = (over: Partial<EssaySection>): EssaySection => ({
    number: 1,
    stem: "Which fruit is yellow?",
    stimulus: null,
    sources: [],
    answer: null,
    feedback: [],
    ...over,
  });

  test("question text always, without the Prompt heading (1.3)", () => {
    const html = buildDocHtml({
      studentName: "S",
      assessmentName: "A",
      draftAsOf: null,
      contents: NONE,
      wholeTest: true,
      essays: [
        section({
          kind: "item",
          answer_view: { kind: "choices", options: [{ text: "Banana", chosen: true }, { text: "Kiwi", chosen: false }] },
        }),
      ],
    });
    expect(html).toContain("<h2>Question 1</h2>");
    expect(html).toContain("Which fruit is yellow?");
    expect(html).not.toContain("<h3>Prompt</h3>");
    expect(html).toContain("☑ Banana");
    expect(html).toContain("☐ Kiwi");
  });

  test("an unanswered question says so; a fill-in-the-blank stem is not printed twice", () => {
    const html = buildDocHtml({
      studentName: "S",
      assessmentName: "A",
      draftAsOf: null,
      contents: NONE,
      wholeTest: true,
      essays: [
        section({ kind: "item", answer_view: { kind: "none" } }),
        section({
          number: 2,
          kind: "item",
          stem: "Sky is [[b1]]",
          stem_in_answer: true,
          answer_view: { kind: "fill_blank", segments: [{ text: "Sky is " }, { answer: "blue" }], unplaced: [] },
        }),
      ],
    });
    expect(html).toContain("<p><i>No answer.</i></p>");
    expect(html).not.toContain("[[b1]]");
    expect(html).toContain("Sky is <b>[blue]</b>");
  });

  test("a resolved picture is an img; an unresolved one is text", () => {
    const pic = { ref: { kind: "asset" as const, asset_id: "a1" }, alt: "Picture for question 1" };
    const essays = [section({ kind: "item", pictures: [pic], answer_view: { kind: "picture", picture: { ref: { kind: "upload", response_id: "r1", upload_id: "u" }, alt: "Drawing for question 1" } } })];
    const base = { studentName: "S", assessmentName: "A", draftAsOf: null, contents: NONE, wholeTest: true, essays };
    const without = buildDocHtml(base);
    expect(without).toContain("[Picture: Picture for question 1]");
    expect(without).toContain("[Picture: Drawing for question 1]");
    const withPics = buildDocHtml({ ...base, pictures: new Map([["asset:a1", "data:image/png;base64,AAAA"]]) });
    expect(withPics).toContain('<img src="data:image/png;base64,AAAA" alt="Picture for question 1"');
    expect(withPics).toContain("[Picture: Drawing for question 1]");
  });

  test("an essay in a whole-test Doc keeps its own path", () => {
    const html = buildDocHtml({
      studentName: "S",
      assessmentName: "A",
      draftAsOf: null,
      contents: NONE,
      wholeTest: true,
      essays: [section({ kind: "essay", answer: "My essay." })],
    });
    expect(html).toContain("<h3>Response</h3>");
    expect(html).toContain("My essay.");
  });
});

// FB slice 3 (docs/fill-in-blank-design.md): the teacher read side of a
// fill-in-the-blank answer. The shared reading (lib/items/fillBlankAnswer.ts),
// its HTML (lib/reporting/fillBlankView.ts), and the surfaces that draw from
// it without a DB: answerView's lines, instant feedback's text, the class
// insights evidence pack and the work packet's toolbar excerpt. The review
// queue's payload is covered in review-queue.test.ts; the two pages in
// work-packet-page.test.tsx / reporting-views.test.tsx.
import { describe, expect, test } from "bun:test";
import type { FillBlankBlank, ItemResponse } from "@secure-test/schema";
import type { ItemRow } from "../db/schema";
import { fillBlankAnswer, filledBlankAnswerText } from "../lib/items/fillBlankAnswer";
import { renderFillBlankAnswerHtml, renderFilledSentenceHtml } from "../lib/reporting/fillBlankView";
import { describeAnswer } from "../lib/reporting/answerView";
import { correctAnswerText, yourAnswerText, type FeedbackItemInput } from "../lib/feedback/buildFeedback";
import { buildEvidencePackFromData, type EvidencePackInput } from "../lib/insights/evidencePack";
import { stemExcerpt } from "../lib/reporting/workPacket";
import { scoreResponse } from "../lib/scoring/auto";

const NO_ASSETS = new Map();

// The blanks array deliberately lists b2 BEFORE b1: the reading numbers by
// the stem's markers, not the array.
const STEM = "The [[b1]] side gets rain; the [[b2]] side gets $x^2$ less.";
const BLANKS: FillBlankBlank[] = [
  { id: "b2", kind: "text", keys: ["leeward", "lee"] },
  {
    id: "b1",
    kind: "dropdown",
    options: [
      { id: "o1", text: "windward" },
      { id: "o2", text: "$\\frac{1}{2}$ leeward" },
    ],
    correct_option_id: "o1",
  },
];

function itemRow(stem: string, blanks: FillBlankBlank[]): ItemRow {
  return { type: "fill_blank", stem, config: { blanks } } as unknown as ItemRow;
}

describe("fillBlankAnswer — the shared reading", () => {
  test("segments follow the stem; blanks are numbered by marker order; a dropdown answer is its option TEXT", () => {
    const f = fillBlankAnswer(STEM, BLANKS, { b1: "o2", b2: "Leeward" });
    expect(f.segments.map((s) => (s.kind === "text" ? s.text : `#${s.blank.number}`))).toEqual([
      "The ",
      "#1",
      " side gets rain; the ",
      "#2",
      " side gets $x^2$ less.",
    ]);
    const [one, two] = f.blanks;
    expect(one).toMatchObject({ id: "b1", number: 1, kind: "dropdown", format: "content", answer: "$\\frac{1}{2}$ leeward", keyed: true, right: false, expected: ["windward"] });
    expect(two).toMatchObject({ id: "b2", number: 2, kind: "text", format: "plain", answer: "Leeward", keyed: true, right: true, expected: ["leeward", "lee"] });
    expect(f.keyed_count).toBe(2);
    expect(f.right_count).toBe(1);
    expect(f.unplaced).toEqual([]);
  });

  test("an unknown option id never surfaces; a missing or cleared answer is no answer and wrong when keyed", () => {
    const unknown = fillBlankAnswer(STEM, BLANKS, { b1: "zz" }).blanks[0]!;
    expect(unknown.answer).toBeNull();
    expect(unknown.unknown_option).toBe(true);
    expect(unknown.right).toBe(false);
    expect(filledBlankAnswerText(unknown)).not.toContain("zz");

    const cleared = fillBlankAnswer(STEM, BLANKS, { b1: "", b2: "   " }).blanks;
    expect(cleared[0]).toMatchObject({ answer: null, unknown_option: false, right: false });
    expect(cleared[1]).toMatchObject({ answer: null, right: false });
    expect(filledBlankAnswerText(cleared[1]!)).toBe("(blank)");

    const none = fillBlankAnswer(STEM, BLANKS, null).blanks;
    expect(none.map((b) => b.answer)).toEqual([null, null]);
  });

  test("a keyless blank has right null and no expected; it is not counted", () => {
    const blanks: FillBlankBlank[] = [
      { id: "b1", kind: "dropdown", options: [{ id: "o1", text: "a" }, { id: "o2", text: "b" }] },
      { id: "b2", kind: "text", keys: ["x"] },
    ];
    const f = fillBlankAnswer("[[b1]] and [[b2]]", blanks, { b1: "o1", b2: "x" });
    expect(f.blanks[0]).toMatchObject({ keyed: false, right: null, expected: [], answer: "a" });
    expect(f.keyed_count).toBe(1);
    expect(f.right_count).toBe(1);
  });

  test("several keys: any one earns the mark, through the short-text rule (numeric equivalence unless exact_form)", () => {
    const loose: FillBlankBlank[] = [{ id: "b1", kind: "text", keys: ["0.5", "half"] }];
    expect(fillBlankAnswer("[[b1]]", loose, { b1: "1/2" }).blanks[0]!.right).toBe(true);
    expect(fillBlankAnswer("[[b1]]", loose, { b1: "HALF" }).blanks[0]!.right).toBe(true);
    const exact: FillBlankBlank[] = [{ id: "b1", kind: "text", keys: ["0.5"], exact_form: true }];
    expect(fillBlankAnswer("[[b1]]", exact, { b1: "1/2" }).blanks[0]!.right).toBe(false);
  });

  test("an orphaned or repeated marker stays literal text; a blank with no marker is unplaced, numbered last", () => {
    const blanks: FillBlankBlank[] = [
      { id: "b9", kind: "text", keys: ["k"] },
      { id: "b1", kind: "text" },
    ];
    const f = fillBlankAnswer("A [[b1]] B [[b1]] C [[nope]] D", blanks, { b9: "k" });
    expect(f.segments.filter((s) => s.kind === "blank")).toHaveLength(1);
    const texts = f.segments.filter((s) => s.kind === "text").map((s) => (s as { text: string }).text);
    expect(texts.join("|")).toBe("A | B [[b1]] C [[nope]] D");
    expect(f.unplaced.map((b) => [b.id, b.number, b.placed])).toEqual([["b9", 2, false]]);
    expect(f.right_count).toBe(1);
  });

  test("right_count agrees with the auto scorer", () => {
    const cases: Array<Record<string, string>> = [
      { b1: "o1", b2: "lee" },
      { b1: "o2", b2: "windward" },
      { b2: "LEEWARD" },
      {},
    ];
    for (const answers of cases) {
      const scored = scoreResponse(itemRow(STEM, BLANKS), { type: "fill_blank", answers } as ItemResponse);
      const f = fillBlankAnswer(STEM, BLANKS, answers);
      expect(scored).toEqual({ points: f.right_count, max_points: f.keyed_count });
    }
  });
});

describe("renderFilledSentenceHtml", () => {
  test("stem math through renderItemContent, option math rendered, typed answers escaped, never an id", () => {
    const html = renderFillBlankAnswerHtml(
      STEM,
      BLANKS,
      { type: "fill_blank", answers: { b1: "o2", b2: "<script>x</script>" } },
      NO_ASSETS,
      { showKey: true, summary: true },
    );
    expect(html).toContain("katex");
    expect(html).not.toContain("$x^2$");
    expect(html).not.toContain("[[b1]]");
    expect(html).toContain("&lt;script&gt;x&lt;/script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain(">o2<");
    expect(html).toContain('class="fb-blank fb-wrong"');
    expect(html).toContain("expected windward");
    // Several typed keys joined " or " (D-5).
    expect(html).toContain("expected leeward or lee");
    expect(html).toContain('<span class="sr-only">Blank 1: </span>');
    expect(html).toContain("Keyed blanks matching the key: 0 of 2.");
  });

  test("a right blank gets ✓ and no expected", () => {
    const html = renderFillBlankAnswerHtml(STEM, BLANKS, { answers: { b1: "o1", b2: "lee" } }, NO_ASSETS, {
      showKey: true,
      summary: true,
    });
    expect(html).toContain('class="fb-blank fb-right"');
    expect(html).toContain("✓");
    expect(html).not.toContain("expected");
    expect(html).toContain("Keyed blanks matching the key: 2 of 2.");
  });

  test("showKey off (W-1): the answers only — no mark, no expected, no key notes, no summary", () => {
    const html = renderFillBlankAnswerHtml(STEM, BLANKS, { answers: { b1: "o2", b2: "lee" } }, NO_ASSETS, {
      showKey: false,
      summary: true,
    });
    expect(html).not.toContain("✓");
    expect(html).not.toContain("✗");
    expect(html).not.toContain("expected");
    expect(html).not.toContain("windward");
    expect(html).not.toContain("fb-summary");
    expect(html).toContain('<span class="fb-answer">lee</span>');
  });

  test("an unanswered blank reads (blank); unplaced blanks follow the sentence", () => {
    const blanks: FillBlankBlank[] = [
      { id: "b1", kind: "text", keys: ["a"] },
      { id: "b2", kind: "text" },
    ];
    const html = renderFilledSentenceHtml(fillBlankAnswer("Only [[b1]].", blanks, {}), NO_ASSETS, {
      showKey: true,
      summary: true,
    });
    expect(html).toContain('<span class="fb-answer fb-empty">(blank)</span>');
    expect(html).toContain('<p class="fb-unplaced">Not in the question text: ');
    expect(html).toContain("no key, not scored");
    expect(html).toContain("1 blank has no key and is not scored.");
  });

  test("a keyless item says to score each blank by hand", () => {
    const blanks: FillBlankBlank[] = [{ id: "b1", kind: "text" }];
    const html = renderFillBlankAnswerHtml("[[b1]]", blanks, { answers: { b1: "x" } }, NO_ASSETS, {
      showKey: true,
      summary: true,
    });
    expect(html).toContain("No blank has a key — score each blank by hand (1 point each).");
    expect(html).not.toContain("no key, not scored");
  });
});

describe("renderFilledSentenceHtml — FB-S1 emphasis around a blank", () => {
  test("bold around a blank renders, and the filled blank sits inside the <strong>", () => {
    const html = renderFillBlankAnswerHtml("Air on the **[[b1]]** side.", BLANKS, { answers: { b1: "o1" } }, NO_ASSETS, {
      showKey: false,
    });
    expect(html).not.toContain("**");
    expect(html).toMatch(/<strong><span class="fb-blank [^"]*">.*?windward.*?<\/span><\/strong>/);
  });

  test("no sentinel ever reaches the markup, even when the teacher typed one", () => {
    const html = renderFillBlankAnswerHtml("A \uE000 [[b1]] b.", BLANKS, { answers: {} }, NO_ASSETS, { showKey: false });
    expect(html).not.toContain("\uE000");
    expect(html).toContain('class="fb-blank');
  });
});

describe("answerView — the answers-only lines", () => {
  test("numbered by the stem, a dropdown as its option text, marks from the scorer", () => {
    const view = describeAnswer(
      { type: "fill_blank", stem: STEM, config: { blanks: BLANKS } },
      { type: "fill_blank", answers: { b1: "o1", b2: "nope" } },
    );
    expect(view).toEqual({
      kind: "fill_blank",
      lines: [
        { text: "Blank 1: windward", correct: true },
        { text: "Blank 2: nope", correct: false },
      ],
    });
  });
});

describe("instant feedback — lines the client already renders", () => {
  const item = {
    id: "i1",
    position: 0,
    type: "fill_blank",
    stem: STEM,
    choices: [],
    correct_choice_ids: [],
    correct_answer: null,
    config: { blanks: BLANKS },
  } as unknown as FeedbackItemInput;

  test("your answer: Blank n in stem order, option text, (blank) when empty", () => {
    expect(yourAnswerText(item, { type: "fill_blank", answers: { b1: "o1" } })).toBe(
      "Blank 1: windward\nBlank 2: (blank)",
    );
  });

  test("correct answer: the keyed blanks, typed keys joined with or", () => {
    expect(correctAnswerText(item)).toBe("Blank 1: windward\nBlank 2: leeward or lee");
  });
});

describe("class insights evidence pack — fill_blank", () => {
  function input(): EvidencePackInput {
    return {
      assessment: {
        title: "Rain shadow",
        items: [
          { id: "item-fb", position: 0, type: "fill_blank", stem: STEM, max_points: 2, standards: [], blanks: BLANKS },
        ],
      },
      section: null,
      attempts: [
        { attempt_id: "att-a", status: "submitted", display_name: "Student Alpha" },
        { attempt_id: "att-b", status: "submitted", display_name: "Student Bravo" },
        { attempt_id: "att-c", status: "submitted", display_name: "Student Charlie" },
      ],
      responses: [
        { response_id: "r-a", attempt_id: "att-a", item_id: "item-fb", response: { type: "fill_blank", answers: { b1: "o1", b2: "Lee" } }, final: { points: 2, max_points: 2, rationale: null } },
        { response_id: "r-b", attempt_id: "att-b", item_id: "item-fb", response: { type: "fill_blank", answers: { b1: "o2", b2: "lee" } }, final: { points: 1, max_points: 2, rationale: null } },
        { response_id: "r-c", attempt_id: "att-c", item_id: "item-fb", response: { type: "fill_blank", answers: { b1: "o1", b2: "FLAGGED-TEXT" } }, final: { points: 1, max_points: 2, rationale: null } },
      ],
      open_alert_response_ids: new Set(["r-c"]),
    };
  }

  test("the stem shows numbered gaps; blanks carry options and keys as text", () => {
    const { pack } = buildEvidencePackFromData(input());
    const item = pack.assessment.items[0]!;
    expect(item.stem).toContain("The [Blank 1] side gets rain; the [Blank 2] side");
    expect(item.blanks).toEqual([
      { label: "Blank 1", kind: "dropdown", options: ["windward", "$\\frac{1}{2}$ leeward"], keys: ["windward"] },
      { label: "Blank 2", kind: "text", keys: ["leeward", "lee"] },
    ]);
  });

  test("per-blank counts and figures; typed answers clustered case-folded; flagged answers counted, never listed", () => {
    const { pack } = buildEvidencePackFromData(input());
    const blanks = pack.item_analytics[0]!.blank_answers!;
    expect(blanks[0]).toEqual({
      blank: "Blank 1",
      answered_count: 3,
      right_count: 2,
      // r-c's pick is counted above but not listed (open alert); a tie sorts
      // by the answer text.
      answers: [
        { answer: "$\\frac{1}{2}$ leeward", count: 1, right: false },
        { answer: "windward", count: 1, right: true },
      ],
    });
    expect(blanks[1]!.answered_count).toBe(3);
    expect(blanks[1]!.right_count).toBe(2);
    expect(blanks[1]!.answers).toHaveLength(1);
    expect(blanks[1]!.answers[0]!.count).toBe(2);
    expect(pack.figures["item.Q1.blank.1.right_count"]).toBe(2);
    expect(pack.figures["item.Q1.blank.2.answered_count"]).toBe(3);
    const json = JSON.stringify(pack);
    for (const s of ["FLAGGED-TEXT", "Student Alpha", "att-a", "r-a", "item-fb", "o1", "o2"]) {
      expect(json).not.toContain(`"${s}"`);
    }
    expect(json).not.toContain("FLAGGED-TEXT");
  });
});

describe("work packet toolbar excerpt", () => {
  test("a marker reads (blank), not its id", () => {
    expect(stemExcerpt("The [[b1]] side is wet.")).toBe("The (blank) side is wet.");
  });
});

// FB-R3 (hand-run 2026-10-07): an item set to Human is scored blank by blank
// by the teacher — every blank is worth a point and the notes say "by hand".
describe("FB-R3: a hand-scored, partly keyed item", () => {
  const blanks: FillBlankBlank[] = [
    { id: "b1", kind: "text", keys: ["sun"] },
    { id: "b2", kind: "text" },
  ];
  test("max points count every blank only when the method is Human", async () => {
    const { fillBlankMaxPoints, fillBlankHandScored } = await import("../lib/scoring/auto");
    expect(fillBlankMaxPoints({ blanks } as ItemRow["config"])).toBe(1);
    expect(fillBlankMaxPoints({ blanks, scoring_method: "human" } as ItemRow["config"])).toBe(2);
    expect(fillBlankHandScored({ blanks, scoring_method: "human" } as ItemRow["config"])).toBe(true);
    expect(fillBlankHandScored({ blanks } as ItemRow["config"])).toBe(false);
  });
  test("the notes read 'score by hand' instead of 'not scored'", () => {
    const response = { type: "fill_blank", answers: { b1: "sun", b2: "moon" } };
    const html = (handScored: boolean) =>
      renderFillBlankAnswerHtml("The [[b1]] and the [[b2]].", blanks, response, new Map(), {
        showKey: true,
        summary: true,
        handScored,
      });
    expect(html(true)).toContain("no key, score by hand");
    expect(html(true)).toContain("1 blank has no key — score it by hand (1 point each).");
    expect(html(true)).not.toContain("not scored");
    expect(html(false)).toContain("no key, not scored");
  });
});

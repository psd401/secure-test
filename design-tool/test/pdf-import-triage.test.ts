import { describe, expect, test } from "bun:test";
import { CreateItemBody } from "../lib/api/items";
import { extractPdfLayout } from "../lib/pdfImport/extractFigures";
import {
  REGION_HEAD_PT,
  anchorsFromLines,
  locateCandidates,
  type QuestionAnchor,
} from "../lib/pdfImport/regions";
import {
  acceptSkip,
  changeField,
  convertUnconverted,
  readyToAccept,
  triageCandidate,
  triageCounts,
  unconvertedTargets,
  type UnconvertedProposal,
} from "../lib/pdfImport/triage";
import { makeMultiPageTextPdf } from "./helpers/pdf";

// Editor redesign Phase 7 slice A (R-8): the import review's triage
// classifier and the regions that link each proposal to its place on the
// PDF. Pure; no database.

const MC = {
  type: "multiple_choice_single",
  stem: "Which planet is largest?",
  choices: [
    { id: "a", text: "Mars" },
    { id: "b", text: "Jupiter" },
  ],
};

describe("triageCandidate", () => {
  test("a clean keyed question is ready", () => {
    expect(triageCandidate({ candidate: MC, needsKey: false })).toEqual({
      status: "ready",
      needsKey: false,
      reasons: [],
    });
  });

  test("a keyless question needs a key", () => {
    const t = triageCandidate({ candidate: MC, needsKey: true });
    expect(t.status).toBe("needs_key");
    expect(t.needsKey).toBe(true);
  });

  test("a model change makes it check-this and names the field, ahead of a missing key", () => {
    const t = triageCandidate({
      candidate: { ...MC, stem: "Which planet is largest? Type the digits." },
      needsKey: true,
      changes: [{ original: "Underline the digits.", changed_to: "Type the digits.", reason: "cannot underline" }],
    });
    expect(t.status).toBe("check");
    expect(t.needsKey).toBe(true);
    expect(t.reasons).toHaveLength(1);
    expect(t.reasons[0]!.field).toBe("stem");
    expect(t.reasons[0]!.text).toContain("cannot underline");
  });

  test("a change found in a choice highlights that choice", () => {
    const t = triageCandidate({
      candidate: MC,
      needsKey: false,
      changes: [{ original: "Jupitr", changed_to: "Jupiter", reason: "" }],
    });
    expect(t.reasons[0]).toMatchObject({ field: "choices", choiceIds: ["b"] });
  });

  test("a type the import switched on its own is never silent", () => {
    const t = triageCandidate({
      candidate: { type: "table", stem: "Fill in the table." },
      needsKey: false,
      convertedFrom: "essay",
    });
    expect(t.status).toBe("check");
    expect(t.reasons[0]).toMatchObject({ code: "converted", field: "type" });
    expect(t.reasons[0]!.text).toContain("Essay");
    expect(t.reasons[0]!.text).toContain("Table");
  });

  test("the same type in convertedFrom is not a change", () => {
    expect(triageCandidate({ candidate: MC, needsKey: false, convertedFrom: MC.type }).status).toBe("ready");
  });

  test("stimulus signals: paired by position, missing figure, shortened source", () => {
    const t = triageCandidate({
      candidate: MC,
      needsKey: false,
      set: { source: "adjacency", needs_figure: true, sources: [{ shortened: true }] },
    });
    expect(t.status).toBe("check");
    expect(t.reasons.map((r) => r.code)).toEqual(["paired_by_position", "figure_missing", "source_shortened"]);
    expect(t.reasons.every((r) => r.field === "stimulus")).toBe(true);
  });

  test("a model-paired set with full sources adds nothing", () => {
    expect(
      triageCandidate({ candidate: MC, needsKey: false, set: { source: "model", sources: [{}] } }).status,
    ).toBe("ready");
  });

  test("a question the teacher typed from a refused proposal is check-this", () => {
    const t = triageCandidate({ candidate: { type: "essay", stem: "Explain." }, needsKey: false, typeChosen: true });
    expect(t.status).toBe("check");
    expect(t.reasons[0]!.code).toBe("type_chosen");
  });
});

describe("changeField", () => {
  test("removed text belongs to the stem", () => {
    expect(changeField(MC, { original: "Circle it.", changed_to: "", reason: "" })).toEqual({ field: "stem" });
  });
  test("filled blank table headings point at the columns", () => {
    const c = { type: "table", stem: "Fill in.", columns: [{ id: "c1", label: "Column 1" }, { id: "c2", label: "Mass" }] };
    expect(changeField(c, { original: "(a blank column heading)", changed_to: "Column 1", reason: "" }).field).toBe("columns");
  });
  test("text found nowhere falls back to the stem", () => {
    expect(changeField(MC, { original: "x", changed_to: "nowhere", reason: "" }).field).toBe("stem");
  });
});

describe("readyToAccept", () => {
  test("only ready questions, in order, skipping hidden or accepted ones", () => {
    expect(readyToAccept(["ready", "needs_key", "ready", "check", "ready"], [], new Set([4]))).toEqual([0, 2]);
  });
  test("a set goes only when every question in it is ready", () => {
    const statuses = ["ready", "ready", "ready", "needs_key", "ready"] as const;
    const sets = [{ item_indexes: [0, 1] }, { item_indexes: [2, 3] }];
    expect(readyToAccept(statuses, sets)).toEqual([0, 1, 4]);
  });
  test("a set with a skipped member is not taken in part", () => {
    expect(readyToAccept(["ready", "ready"], [{ item_indexes: [0, 1] }], new Set([1]))).toEqual([]);
  });
  // Review fix (2026-10-26): "One assessment per form" hides forms 2..n from
  // the review but still sends their ready questions to drafts of their own.
  test("form choice: 'first' skips the hidden forms, 'split' keeps them, both skip added", () => {
    const statuses = ["ready", "ready", "ready", "ready"] as const; // form 1 = 0,1; form 2 = 2,3
    const hidden = new Set([2, 3]);
    const added = new Set([0]);
    expect(readyToAccept(statuses, [], acceptSkip("first", hidden, added))).toEqual([1]);
    expect(readyToAccept(statuses, [], acceptSkip("split", hidden, added))).toEqual([1, 2, 3]);
    expect(readyToAccept(statuses, [], acceptSkip("all", new Set(), added))).toEqual([1, 2, 3]);
  });
});

test("triageCounts counts every pile", () => {
  expect(triageCounts(["ready", "check", "check", "cant_convert"])).toEqual({
    ready: 1,
    needs_key: 0,
    check: 2,
    cant_convert: 1,
  });
});

describe("can't convert", () => {
  const refused: UnconvertedProposal = {
    index: 3,
    type: "multiple_choice_single",
    stem: "Pick one.",
    choices: ["Only choice", "  "],
    errors: ["choices: too few"],
  };

  test("targets never include a choice type without two real choices", () => {
    expect(unconvertedTargets(refused)).toEqual(["short_text", "essay", "drawing_upload"]);
    expect(unconvertedTargets({ ...refused, choices: ["A", "B"] })).toEqual([
      "multiple_choice_single",
      "multiple_choice_multi",
      "short_text",
      "essay",
      "drawing_upload",
    ]);
  });

  test("no text, nothing to convert", () => {
    expect(unconvertedTargets({ ...refused, stem: "  " })).toEqual([]);
  });

  test("every target converts to a body the item POST accepts, with no key", () => {
    const p = { ...refused, choices: ["Red", "Blue", " "] };
    for (const type of unconvertedTargets(p)) {
      const body = convertUnconverted(p, type);
      const parsed = CreateItemBody.safeParse(body);
      expect(parsed.success).toBe(true);
      expect(body.type).toBe(type);
      if (type.startsWith("multiple_choice")) {
        expect(body.choices).toEqual([
          { id: "a", text: "Red" },
          { id: "b", text: "Blue" },
        ]);
        expect(body.correct_choice_ids).toEqual([]);
      }
    }
  });
});

describe("anchorsFromLines", () => {
  test("numbered line starts only", () => {
    const lines = [
      { y: 100, text: "2. Second" },
      { y: 50, text: "1) First" },
      { y: 120, text: "It weighs 2.5 g." },
      { y: 140, text: "See page 14." },
      { y: 160, text: "**3.** Bold number" },
      { y: 180, text: "2024. A year" },
      { y: 200, text: "A. a choice" },
    ];
    expect(anchorsFromLines(lines, 2)).toEqual([
      { number: 1, page: 2, y: 50 },
      { number: 2, page: 2, y: 100 },
      { number: 3, page: 2, y: 160 },
    ]);
  });
});

describe("locateCandidates", () => {
  const pages = [{ width: 612, height: 792 }, { width: 612, height: 792 }];
  const a = (number: number, page: number, y: number): QuestionAnchor => ({ number, page, y });

  test("a region runs from its number to the next number on the page, else the foot", () => {
    const r = locateCandidates([[1], [2]], [a(1, 1, 100), a(2, 1, 300)], pages);
    expect(r[0]).toEqual({ page: 1, top: (100 - REGION_HEAD_PT) / 792, bottom: (300 - REGION_HEAD_PT) / 792, how: "number" });
    expect(r[1]).toEqual({ page: 1, top: (300 - REGION_HEAD_PT) / 792, bottom: 1, how: "number" });
  });

  test("two forms numbered from 1 each find their own copy; an answer key after is skipped", () => {
    const anchors = [a(1, 1, 100), a(2, 1, 200), a(1, 2, 100), a(2, 2, 200), a(1, 2, 600)];
    const r = locateCandidates([[1], [2], [1], [2]], anchors, pages);
    expect(r.map((x) => [x!.page, Math.round(x!.top! * 792 + REGION_HEAD_PT)])).toEqual([
      [1, 100],
      [1, 200],
      [2, 100],
      [2, 200],
    ]);
  });

  test("a match set built from rows 1-3 spans to row 3", () => {
    const r = locateCandidates([[1, 2, 3], [4]], [a(1, 1, 100), a(2, 1, 150), a(3, 1, 200), a(4, 1, 400)], pages);
    expect(r[0]!.bottom).toBe((400 - REGION_HEAD_PT) / 792);
    expect(r[1]!.top).toBe((400 - REGION_HEAD_PT) / 792);
  });

  test("two items from one printed question share its anchor", () => {
    const r = locateCandidates([[5], [5]], [a(5, 1, 100), a(6, 1, 300)], pages);
    expect(r[1]).toEqual(r[0]);
  });

  test("no number: the page of the question before it, by order, with no box", () => {
    const r = locateCandidates([[], [1], [], [9]], [a(1, 2, 100)], pages);
    expect(r[0]).toBeNull();
    expect(r[1]!.page).toBe(2);
    expect(r[2]).toEqual({ page: 2, top: null, bottom: null, how: "order" });
    expect(r[3]).toEqual({ page: 2, top: null, bottom: null, how: "order" });
  });

  test("a scan (no anchors) places nothing", () => {
    expect(locateCandidates([[1], [2]], [], [])).toEqual([null, null]);
  });
});

describe("extractPdfLayout reports pages and numbered lines", () => {
  test("anchors carry page and top-left height", async () => {
    const pdf = makeMultiPageTextPdf([
      ["Name: ________", "1. What is 2 + 2?", "A. 3", "2. What is 3 + 3?"],
      ["3. Explain your thinking."],
    ]);
    const layout = await extractPdfLayout(pdf);
    expect(layout.pages).toEqual([
      { width: 612, height: 792 },
      { width: 612, height: 792 },
    ]);
    // Line j sits at 792 - (720 - 16j) points from the top.
    expect(layout.anchors).toEqual([
      { number: 1, page: 1, y: 88 },
      { number: 2, page: 1, y: 120 },
      { number: 3, page: 2, y: 72 },
    ]);
  });
});

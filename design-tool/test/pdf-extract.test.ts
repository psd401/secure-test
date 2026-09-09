// Slice 42: PDF extraction primitives — real text-layer extraction against
// the OSPI reference PDF (proves unpdf works in this env, the spike
// finding), scanned detection, candidate validation, and the mock provider.
import { describe, expect, test } from "bun:test";
import { makeMultiPageTextPdf } from "./helpers/pdf";
import {
  extractPdfText,
  looksScanned,
  MIN_CHARS_PER_PAGE,
} from "../lib/pdfImport/extractText";
import {
  adjacencyFallback,
  parsePdfExtraction,
  questionAfterFigure,
  validateProposedSets,
  MAX_NUMBERED_ITEMS,
  MAX_PDF_CANDIDATES,
  MAX_PROPOSED_SOURCES,
  MAX_SOURCE_LABEL_CHARS,
  MAX_SOURCE_TEXT_CHARS,
  PDF_EXTRACT_MAX_TOKENS,
  PDF_EXTRACT_SYSTEM_PROMPT,
  PDF_OCR_USER_PROMPT,
  PdfExtractError,
  countFormLabels,
  countNumberedItems,
  detectForms,
  fillableTableFromStem,
  flagShortenedSources,
  formsReport,
  sourceSpanLengths,
  normalizePdfCandidate,
  numberingReport,
  parsePdfCandidates,
  readSourceNumbers,
  stripFigureMarkers,
  validatePdfCandidates,
} from "../lib/pdfImport/extractCore";
import { mockPdfExtractor } from "../lib/pdfImport/mockProvider";
import { PdfExtractRequest } from "../lib/pdfImport/types";

// A 60-page hand-built text PDF stands in for the OSPI guidelines PDF this
// test used to read from docs/references (removed from the public tree —
// a state document is not ours to redistribute). Same shape the
// assertions cared about: many pages, a six-figure text layer, a real
// word to find.
const GUIDELINES_PDF = makeMultiPageTextPdf(
  Array.from({ length: 60 }, (_, p) =>
    Array.from(
      { length: 40 },
      (_, l) => `Page ${p + 1} line ${l + 1}: Accommodations, supports and tools for testing.`,
    ),
  ),
);

describe("extractPdfText (real text-layer PDF)", () => {
  test("extracts text from a multi-page text-layer PDF", async () => {
    const bytes = new Uint8Array(GUIDELINES_PDF);
    const { text, pageCount } = await extractPdfText(bytes);
    expect(pageCount).toBeGreaterThan(50);
    expect(text.length).toBeGreaterThan(100_000);
    expect(text).toContain("Accommodations");
    expect(looksScanned(text, pageCount)).toBe(false);
  });

  test("rejects garbage bytes (not a PDF)", async () => {
    const junk = new Uint8Array([1, 2, 3, 4, 5]);
    await expect(extractPdfText(junk)).rejects.toBeDefined();
  });

  test("does not detach the caller's buffer (OCR branch forwards it)", async () => {
    // pdfjs transfers the buffer it receives; extractPdfText must copy so
    // the route can still send the original bytes to the OCR provider. A
    // detached Uint8Array reports byteLength 0.
    const bytes = new Uint8Array(GUIDELINES_PDF);
    const before = bytes.byteLength;
    await extractPdfText(bytes);
    expect(bytes.byteLength).toBe(before);
  });
});

describe("looksScanned", () => {
  test("true for empty/near-empty text layers", () => {
    expect(looksScanned("", 5)).toBe(true);
    expect(looksScanned("   \n  \n ", 3)).toBe(true);
    expect(looksScanned("a".repeat(MIN_CHARS_PER_PAGE - 1), 1)).toBe(true);
  });

  test("false for a real text layer", () => {
    expect(looksScanned("x".repeat(MIN_CHARS_PER_PAGE * 3), 2)).toBe(false);
  });

  test("true when pageCount is zero", () => {
    expect(looksScanned("lots of text here and there", 0)).toBe(true);
  });
});

describe("validatePdfCandidates", () => {
  test("keeps valid candidates, reports invalid by index", () => {
    const raw = [
      { type: "short_text", stem: "Q1", correct_answer: "a" },
      { type: "multiple_choice_single", stem: "Q2", choices: [{ id: "a", text: "x" }], correct_choice_ids: ["a"] }, // <2 choices → invalid
      { type: "essay", stem: "Q3" },
      { type: "banana", stem: "Q4" }, // bad type → invalid
    ];
    const { candidates, rejected, truncated } = validatePdfCandidates(raw);
    expect(candidates).toHaveLength(2);
    expect(candidates.map((c) => c.type)).toEqual(["short_text", "essay"]);
    expect(rejected.map((r) => r.index).sort()).toEqual([1, 3]);
    expect(truncated).toBe(false);
  });

  test("truncates at MAX_PDF_CANDIDATES", () => {
    const raw = Array.from({ length: MAX_PDF_CANDIDATES + 5 }, (_, i) => ({
      type: "short_text",
      stem: `Q${i}`,
      correct_answer: "a",
    }));
    const { candidates, truncated } = validatePdfCandidates(raw);
    expect(candidates).toHaveLength(MAX_PDF_CANDIDATES);
    expect(truncated).toBe(true);
  });
});

// Slice 44 (ADR 0015): scanned path — empty text is only valid when the raw
// PDF rides along for document-block OCR.
describe("PdfExtractRequest (scanned path)", () => {
  test("rejects empty text without scanned_pdf", () => {
    const r = PdfExtractRequest.safeParse({ text: "   ", page_count: 3 });
    expect(r.success).toBe(false);
  });

  test("accepts empty text when scanned_pdf is present", () => {
    const r = PdfExtractRequest.safeParse({
      text: "",
      page_count: 3,
      scanned_pdf: new Uint8Array([1, 2, 3]),
      file_name: "scan.pdf",
    });
    expect(r.success).toBe(true);
  });
});

describe("mockPdfExtractor", () => {
  test("scanned path returns the deterministic OCR fixture (echoes file name)", async () => {
    const { candidates } = await mockPdfExtractor.extract({
      text: "",
      page_count: 2,
      scanned_pdf: new Uint8Array([1]),
      file_name: "worksheet.pdf",
    });
    const validated = validatePdfCandidates(candidates);
    expect(validated.candidates).toHaveLength(2);
    expect(validated.candidates.map((c) => c.type)).toEqual([
      "multiple_choice_single",
      "short_text",
    ]);
    expect(validated.candidates[0]!.stem).toContain("worksheet.pdf");
    // The fixture carries the E14 leak raw; the route passes figureCount 0
    // on a scan and the marker goes.
    expect(validated.candidates[1]!.stem).toContain("[FIGURE 1]");
    const scanned = validatePdfCandidates(candidates, { figureCount: 0 });
    expect(scanned.candidates[1]!.stem).toBe("OCR mock: What is the capital of Washington State?");
  });

  test("parses the MC/ST/ES line convention deterministically", async () => {
    const text = [
      "MC: What is 2+2? | a:3 | b:4 | *b",
      "ST: Capital of France? | Paris",
      "ES: Discuss photosynthesis.",
      "some unrelated line",
    ].join("\n");
    const { candidates } = await mockPdfExtractor.extract({ text, page_count: 1 });
    expect(candidates).toHaveLength(3);
    const validated = validatePdfCandidates(candidates);
    expect(validated.candidates).toHaveLength(3);
    expect(validated.candidates.map((c) => c.type)).toEqual([
      "multiple_choice_single",
      "short_text",
      "essay",
    ]);
  });
});

// 2026-09-01: the parser reports WHY it failed so the route can tell a
// teacher to split an over-long document instead of "try again".
describe("parsePdfCandidates", () => {
  test("parses a fenced JSON array", () => {
    expect(parsePdfCandidates('```json\n[{"type":"essay","stem":"x"}]\n```', "t")).toEqual([
      { type: "essay", stem: "x" },
    ]);
  });

  test("unparseable body → PdfExtractError invalid_json (message keeps the prefix)", () => {
    try {
      parsePdfCandidates("[{\"type\":\"essay\",\"stem\":\"cut off", "bedrock");
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(PdfExtractError);
      expect((e as PdfExtractError).code).toBe("invalid_json");
      expect((e as Error).message).toMatch(/^bedrock: model did not return valid JSON/);
    }
  });

  test("unparseable body after a max_tokens stop → code truncated", () => {
    try {
      parsePdfCandidates("[{\"type\":\"essay\",\"stem\":\"cut off", "bedrock", { truncated: true });
      throw new Error("expected throw");
    } catch (e) {
      expect((e as PdfExtractError).code).toBe("truncated");
      expect((e as Error).message).toMatch(/token cap/);
    }
  });

  // Graphing Skills, 2026-09-01: an unescaped quoted phrase inside a stem.
  test("repairs a quoted phrase inside a string and an unescaped KaTeX backslash", () => {
    const broken = '[{"type":"essay","stem":"Answer the question, "How does light affect growth?" Explain $\\mathrm{H_2O}$."}]';
    const parsed = parsePdfCandidates(broken, "t") as { stem: string }[];
    expect(parsed[0]!.stem).toBe('Answer the question, "How does light affect growth?" Explain $\\mathrm{H_2O}$.');
    // Valid JSON is never touched: the strict parse wins first.
    expect(parsePdfCandidates('[{"type":"essay","stem":"plain \\"quoted\\" text"}]', "t")).toEqual([
      { type: "essay", stem: 'plain "quoted" text' },
    ]);
    // Known limit: a content quote right before a comma still fails.
    expect(() => parsePdfCandidates('[{"type":"essay","stem":"He said "yes", then left"}]', "t")).toThrow(PdfExtractError);
  });

  test("non-array JSON (and no items key) → code not_array", () => {
    try {
      parsePdfCandidates('{"foo":1}', "t");
      throw new Error("expected throw");
    } catch (e) {
      expect((e as PdfExtractError).code).toBe("not_array");
    }
  });

  test("output cap covers a full-length exam (raised from 4000 after ERAS)", () => {
    expect(PDF_EXTRACT_MAX_TOKENS).toBeGreaterThanOrEqual(16000);
  });
});

// E1/E2/E4/E7a/E8 (docs/pdf-import-enhancements.md, 2026-09-01): the
// extractor proposes match and drawing_upload, splits show-your-work,
// writes formulas as KaTeX, and reports the printed question number.
describe("extractor prompt (E1/E2/E4/E7a/E8)", () => {
  test("offers match and drawing_upload shapes, source_number, KaTeX rule", () => {
    expect(PDF_EXTRACT_SYSTEM_PROMPT).toContain('"type":"match"');
    expect(PDF_EXTRACT_SYSTEM_PROMPT).toContain('"type":"drawing_upload"');
    expect(PDF_EXTRACT_SYSTEM_PROMPT).toContain("source_number");
    // E4 (James, 2026-09-01): typed work is an essay, drawing only for
    // graphs/figures; the final answer rides as a second short_text.
    expect(PDF_EXTRACT_SYSTEM_PROMPT).toMatch(/"show your work".*emit essay for the work/);
    expect(PDF_EXTRACT_SYSTEM_PROMPT).toContain("Final answer:");
    expect(PDF_EXTRACT_SYSTEM_PROMPT).toContain("drawing_upload for the work only when");
    expect(PDF_EXTRACT_SYSTEM_PROMPT).toContain("$\\mathrm{H_2O}$");
    // E7a excludes keys: a KaTeX key would fail the exact-match scorer.
    expect(PDF_EXTRACT_SYSTEM_PROMPT).toContain("Leave correct_answer values as plain text");
    // E5 slice 3: the set contract and the quoting rule.
    expect(PDF_EXTRACT_SYSTEM_PROMPT).toContain('"item_sets"');
    expect(PDF_EXTRACT_SYSTEM_PROMPT).toContain("[FIGURE 3]");
    expect(PDF_EXTRACT_SYSTEM_PROMPT).toContain("escape double quotes");
  });
});

describe("normalizePdfCandidate (E1 pair ids)", () => {
  test("assigns p1..pn when any pair lacks an id", () => {
    const out = normalizePdfCandidate({
      type: "match",
      stem: "Match",
      pairs: [{ left: "a", right: "1" }, { id: "x", left: "b", right: "2" }],
    }) as { pairs: { id: string }[] };
    expect(out.pairs.map((p) => p.id)).toEqual(["p1", "p2"]);
  });

  test("leaves fully-identified pairs and non-match candidates alone", () => {
    const match = { type: "match", stem: "M", pairs: [{ id: "a", left: "l", right: "r" }] };
    expect(normalizePdfCandidate(match)).toBe(match);
    const mc = { type: "multiple_choice_single", stem: "Q", choices: [], correct_choice_ids: ["a"] };
    expect(normalizePdfCandidate(mc)).toBe(mc);
    expect(normalizePdfCandidate(null)).toBeNull();
  });
});

describe("stripFigureMarkers + normalizePdfCandidate (E14)", () => {
  test("removes the marker and the space before it; text without one is the same string", () => {
    expect(stripFigureMarkers("Identify the type of graph: [FIGURE 1]")).toBe("Identify the type of graph:");
    expect(stripFigureMarkers("[FIGURE 2] Which variable is independent?")).toBe("Which variable is independent?");
    expect(stripFigureMarkers("See [FIGURE 3] below, then [FIGURE 4].")).toBe("See below, then.");
    const plain = "No marker here ";
    expect(stripFigureMarkers(plain)).toBe(plain);
    expect(stripFigureMarkers("[figure 1] lower-case is not the marker")).toBe("[figure 1] lower-case is not the marker");
  });

  test("strips the stem only when figureCount is 0; identity kept when nothing changes", () => {
    const leaked = { type: "essay", stem: "Describe the trend. [FIGURE 1]" };
    expect(normalizePdfCandidate(leaked, { figureCount: 0 })).toEqual({ type: "essay", stem: "Describe the trend." });
    expect(normalizePdfCandidate(leaked, { figureCount: 3 })).toBe(leaked);
    expect(normalizePdfCandidate(leaked)).toBe(leaked);
    const clean = { type: "essay", stem: "Describe the trend." };
    expect(normalizePdfCandidate(clean, { figureCount: 0 })).toBe(clean);
  });

  test("composes with the other fills; a stem that was only a marker is rejected, not proposed", () => {
    const { candidates, rejected } = validatePdfCandidates(
      [
        { type: "multiple_choice_single", stem: "Which graph? [FIGURE 2]", choices: [{ id: "a", text: "x" }, { id: "b", text: "y" }] },
        { type: "match", stem: "[FIGURE 5] Match", pairs: [{ left: "a", right: "1" }, { left: "b", right: "2" }] },
        { type: "essay", stem: "[FIGURE 6]" },
      ],
      { figureCount: 0 },
    );
    expect(candidates.map((c) => c.stem)).toEqual(["Which graph?", "Match"]);
    expect(candidates[0]!.correct_choice_ids).toEqual([]);
    expect((candidates[1] as { pairs: { id: string }[] }).pairs.map((p) => p.id)).toEqual(["p1", "p2"]);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.index).toBe(2);
    expect(rejected[0]!.errors[0]).toMatch(/^stem:/);
  });
});

describe("validatePdfCandidates (new shapes)", () => {
  test("keyless MC with correct_choice_ids omitted (as the prompt says) is proposed, not rejected", () => {
    const { candidates, rejected } = validatePdfCandidates([
      { type: "multiple_choice_single", stem: "Q", choices: [{ id: "a", text: "x" }, { id: "b", text: "y" }] },
      { type: "multiple_choice_multi", stem: "Q", choices: [{ id: "a", text: "x" }, { id: "b", text: "y" }] },
    ]);
    expect(rejected).toHaveLength(0);
    expect(candidates.map((c) => c.correct_choice_ids)).toEqual([[], []]);
  });

  test("match without pair ids validates; drawing_upload needs only a stem", () => {
    const raw = [
      {
        type: "match",
        stem: "Match each term",
        source_number: 1,
        pairs: [
          { left: "mitochondria", right: "ATP" },
          { left: "ribosome", right: "protein" },
        ],
      },
      { type: "drawing_upload", stem: "Graph the data.", source_number: 7 },
      { type: "match", stem: "one pair", pairs: [{ left: "a", right: "b" }] },
    ];
    const { candidates, rejected } = validatePdfCandidates(raw);
    expect(candidates.map((c) => c.type)).toEqual(["match", "drawing_upload"]);
    const m = candidates[0] as { pairs: { id: string }[] };
    expect(m.pairs.map((p) => p.id)).toEqual(["p1", "p2"]);
    // source_number is a prompt-side hint, never a write field.
    expect("source_number" in candidates[0]!).toBe(false);
    expect(rejected.map((r) => r.index)).toEqual([2]);
  });
});

describe("countNumberedItems (E8)", () => {
  test("walks 1. 2. 3. markers in a space-joined blob", () => {
    expect(countNumberedItems("1. What is x? 2. What is y? 3. Define z.")).toBe(3);
  });

  test("accepts N) and (N) markers", () => {
    expect(countNumberedItems("1) a 2) b (3) c")).toBe(3);
  });

  test("ignores years, decimals and out-of-sequence numbers", () => {
    expect(countNumberedItems("Fall 2024. 1. Mass is 2.5 g. 2. page 14. 3. done")).toBe(3);
    expect(countNumberedItems("no numbering at all")).toBe(0);
    // The one-gap tolerance applies at the start too (question 1 can be
    // image-only); two missing at the start is no numbering.
    expect(countNumberedItems("2. starts at two 3. three")).toBe(3);
    expect(countNumberedItems("3. starts at three 4. four")).toBe(0);
  });

  test("tolerates one missing number (image-only question) but not two", () => {
    expect(countNumberedItems("1. a 2. b 4. d 5. e")).toBe(5);
    expect(countNumberedItems("1. a 2. b 5. e")).toBe(2);
  });

  test("an answer key restarting at 1 does not lower the count", () => {
    expect(countNumberedItems("1. q 2. q 3. q Answer key 1. b 2. a 3. d")).toBe(3);
  });

  test("bounded by MAX_NUMBERED_ITEMS", () => {
    const text = Array.from({ length: MAX_NUMBERED_ITEMS + 50 }, (_, i) => `${i + 1}. q`).join(" ");
    expect(countNumberedItems(text)).toBe(MAX_NUMBERED_ITEMS);
  });
});

describe("readSourceNumbers + numberingReport (E8)", () => {
  test("reads integers, numeric strings and ranges; nothing otherwise", () => {
    expect(
      readSourceNumbers([
        { source_number: 3 },
        { source_number: "12" },
        { source_numbers: [1, 2, "3", 0, "x"] },
        { source_number: 2.5 },
        { source_number: "x" },
        {},
        null,
      ]),
    ).toEqual([[3], [12], [1, 2, 3], [], [], [], []]);
  });

  test("a match set claiming rows 1-5 leaves nothing missing (Unit 1 run)", () => {
    const raw = [{ source_numbers: [1, 2, 3, 4, 5] }, { source_number: 6 }];
    expect(numberingReport(6, raw)).toEqual({
      numbered_items: 6,
      extracted_count: 2,
      missing_numbers: [],
      shortfall: false,
    });
  });

  test("scanned path (null numbering) never warns", () => {
    expect(numberingReport(null, [{ source_number: 1 }])).toEqual({
      numbered_items: null,
      extracted_count: 1,
      missing_numbers: null,
      shortfall: false,
    });
  });

  test("with source numbers the missing list is exact and E4 doubles do not mask a gap", () => {
    const raw = [
      { source_number: 1 },
      { source_number: 2 },
      { source_number: 2 }, // E4: work + final answer
      { source_number: 4 },
    ];
    expect(numberingReport(4, raw)).toEqual({
      numbered_items: 4,
      extracted_count: 4,
      missing_numbers: [3],
      shortfall: true,
    });
    expect(numberingReport(2, raw.slice(0, 3)).shortfall).toBe(false);
  });

  test("without source numbers, any count shortfall warns (James, 2026-09-01)", () => {
    expect(numberingReport(15, Array(13).fill({}))).toEqual({
      numbered_items: 15,
      extracted_count: 13,
      missing_numbers: null,
      shortfall: true,
    });
    expect(numberingReport(13, Array(13).fill({})).shortfall).toBe(false);
  });
});

describe("mockPdfExtractor (MA/DR segments, #n source numbers)", () => {
  test("parses match and drawing segments and the printed number", async () => {
    const text = [
      "MA: #1-2 Match the organelle to its job | mitochondria=ATP | ribosome=protein",
      "DR: #3 Graph temperature against time.",
      "ST: #4 Final answer: 2 + 2 | 4",
      "ES: unnumbered essay",
    ].join(" ");
    const { candidates } = await mockPdfExtractor.extract({ text, page_count: 1 });
    expect(readSourceNumbers(candidates)).toEqual([[1, 2], [3], [4], []]);
    const validated = validatePdfCandidates(candidates);
    expect(validated.rejected).toHaveLength(0);
    expect(validated.candidates.map((c) => c.type)).toEqual([
      "match",
      "drawing_upload",
      "short_text",
      "essay",
    ]);
    const m = validated.candidates[0] as { pairs: { id: string; left: string; right: string }[] };
    expect(m.pairs).toEqual([
      { id: "p1", left: "mitochondria", right: "ATP" },
      { id: "p2", left: "ribosome", right: "protein" },
    ]);
    expect(validated.candidates[1]!.stem).toBe("Graph temperature against time.");
  });
});

// E5 slice 3: the model may return {"items", "item_sets"}; sets are validated
// like candidates and figures the model left alone pair by adjacency.
describe("parsePdfExtraction (E5 slice 3)", () => {
  test("a bare array is items with no sets; an object carries item_sets", () => {
    expect(parsePdfExtraction('[{"type":"essay","stem":"x"}]', "t")).toEqual({
      candidates: [{ type: "essay", stem: "x" }],
      proposedSets: [],
    });
    const parsed = parsePdfExtraction(
      '{"items":[{"type":"essay","stem":"x"}],"item_sets":[{"stimulus":"p","figures":[1],"item_indexes":[0]}]}',
      "t",
    );
    expect(parsed.candidates).toHaveLength(1);
    expect(parsed.proposedSets).toEqual([{ stimulus: "p", figures: [1], item_indexes: [0] }]);
    expect(parsePdfExtraction('{"items":[]}', "t").proposedSets).toEqual([]);
    expect(() => parsePdfExtraction('{"foo":1}', "t")).toThrow(PdfExtractError);
  });
});

describe("validateProposedSets (E5 slice 3)", () => {
  // raw candidates 0..5; raw 2 was rejected → valid indexes 0,1,_,2,3,4
  const rawToValid = new Map([[0, 0], [1, 1], [3, 2], [4, 3], [5, 4]]);

  test("remaps raw indexes to validated ones, drops a rejected member, bounds figures", () => {
    const { sets, rejected } = validateProposedSets(
      [{ stimulus: "Passage", figures: [1, 9], item_indexes: [1, 2, 3] }],
      rawToValid,
      3,
    );
    expect(rejected).toEqual([]);
    expect(sets).toEqual([
      { id: "s1", stimulus: "Passage", figures: [1], item_indexes: [1, 2], source: "model", sources: [], layout: "inline" },
    ]);
  });

  test("keeps the first consecutive run and reports the rest; a second set cannot take a claimed item", () => {
    const { sets, rejected } = validateProposedSets(
      [
        { stimulus: "", figure: 2, item_indexes: [0, 1, 4] },
        { stimulus: "again", item_indexes: [1, 3] },
      ],
      rawToValid,
      3,
    );
    expect(sets.map((s) => s.item_indexes)).toEqual([[0, 1], [2]]);
    expect(sets[0]!.figures).toEqual([2]);
    expect(rejected).toEqual([{ index: 0, reason: "not_contiguous" }]);
  });

  test("no items, all rejected, junk, and a set with nothing in it are reported", () => {
    const { sets, rejected } = validateProposedSets(
      [
        { stimulus: "x", item_indexes: [] },
        { stimulus: "y", item_indexes: [2] },
        "junk",
        { item_indexes: ["1"] },
        { stimulus: "  ", figures: [4], item_indexes: [3] }, // figure 4 does not exist → empty
        { stimulus: "kept", item_indexes: [3] }, // the dropped set did not take index 3
      ],
      rawToValid,
      0,
    );
    expect(rejected).toEqual([
      { index: 0, reason: "no_items" },
      { index: 1, reason: "all_items_rejected" },
      { index: 2, reason: "invalid" },
      { index: 3, reason: "empty" },
      { index: 4, reason: "empty" },
    ]);
    expect(sets).toEqual([
      { id: "s1", stimulus: "kept", figures: [], item_indexes: [2], source: "model", sources: [], layout: "inline" },
    ]);
  });

  // E14 + row 31 on the scanned path: figureCount 0 strips a marker from
  // the stimulus, and a figure-only set (every figure out of range) is
  // dropped rather than shown as an empty card.
  test("figureCount 0: marker stripped from the stimulus; a figure-only set is empty", () => {
    const { sets, rejected } = validateProposedSets(
      [
        { stimulus: "Use the graph. [FIGURE 1]", figures: [1], item_indexes: [0, 1] },
        { stimulus: "", figures: [2], item_indexes: [3] },
      ],
      rawToValid,
      0,
    );
    expect(sets).toEqual([
      { id: "s1", stimulus: "Use the graph.", figures: [], item_indexes: [0, 1], source: "model", sources: [], layout: "inline" },
    ]);
    expect(rejected).toEqual([{ index: 1, reason: "empty" }]);
    // With figures present the stimulus is left alone (text-path prompt rule).
    const text = validateProposedSets([{ stimulus: "Keep [FIGURE 1]", figures: [1], item_indexes: [0] }], rawToValid, 1);
    expect(text.sets[0]!.stimulus).toBe("Keep [FIGURE 1]");
  });

  // E13 (2026-09-02): the model marks a scan's set that depended on a
  // figure it could not attach; that set is a placeholder, not empty.
  test("needs_figure keeps a textless set with the flag; the flag is dropped when a figure is present", () => {
    const { sets, rejected } = validateProposedSets(
      [
        { stimulus: "", figures: [], item_indexes: [0], needs_figure: true },
        { stimulus: "Table 1: pH 7.2, 7.5, 7.9", figures: [], item_indexes: [1], needs_figure: true },
        { stimulus: "", figures: [], item_indexes: [3], needs_figure: "yes" }, // not boolean true → empty
      ],
      rawToValid,
      0,
    );
    expect(rejected).toEqual([{ index: 2, reason: "empty" }]);
    expect(sets).toEqual([
      { id: "s1", stimulus: "", figures: [], item_indexes: [0], source: "model", sources: [], layout: "inline", needs_figure: true },
      {
        id: "s2",
        stimulus: "Table 1: pH 7.2, 7.5, 7.9",
        figures: [],
        item_indexes: [1],
        source: "model",
        sources: [],
        layout: "inline",
        needs_figure: true,
      },
    ]);
    const withFigure = validateProposedSets([{ stimulus: "", figures: [1], item_indexes: [0], needs_figure: true }], rawToValid, 1);
    expect(withFigure.sets).toEqual([
      { id: "s1", stimulus: "", figures: [1], item_indexes: [0], source: "model", sources: [], layout: "inline" },
    ]);
  });
});

describe("questionAfterFigure + adjacencyFallback (E5 slice 3)", () => {
  const text = "1. Q1\n[FIGURE 1]\n2. Q2\n3. Q3\n[FIGURE 2]\n[FIGURE 3]\nAnswer key";

  test("finds the first numbered question below a marker, looking past stacked markers", () => {
    expect(questionAfterFigure(text, 1)).toBe(2);
    expect(questionAfterFigure(text, 2)).toBeNull(); // only another figure and the key follow
    expect(questionAfterFigure(text, 3)).toBeNull(); // nothing numbered after it
    expect(questionAfterFigure(text, 4)).toBeNull(); // no such marker
    expect(questionAfterFigure("[FIGURE 1]\n[FIGURE 2]\n7. Q7", 1)).toBe(7);
  });

  test("unplaced figures become sets of one on the question below; placed ones and taken questions are skipped", () => {
    const sourceNumbers = [[1], [2], [3]];
    const fromModel = adjacencyFallback(3, text, sourceNumbers, []);
    expect(fromModel).toEqual([
      { id: "s1", stimulus: "", figures: [1], item_indexes: [1], source: "adjacency", sources: [], layout: "inline" },
    ]);
    // The model already used figure 1 on question 2 → nothing to add.
    const existing = [
      { id: "s1", stimulus: "", figures: [1], item_indexes: [1], source: "model" as const, sources: [], layout: "inline" as const },
    ];
    expect(adjacencyFallback(3, text, sourceNumbers, existing)).toEqual([]);
    // The model placed figure 1 elsewhere but question 2 is free → figure 1 is used, so no fallback either.
    const elsewhere = [
      { id: "s1", stimulus: "", figures: [1], item_indexes: [0], source: "model" as const, sources: [], layout: "inline" as const },
    ];
    expect(adjacencyFallback(3, text, sourceNumbers, elsewhere)).toEqual([]);
  });

  test("two unplaced figures above the same question share one set", () => {
    const stacked = "[FIGURE 1]\n[FIGURE 2]\n1. Q1";
    expect(adjacencyFallback(2, stacked, [[1]], [])).toEqual([
      { id: "s1", stimulus: "", figures: [1, 2], item_indexes: [0], source: "adjacency", sources: [], layout: "inline" },
    ]);
  });
});

describe("mockPdfExtractor SET segments (E5 slice 3)", () => {
  test("resolves #a-b to the raw indexes of the numbered candidates", async () => {
    const text = [
      "MC: #1 One | a:x | b:y | *a",
      "ST: #2 Two | t",
      "ES: #3 Three",
      "SET: #2-3 | figure=1 | Use the graph.",
      "SET: #1 | Read the intro.",
    ].join(" ");
    const { candidates, proposed_sets } = await mockPdfExtractor.extract({ text, page_count: 1 });
    expect(candidates).toHaveLength(3);
    expect(proposed_sets).toEqual([
      { stimulus: "Use the graph.", figures: [1], item_indexes: [1, 2] },
      { stimulus: "Read the intro.", figures: [], item_indexes: [0] },
    ]);
  });
});

// Multi-source stimulus slice 3 (docs/multi-source-stimulus-design.md,
// §Import): the AP Seminar pilot document is one essay prompt followed by
// four labelled sources, which the old prompt and validation dropped whole.
describe("proposed sources (multi-source stimulus slice 3)", () => {
  const rawToValid = new Map([[0, 0], [1, 1], [2, 2]]);

  test("sources are read, coerced, trimmed and bounded; layout defaults to side_by_side", () => {
    const { sets } = validateProposedSets(
      [
        {
          stimulus: "Read the four sources.",
          item_indexes: [0],
          sources: [
            { label: "  Source A  ", text: "First source." },
            "an unlabelled source", // coerced to the next letter
            { label: "Source C", text: "" }, // empty text is kept — the teacher pastes
            { label: "   ", text: "dropped: no label" },
            { label: "Source E", text: 42 }, // dropped: text is not a string
            { label: "L".repeat(200), text: "T".repeat(MAX_SOURCE_TEXT_CHARS + 50) },
          ],
        },
      ],
      rawToValid,
      0,
    );
    expect(sets[0]!.layout).toBe("side_by_side");
    expect(sets[0]!.sources.map((s) => s.label)).toEqual([
      "Source A",
      "Source B",
      "Source C",
      "L".repeat(MAX_SOURCE_LABEL_CHARS),
    ]);
    expect(sets[0]!.sources[1]!.text).toBe("an unlabelled source");
    expect(sets[0]!.sources[2]!.text).toBe("");
    expect(sets[0]!.sources[3]!.text).toHaveLength(MAX_SOURCE_TEXT_CHARS);
    expect(sets[0]!.sources_truncated).toBeUndefined();
  });

  test("beyond 12 sources the list is cut and the set says so", () => {
    const many = Array.from({ length: MAX_PROPOSED_SOURCES + 3 }, (_, i) => ({
      label: `Source ${i + 1}`,
      text: "x",
    }));
    const { sets } = validateProposedSets([{ stimulus: "", item_indexes: [0], sources: many }], rawToValid, 0);
    expect(sets[0]!.sources).toHaveLength(MAX_PROPOSED_SOURCES);
    expect(sets[0]!.sources_truncated).toBe(true);
  });

  test("a set with sources and no figure and no stimulus is kept, not empty", () => {
    const { sets, rejected } = validateProposedSets(
      [{ stimulus: "", item_indexes: [0], sources: [{ label: "Source A", text: "the poem" }] }],
      rawToValid,
      0,
    );
    expect(rejected).toEqual([]);
    expect(sets[0]!.item_indexes).toEqual([0]);
    expect(sets[0]!.layout).toBe("side_by_side");
  });

  test("no sources → sources [] and layout inline; a scan strips a figure marker from a source", () => {
    const plain = validateProposedSets([{ stimulus: "Passage", item_indexes: [0] }], rawToValid, 0);
    expect(plain.sets[0]!.sources).toEqual([]);
    expect(plain.sets[0]!.layout).toBe("inline");
    const scanned = validateProposedSets(
      [{ stimulus: "s", item_indexes: [0], sources: [{ label: "Source A", text: "The chart. [FIGURE 1]" }] }],
      rawToValid,
      0,
    );
    expect(scanned.sets[0]!.sources[0]!.text).toBe("The chart.");
    // With figures extracted the text-path rule holds and nothing is stripped.
    const textPath = validateProposedSets(
      [{ stimulus: "s", item_indexes: [0], sources: [{ label: "Source A", text: "The chart. [FIGURE 1]" }] }],
      rawToValid,
      1,
    );
    expect(textPath.sets[0]!.sources[0]!.text).toBe("The chart. [FIGURE 1]");
  });
});

describe("flagShortenedSources (multi-source stimulus slice 3)", () => {
  // Headings on their own lines, one of them emphasis-marked (E6 wraps a
  // bold heading as **…**), plus the label named inside an instruction
  // paragraph on the first page — which must not be taken as the heading.
  const MARKED = [
    "Read the prompt, then Source A through Source D.",
    "In your essay, cite Source A at least once.",
    "**Source A**",
    "aaaa bbbb cccc dddd eeee ffff gggg hhhh iiii jjjj",
    "kkkk llll mmmm nnnn oooo pppp qqqq rrrr ssss tttt",
    "Source B",
    "[FIGURE 1]",
    "one two three four five six seven eight nine ten",
    "Source C",
    "the last source runs to the end of the document",
    "and keeps going for another line as well",
  ].join("\n");

  // Running header + footer on every page (the footer with a page number),
  // one source spanning three pages: the furniture is not part of the span.
  test("a header and a numbered footer repeated on three pages are left out of the span", () => {
    const page = (n: number, body: string) =>
      ["AP TEST 2026 • **FREE-RESPONSE**", body, "Visit us on the web: example.org. " + n].join("\n");
    const three = [
      page(5, "**Source A**\nfirst page words here"),
      page(6, "second page words here"),
      page(7, "third page words here"),
    ].join("\n\n");
    const body = "first page words here second page words here third page words here";
    expect(sourceSpanLengths(three, [{ label: "Source A" }])).toEqual([body.length]);
    // Two pages are not enough to call a line furniture.
    const two = [page(5, "**Source A**\nfirst page words here"), page(6, "second page words here")].join("\n\n");
    expect(sourceSpanLengths(two, [{ label: "Source A" }])[0]).toBeGreaterThan(
      "first page words here second page words here".length,
    );
  });

  test("a source under 85% of its span is flagged; a full one is not; the last runs to the end", () => {
    const flagged = flagShortenedSources(MARKED, [
      { label: "Source A", text: "aaaa bbbb cccc" }, // far short of ~100 chars
      {
        label: "Source B",
        text: "one two three four five six seven eight nine ten",
      },
      {
        label: "Source C",
        text: "the last source runs to the end of the document\nand keeps going for another line as well",
      },
    ]);
    expect(flagged.map((s) => s.shortened)).toEqual([true, undefined, undefined]);
  });

  const ALL_LABELS = [{ label: "Source A" }, { label: "Source B" }, { label: "Source C" }];

  test("the heading is found past the instruction paragraph that names the label", () => {
    // Only the whole line "**Source A**" is the heading; the two mentions
    // above it are inside sentences and never match. A's span ends at B's
    // heading, and C's runs to the end of the document.
    expect(sourceSpanLengths(MARKED, ALL_LABELS)).toEqual([
      "aaaa bbbb cccc dddd eeee ffff gggg hhhh iiii jjjj kkkk llll mmmm nnnn oooo pppp qqqq rrrr ssss tttt".length,
      "one two three four five six seven eight nine ten".length,
      "the last source runs to the end of the document and keeps going for another line as well".length,
    ]);
  });

  test("[FIGURE n] lines do not count toward a span (chart noise is not the source)", () => {
    // Source B's span is its one text line; the marker line between the
    // heading and the text is ignored.
    expect(sourceSpanLengths(MARKED, ALL_LABELS)[1]).toBe(
      "one two three four five six seven eight nine ten".length,
    );
  });

  test("a source with no matching heading is left unflagged", () => {
    const out = flagShortenedSources(MARKED, [{ label: "Passage 9", text: "x" }]);
    expect(sourceSpanLengths(MARKED, [{ label: "Passage 9" }])).toEqual([null]);
    expect(out[0]!.shortened).toBeUndefined();
  });

  test("the prompt carries the source rules the AP document needs", () => {
    expect(PDF_EXTRACT_SYSTEM_PROMPT).toContain('"sources":[{"label":"Source A","text":"..."}]');
    expect(PDF_EXTRACT_SYSTEM_PROMPT).toContain("printed AFTER the");
    expect(PDF_EXTRACT_SYSTEM_PROMPT).toContain("SINGLE question");
    expect(PDF_EXTRACT_SYSTEM_PROMPT).toContain("never summarised");
    expect(PDF_EXTRACT_SYSTEM_PROMPT).toContain("axis labels");
    // The scanned prompt mirrors (c) and (d) briefly.
    expect(PDF_OCR_USER_PROMPT).toContain('"sources"');
    expect(PDF_OCR_USER_PROMPT).toContain("verbatim");
  });
});

describe("mockPdfExtractor sources= segment (multi-source stimulus slice 3)", () => {
  test("carries labelled sources on the set; segments without one are unchanged", async () => {
    const text = [
      "ES: #1 Write an essay using the sources.",
      "MC: #2 Which? | a:x | b:y | *a",
      "SET: #1 | Read the sources. | sources=Source A::first text;;Source B::second text",
      "SET: #2 | Plain set, no sources.",
    ].join(" ");
    const { proposed_sets } = await mockPdfExtractor.extract({ text, page_count: 1 });
    expect(proposed_sets).toEqual([
      {
        stimulus: "Read the sources.",
        figures: [],
        sources: [
          { label: "Source A", text: "first text" },
          { label: "Source B", text: "second text" },
        ],
        item_indexes: [0],
      },
      { stimulus: "Plain set, no sources.", figures: [], item_indexes: [1] },
    ]);
    const { sets } = validateProposedSets(proposed_sets!, new Map([[0, 0], [1, 1]]), 0);
    expect(sets[0]!.layout).toBe("side_by_side");
    expect(sets[1]!.layout).toBe("inline");
  });
});

// E9 (2026-09-02): forms from the numbering restarting at 1.
describe("detectForms / formsReport (E9)", () => {
  const form = (n: number) => Array.from({ length: n }, (_, i) => [i + 1]);

  test("Solubility's shape: four forms of six, each numbered from 1", () => {
    const nums = [...form(6), ...form(6), ...form(6), ...form(6)];
    const r = detectForms(nums);
    expect(r?.count).toBe(4);
    expect(r?.groups).toEqual([[0, 1, 2, 3, 4, 5], [6, 7, 8, 9, 10, 11], [12, 13, 14, 15, 16, 17], [18, 19, 20, 21, 22, 23]]);
    expect(r?.source).toBe("numbering");
  });

  test("a twin item repeating its number (E4 final answer) and an unnumbered item stay in the group; a match set counts its whole range", () => {
    // form 1: match 1-5, #6 essay, #6 final answer, unnumbered; form 2: 1..4
    const nums = [[1, 2, 3, 4, 5], [6], [6], [], [1], [2], [3], [4]];
    expect(detectForms(nums)?.groups).toEqual([[0, 1, 2, 3], [4, 5, 6, 7]]);
  });

  test("one group, a group of one, or lopsided sections are not forms", () => {
    expect(detectForms(form(8))).toBeNull();
    expect(detectForms([[1], [2], [3], [1]])).toBeNull(); // second group has one question
    expect(detectForms([...form(10), ...form(4)])).toBeNull(); // 4 < 10 / 2
    expect(detectForms([...form(10), ...form(5)])?.count).toBe(2); // exactly half is allowed
    expect(detectForms([])).toBeNull();
  });

  test("labels announce a count when the numbering runs on; numbering wins when both", () => {
    expect(countFormLabels("Form A\n1. x\n2. y\nForm B\n3. z\nform c is not a label")).toBe(2);
    expect(formsReport(form(4), "Form A ... Form B ... Form C")).toEqual({ count: 3, groups: null, source: "labels" });
    expect(formsReport([...form(3), ...form(3)], "Form A Form B Form C Form D")?.source).toBe("numbering");
    expect(formsReport(form(4), null)).toBeNull();
    expect(formsReport(form(4), "Form A only once")).toBeNull();
  });
});

// E3 slice 4: table candidates from the model, and the backstop that turns a
// fill-in table written into a stem as Markdown pipes (the Unit 0 chi-square
// question on the 2026-09-01 run) into a table candidate.
describe("table candidates (E3 slice 4)", () => {
  const UNIT_0_STEM =
    "Perform a chi-square test on the data for the 10-minute time point. Enter the values from your calculations in the table below.\n\n" +
    "| Chamber Positions | End with glucose solution | Middle | End with water | Total |\n" +
    "|---|---|---|---|---|\n" +
    "| Observed (o) | | | | |\n" +
    "| Expected (e) | | | | |\n" +
    "| Difference Squared $(o-e)^2$ | | | | |\n\n" +
    "$\\Sigma(d^2/e) = X^2$";

  test("fillableTableFromStem reads the Unit 0 shape: corner, columns, labelled rows, text before and after", () => {
    const grid = fillableTableFromStem(UNIT_0_STEM);
    expect(grid?.corner).toBe("Chamber Positions");
    expect(grid?.columns.map((c) => c.label)).toEqual(["End with glucose solution", "Middle", "End with water", "Total"]);
    expect(grid?.rows.map((r) => r.label)).toEqual(["Observed (o)", "Expected (e)", "Difference Squared $(o-e)^2$"]);
    expect(grid?.columns.map((c) => c.id)).toEqual(["c1", "c2", "c3", "c4"]);
    expect(grid?.stem).toBe(
      "Perform a chi-square test on the data for the 10-minute time point. Enter the values from your calculations in the table below.\n\n$\\Sigma(d^2/e) = X^2$",
    );
  });

  test("an unlabelled grid has no corner and blank row labels; a blank heading becomes Column n", () => {
    const grid = fillableTableFromStem("Record three trials.\n| Mass (g) | | Volume (mL) |\n|---|---|---|\n| | | |\n| | | |\n| | | |");
    expect(grid?.corner).toBeUndefined();
    expect(grid?.columns.map((c) => c.label)).toEqual(["Mass (g)", "Column 2", "Volume (mL)"]);
    expect(grid?.rows).toEqual([{ id: "r1", label: "" }, { id: "r2", label: "" }, { id: "r3", label: "" }]);
    expect(grid?.stem).toBe("Record three trials.");
  });

  test("a table with data in its cells is not a fill-in grid — left alone", () => {
    expect(fillableTableFromStem("Use the data.\n| Trial | Mass |\n|---|---|\n| 1 | 4.2 |\n| 2 | 4.4 |")).toBeNull();
    expect(fillableTableFromStem("No table here at all.")).toBeNull();
    expect(fillableTableFromStem("| a | b |\n| c | d |")).toBeNull(); // no separator row
  });

  test("normalizePdfCandidate turns an essay carrying the grid into a table and drops the essay's fields", () => {
    const out = normalizePdfCandidate({ type: "essay", stem: UNIT_0_STEM, max_word_count: 200, source_number: 8 }) as Record<string, unknown>;
    expect(out.type).toBe("table");
    expect(out.max_word_count).toBeUndefined();
    expect(out.source_number).toBe(8);
    expect((out.columns as { id: string }[]).length).toBe(4);
    const validated = validatePdfCandidates([{ type: "essay", stem: UNIT_0_STEM }]);
    expect(validated.rejected).toHaveLength(0);
    expect(validated.candidates[0]!.type).toBe("table");
  });

  test("a stem that is ONLY a grid stays what it was — there would be no question left", () => {
    const out = normalizePdfCandidate({ type: "essay", stem: "| A | B |\n|---|---|\n| | |" }) as Record<string, unknown>;
    expect(out.type).toBe("essay");
  });

  test("a model table with bare-string labels gets ids; objects with ids pass through", () => {
    const out = normalizePdfCandidate({ type: "table", stem: "Fill in", columns: ["A", "B"], rows: ["x", ""], corner: " Corner " }) as Record<string, unknown>;
    expect(out.columns).toEqual([{ id: "c1", label: "A" }, { id: "c2", label: "B" }]);
    expect(out.rows).toEqual([{ id: "r1", label: "x" }, { id: "r2", label: "" }]);
    expect(out.corner).toBe("Corner");
    const kept = normalizePdfCandidate({ type: "table", stem: "s", columns: [{ id: "k1", label: "A" }], rows: [{ id: "q1", label: "" }], corner: "" }) as Record<string, unknown>;
    expect(kept.columns).toEqual([{ id: "k1", label: "A" }]);
    expect(kept.corner).toBeUndefined();
    expect(validatePdfCandidates([out, kept]).rejected).toHaveLength(0);
  });

  test("the mock's TB segment parses and validates as a table", async () => {
    const text = "TB: #9 Enter the counts | cols=Observed,Expected | rows=Middle,Total | corner=Chamber TB: Record trials | cols=Mass (g)";
    const { candidates } = await mockPdfExtractor.extract({ text, page_count: 1 });
    expect(readSourceNumbers(candidates)).toEqual([[9], []]);
    const validated = validatePdfCandidates(candidates);
    expect(validated.rejected).toHaveLength(0);
    const first = validated.candidates[0] as { type: string; columns: { label: string }[]; rows: { label: string }[]; corner?: string };
    expect(first.type).toBe("table");
    expect(first.columns.map((c) => c.label)).toEqual(["Observed", "Expected"]);
    expect(first.rows.map((r) => r.label)).toEqual(["Middle", "Total"]);
    expect(first.corner).toBe("Chamber");
    const second = validated.candidates[1] as { rows: { id: string; label: string }[]; corner?: string };
    expect(second.rows).toEqual([{ id: "r1", label: "" }]);
    expect(second.corner).toBeUndefined();
  });

  test("the prompt offers the table shape and its rule", () => {
    expect(PDF_EXTRACT_SYSTEM_PROMPT).toContain('"type":"table"');
    expect(PDF_EXTRACT_SYSTEM_PROMPT).toContain("EMPTY cells");
  });
});

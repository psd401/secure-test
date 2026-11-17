// A1 (2026-11-17): the import's progress lines, pure — no database.
import { describe, expect, test } from "bun:test";
import {
  createImportEventParser,
  encodeImportEvent,
  eventBody,
  formatElapsed,
  importStepLabel,
  wantsImportStream,
  type ImportEvent,
} from "../lib/pdfImport/progress";

const STEP: ImportEvent = { type: "step", step: "read", state: "done", detail: { pages: 3, scanned: false } };
const RESULT: ImportEvent = { type: "result", ok: true, candidates: [{ stem: "a\nb" }] };
const ERROR: ImportEvent = { type: "error", status: 422, ok: false, error: "blocked_by_guardrail" };

describe("encodeImportEvent / createImportEventParser", () => {
  test("one line per event, read back whole", () => {
    const text = [STEP, RESULT, ERROR].map(encodeImportEvent).join("");
    expect(text.split("\n")).toHaveLength(4); // three lines and the empty tail
    const parser = createImportEventParser();
    expect([...parser.push(text), ...parser.end()]).toEqual([STEP, RESULT, ERROR]);
  });

  test("a line split across chunks is held until it completes", () => {
    const text = encodeImportEvent(STEP) + encodeImportEvent(RESULT);
    const parser = createImportEventParser();
    const out: ImportEvent[] = [];
    for (const ch of text) out.push(...parser.push(ch));
    out.push(...parser.end());
    expect(out).toEqual([STEP, RESULT]);
  });

  test("a trailing line with no newline comes out at the end", () => {
    const parser = createImportEventParser();
    expect(parser.push(encodeImportEvent(STEP) + JSON.stringify(RESULT))).toEqual([STEP]);
    expect(parser.end()).toEqual([RESULT]);
    expect(parser.end()).toEqual([]);
  });

  test("blank lines are skipped; a line that is not an event throws", () => {
    expect(createImportEventParser().push("\n\n")).toEqual([]);
    expect(() => createImportEventParser().push('{"type":"other"}\n')).toThrow();
    expect(() => createImportEventParser().push("[1,2]\n")).toThrow();
    expect(() => createImportEventParser().push("not json\n")).toThrow();
  });
});

test("eventBody strips the stream's own fields", () => {
  expect(eventBody(RESULT as Extract<ImportEvent, { type: "result" }>)).toEqual({
    ok: true,
    candidates: [{ stem: "a\nb" }],
  });
  expect(eventBody(ERROR as Extract<ImportEvent, { type: "error" }>)).toEqual({
    ok: false,
    error: "blocked_by_guardrail",
  });
});

test("wantsImportStream reads the Accept header", () => {
  expect(wantsImportStream("application/x-ndjson")).toBe(true);
  expect(wantsImportStream("Application/X-NDJSON, */*")).toBe(true);
  expect(wantsImportStream("application/json")).toBe(false);
  expect(wantsImportStream(null)).toBe(false);
});

describe("importStepLabel", () => {
  test("the teacher's words for each step", () => {
    expect(importStepLabel("read", "active")).toBe("Reading the file");
    expect(importStepLabel("read", "done", { pages: 1, scanned: false })).toBe("Read 1 page");
    expect(importStepLabel("read", "done", { pages: 4, scanned: true })).toBe(
      "Read 4 pages (a scan, so the AI reads the page pictures)",
    );
    expect(importStepLabel("read", "done", { word: true })).toBe("Read the Word document");
    expect(importStepLabel("figures", "done", { figures: 0 })).toBe("No pictures found");
    expect(importStepLabel("figures", "done", { figures: 2 })).toBe("Found 2 pictures");
    expect(importStepLabel("numbering", "done", { expected: 12 })).toBe("The document numbers 12 questions");
    expect(importStepLabel("numbering", "done", { expected: 0 })).toBe(
      "No question numbers found to check against",
    );
    expect(importStepLabel("ai", "active")).toBe("AI is reading the test");
    expect(importStepLabel("ai", "done", { proposed: 1 })).toBe("AI proposed 1 question");
    expect(importStepLabel("safety", "done")).toBe("Safety check passed");
  });

  test("the final check against the document's numbering", () => {
    expect(importStepLabel("checks", "done", { expected: 6, found: 5, missing: [6] })).toBe(
      "Found 5 of 6 numbered questions; missing 6",
    );
    expect(importStepLabel("checks", "done", { expected: 6, found: 6, missing: [] })).toBe(
      "Found all 6 numbered questions",
    );
    expect(importStepLabel("checks", "done", { expected: 6, found: 4, missing: null })).toBe(
      "Found 4 of 6 numbered questions",
    );
    expect(importStepLabel("checks", "done", { expected: null, found: 3, missing: null })).toBe(
      "3 questions ready for review",
    );
  });
});

test("formatElapsed", () => {
  expect(formatElapsed(0)).toBe("0:00");
  expect(formatElapsed(9_999)).toBe("0:09");
  expect(formatElapsed(75_000)).toBe("1:15");
  expect(formatElapsed(-5)).toBe("0:00");
});

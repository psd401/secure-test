import { describe, expect, test } from "bun:test";
import { parseCsv } from "../lib/api/csvParse";

describe("parseCsv (RFC-4180)", () => {
  test("simple rows", () => {
    expect(parseCsv("a,b,c\n1,2,3")).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });

  test("quoted field with comma", () => {
    expect(parseCsv('name,city\n"Doe, John",NYC')).toEqual([
      ["name", "city"],
      ["Doe, John", "NYC"],
    ]);
  });

  test("escaped quotes inside quoted field", () => {
    expect(parseCsv('q\n"She said ""hi"""')).toEqual([["q"], ['She said "hi"']]);
  });

  test("newline inside quoted field", () => {
    expect(parseCsv('a\n"line1\nline2"')).toEqual([["a"], ["line1\nline2"]]);
  });

  test("CRLF row endings", () => {
    expect(parseCsv("a,b\r\n1,2\r\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  test("trailing newline does not add an empty row", () => {
    expect(parseCsv("a\n1\n")).toEqual([["a"], ["1"]]);
  });

  test("empty trailing fields are preserved", () => {
    expect(parseCsv("a,b,c\n1,,")).toEqual([
      ["a", "b", "c"],
      ["1", "", ""],
    ]);
  });
});

// Review fix (2026-08-14): records carry their physical source line so
// error reports stay accurate after multi-line quoted cells.
describe("parseCsvRecords line tracking (review fix)", () => {
  test("records after a multi-line quoted cell keep physical lines", () => {
    const { parseCsvRecords } = require("../lib/api/csvParse") as typeof import("../lib/api/csvParse");
    // Record 2 spans physical lines 2-4 (two embedded newlines).
    const text = 'a,b\n"multi\nline\ncell",x\nlast,y\n';
    const records = parseCsvRecords(text);
    expect(records).toHaveLength(3);
    expect(records[0]!.line).toBe(1);
    expect(records[1]!.line).toBe(2);
    expect(records[2]!.line).toBe(5);
    expect(records[1]!.cells[0]).toBe("multi\nline\ncell");
  });
});

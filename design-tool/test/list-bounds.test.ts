// List bounds (2026-10-25, zod advisory GHSA-mrhx-c7xc-m3w5). zod 4.6.6+
// refuses an oversized list on its size constraint before validating a single
// element; a list without one keeps an issue per failing element. Two checks:
// every list schema a request can reach carries `.max()`, and a bound really
// does turn a huge bad list into one issue.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  ItemBundleSchema,
  ItemResponseSchema,
  MAX_ASSESSMENT_LIST,
  MAX_ITEM_LIST,
  boundedRecord,
} from "@secure-test/schema";
import { CreateItemBody } from "../lib/api/items";

const ROOT = path.join(import.meta.dir, "..");

/** The schema files a request can reach: the API routes, lib/api, and the
 * shared wire schemas. */
const SCANNED = [
  path.join(ROOT, "app", "api"),
  path.join(ROOT, "lib", "api"),
  path.join(ROOT, "..", "packages", "schema", "src"),
];

/**
 * Left unbounded on purpose — none parses request data. Matched by full path,
 * so a new file of the same name elsewhere is still scanned (PR #104 review):
 * - packages/schema/src/delivery.ts: the student bundle the server builds and
 *   validates itself; a bound there could only refuse a large assessment's
 *   own delivery.
 */
const EXEMPT = new Set([path.join(ROOT, "..", "packages", "schema", "src", "delivery.ts")]);
/** Where `boundedRecord` itself wraps `z.record`. */
const RECORD_HELPER = path.join(ROOT, "..", "packages", "schema", "src", "limits.ts");

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (/\.ts$/.test(e) && !EXEMPT.has(p)) out.push(p);
  }
  return out;
}

/** Every raw `z.record(...)` (either spelling, `z.record(` or `z\n  .record(`)
 * with its argument text. */
function recordsIn(src: string): Array<{ line: number; args: string }> {
  const out: Array<{ line: number; args: string }> = [];
  const re = /\bz\s*\.\s*record\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const start = m.index + m[0].length;
    let i = start;
    for (let depth = 1; depth > 0 && i < src.length; i++) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")") depth--;
    }
    out.push({ line: src.slice(0, m.index).split("\n").length, args: src.slice(start, i - 1) });
  }
  return out;
}

/** Every `z.array(...)` with the method chain that follows its closing paren. */
function arraysIn(src: string): Array<{ line: number; chain: string }> {
  const out: Array<{ line: number; chain: string }> = [];
  const re = /z\.array\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let i = m.index + m[0].length;
    for (let depth = 1; depth > 0 && i < src.length; i++) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")") depth--;
    }
    let chain = "";
    for (let j = i; ; ) {
      const mm = /^\s*\.(\w+)\(/.exec(src.slice(j));
      if (!mm) break;
      chain += `.${mm[1]}`;
      let k = j + mm[0].length;
      for (let d = 1; d > 0 && k < src.length; k++) {
        if (src[k] === "(") d++;
        else if (src[k] === ")") d--;
      }
      j = k;
    }
    out.push({ line: src.slice(0, m.index).split("\n").length, chain });
  }
  return out;
}

describe("every request-reachable list and record schema is bounded", () => {
  test("no z.array without .max() / .length() in app/api, lib/api or packages/schema", () => {
    const unbounded: string[] = [];
    let seen = 0;
    for (const dir of SCANNED) {
      for (const f of tsFiles(dir)) {
        for (const a of arraysIn(readFileSync(f, "utf8"))) {
          seen++;
          if (!/\.(max|length)\b/.test(a.chain)) unbounded.push(`${path.relative(ROOT, f)}:${a.line}`);
        }
      }
    }
    expect(seen).toBeGreaterThan(50);
    expect(unbounded).toEqual([]);
  });

  test("no raw z.record whose values can fail: use boundedRecord (PR #104 review)", () => {
    // A record keeps an issue per failing value, and zod has no size check for
    // records. `z.unknown()` values cannot fail, so those records cannot
    // amplify (event detail, client-error context) and stay raw.
    const raw: string[] = [];
    for (const dir of SCANNED) {
      for (const f of tsFiles(dir)) {
        if (f === RECORD_HELPER) continue;
        for (const r of recordsIn(readFileSync(f, "utf8"))) {
          if (!/,\s*z\.unknown\(\)\s*$/.test(r.args)) raw.push(`${path.relative(ROOT, f)}:${r.line}`);
        }
      }
    }
    expect(raw).toEqual([]);
  });

  test("the record scanner sees both spellings and reads the value schema", () => {
    const found = recordsIn(`a = z.record(z.string(), z.unknown());\nb = z\n  .record(z.string(), z.record(z.string(), z.string()));`);
    expect(found.map((r) => r.args)).toEqual([
      "z.string(), z.unknown()",
      "z.string(), z.record(z.string(), z.string())",
      "z.string(), z.string()",
    ]);
  });

  test("the scanner sees a chain that spans lines and nested parens", () => {
    const found = arraysIn(`const a = z.array(z.object({ b: z.string().max(3) }))\n  .max(5)\n  .min(1);\nconst c = z.array(z.string());`);
    expect(found.map((a) => a.chain)).toEqual([".max.min", ""]);
  });
});

describe("a bound turns a huge bad list into one issue", () => {
  const BAD = 200_000;

  test("an answer's choice_ids past MAX_ITEM_LIST", () => {
    const r = ItemResponseSchema.safeParse({
      type: "multiple_choice_multi",
      choice_ids: new Array(BAD).fill(1),
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.length).toBeLessThanOrEqual(2);
      expect(r.error.issues.some((i) => i.code === "too_big")).toBe(true);
    }
  });

  test("an item's choices past MAX_ITEM_LIST", () => {
    const r = CreateItemBody.safeParse({
      type: "multiple_choice_single",
      stem: "Pick",
      choices: new Array(BAD).fill(1),
      correct_choice_ids: [],
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.length).toBeLessThanOrEqual(2);
      expect(r.error.issues.some((i) => i.code === "too_big")).toBe(true);
    }
  });

  test("a bundle's items past MAX_ASSESSMENT_LIST", () => {
    const r = ItemBundleSchema.safeParse({ test_id: "t", title: "t", items: new Array(BAD).fill(1) });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.length).toBeLessThanOrEqual(2);
      expect(r.error.issues.some((i) => i.code === "too_big")).toBe(true);
    }
  });

  test("the bounds are generous: at MAX_ITEM_LIST choices an item still parses", () => {
    const choices = Array.from({ length: MAX_ITEM_LIST }, (_, i) => ({ id: `c${i}`, text: `C${i}` }));
    const r = CreateItemBody.safeParse({
      type: "multiple_choice_single",
      stem: "Pick",
      choices,
      correct_choice_ids: ["c0"],
    });
    expect(r.success).toBe(true);
    expect(MAX_ASSESSMENT_LIST).toBeGreaterThan(MAX_ITEM_LIST);
  });

  test("a match answer with too many keys: one issue, from the key count", () => {
    const matches: Record<string, number> = {};
    for (let i = 0; i < BAD; i++) matches[`k${i}`] = 1;
    const r = ItemResponseSchema.safeParse({ type: "match", matches });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues).toHaveLength(1);
      expect(r.error.issues[0]!.message).toBe(`at most ${MAX_ITEM_LIST} keys`);
    }
  });

  test("boundedRecord still parses a valid record and still reports a non-object as a type error", () => {
    const rec = boundedRecord(z.string(), z.string(), 3);
    expect(rec.parse({ a: "x", b: "y" })).toEqual({ a: "x", b: "y" });
    const r = rec.safeParse("not an object");
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]!.code).toBe("invalid_type");
  });

  test("control: the same bad list without a bound costs an issue per element", () => {
    const r = z.array(z.string()).safeParse(new Array(1000).fill(1));
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.length).toBe(1000);
  });
});

// List bounds (2026-10-25, zod advisory GHSA-mrhx-c7xc-m3w5). zod 4.6.6+
// refuses an oversized list on its size constraint before validating a single
// element; a list without one keeps an issue per failing element. Two checks:
// every list schema a request can reach carries `.max()`, and a bound really
// does turn a huge bad list into one issue.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ItemBundleSchema, ItemResponseSchema, MAX_ASSESSMENT_LIST, MAX_ITEM_LIST } from "@secure-test/schema";
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
 * Left unbounded on purpose — none parses request data:
 * - delivery.ts: the student bundle the server builds and validates itself;
 *   a bound there could only refuse a large assessment's own delivery.
 */
const EXEMPT = new Set(["delivery.ts"]);

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (/\.ts$/.test(e) && !EXEMPT.has(e)) out.push(p);
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

describe("every request-reachable list schema is bounded", () => {
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
    if (!r.success) expect(r.error.issues.length).toBeLessThanOrEqual(2);
  });

  test("an item's choices past MAX_ITEM_LIST", () => {
    const r = CreateItemBody.safeParse({
      type: "multiple_choice_single",
      stem: "Pick",
      choices: new Array(BAD).fill(1),
      correct_choice_ids: [],
    });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.length).toBeLessThanOrEqual(2);
  });

  test("a bundle's items past MAX_ASSESSMENT_LIST", () => {
    const r = ItemBundleSchema.safeParse({ test_id: "t", title: "t", items: new Array(BAD).fill(1) });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.length).toBeLessThanOrEqual(2);
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

  test("control: the same bad list without a bound costs an issue per element", () => {
    const r = z.array(z.string()).safeParse(new Array(1000).fill(1));
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.length).toBe(1000);
  });
});

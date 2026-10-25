import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { helpSections } from "@secure-test/graphing/server";

// The calculator's in-app help (packages/graphing/src/ui/help.ts) is repeated
// on the teacher help page so teachers can see what students read (James,
// 2026-10-24). This keeps the two from drifting: every line of every
// calculator's help must appear on /help.html.
const page = readFileSync(join(import.meta.dir, "..", "public", "help.html"), "utf8")
  .replace(/&rsquo;/g, "'")
  .replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">")
  .replace(/&amp;/g, "&");

describe("/help.html mirrors the calculator's help", () => {
  for (const [mode, sqrt] of [
    ["four_function", false],
    ["four_function", true],
    ["scientific", true],
    ["graphing", true],
  ] as const) {
    test(`${mode}${mode === "four_function" ? (sqrt ? " (Everything on)" : " (state test)") : ""}`, () => {
      for (const s of helpSections(mode, sqrt)) {
        expect(page).toContain(s.title);
        for (const item of s.items) expect(page).toContain(item);
      }
    });
  }
});

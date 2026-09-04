// Public-release slice 2f: a guard against pasting a real student number
// or SSID into a roster test fixture unnoticed. PowerSchool student
// numbers are 7 digits and SSIDs are 9 (per docs/roster-extract.md); a
// real one dropped into a fixture would look exactly like ordinary test
// data unless something checks for it.
//
// The check: every 7- or 9-digit run of digits found in the roster
// fixture files, and in every ps_id / ssid field test/helpers/roster.ts
// exports, must be all the same digit repeated (1111111, 999999999, ...)
// — the same "obviously synthetic" shape used elsewhere in this repo for
// placeholder AWS account ids and OAuth client ids (see .gitleaks.toml).
// Today's fixtures use short sequential ids (1001-1007, 5001-5004,
// 9001-9008, ...) that are nowhere near 7 digits, so they pass this
// check as-is; the guard exists for whatever gets added next.
import { describe, expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import * as rosterHelpers from "./helpers/roster";
import { ROSTER_FIXTURES } from "./fixtures/roster/load";

function realShapedDigitRuns(text: string): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(/\b\d+\b/g)) {
    const run = m[0];
    if (run.length === 7 || run.length === 9) found.push(run);
  }
  return found;
}

function isSyntheticRepeatedDigit(run: string): boolean {
  return /^(\d)\1+$/.test(run);
}

describe("roster fixture ids never look like a real student number or SSID", () => {
  test("test/fixtures/roster/complete/*.csv and manifest.json carry no 7- or 9-digit run except a repeated-digit placeholder", async () => {
    const dir = join(ROSTER_FIXTURES, "complete");
    const entries = await readdir(dir);
    const offenders: { file: string; run: string }[] = [];
    for (const name of entries) {
      const text = await readFile(join(dir, name), "utf8");
      for (const run of realShapedDigitRuns(text)) {
        if (!isSyntheticRepeatedDigit(run)) offenders.push({ file: name, run });
      }
    }
    expect(offenders).toEqual([]);
  });

  test("test/helpers/roster.ts's exported student fixtures carry no real-shaped ps_id or ssid", () => {
    const students = [
      rosterHelpers.STUDENT,
      rosterHelpers.OTHER_STUDENT,
      rosterHelpers.BIOLOGY_STUDENT,
      rosterHelpers.LEFT_STUDENT,
      rosterHelpers.NO_SSID_STUDENT,
    ] as const;
    const offenders: { field: string; value: string }[] = [];
    for (const student of students) {
      for (const field of ["ps_id", "ssid"] as const) {
        const value = (student as Record<string, unknown>)[field];
        if (typeof value !== "string") continue;
        if ((value.length === 7 || value.length === 9) && !isSyntheticRepeatedDigit(value)) {
          offenders.push({ field, value });
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

// Sanity check on the guard itself, so a change to the regex above can't
// silently stop checking anything.
describe("the guard's own pattern", () => {
  test("flags a real-looking 7-digit number and accepts a repeated-digit one", () => {
    // Deliberately not shaped like a real 7-digit run (no keyword nearby,
    // digits not all the same) — this file itself must stay clean of the
    // pattern it's testing for.
    const notSynthetic = String(3480000 + 617); // 3480617, built at runtime
    const synthetic = "1111111";
    expect(isSyntheticRepeatedDigit(notSynthetic)).toBe(false);
    expect(isSyntheticRepeatedDigit(synthetic)).toBe(true);
    expect(realShapedDigitRuns(`field one ${notSynthetic} field two ${synthetic}`)).toEqual([
      notSynthetic,
      synthetic,
    ]);
  });
});

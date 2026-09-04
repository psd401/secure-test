#!/usr/bin/env bun
// Regenerate design-tool/lib/accommodations/tide-catalog.json from
// docs/AccommodationData.xlsx by invoking the canonical Python parser
// (docs/scripts/parse-tide-xlsx.py). The Python script is the source of
// truth for what TIDE actually emits — we just reshape its output for
// the design-tool's runtime layout.
//
// MVP posture per ADR 0007 follow-up: regen is manual + committed
// output. CI assertion (re-run + diff-check) is a Phase 2 hardening.
//
// Usage:
//   cd design-tool && bun scripts/generate-tide-catalog.ts
//
// Prereqs: python3 + openpyxl installed (see parse-tide-xlsx.py header).
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const pyScript = resolve(repoRoot, "docs/scripts/parse-tide-xlsx.py");
const outPath = resolve(here, "../lib/accommodations/tide-catalog.json");

const proc = Bun.spawnSync(["python3", pyScript]);
if (proc.exitCode !== 0) {
  console.error("parse-tide-xlsx.py failed:");
  console.error(proc.stderr.toString());
  process.exit(1);
}
const parsed = JSON.parse(proc.stdout.toString()) as {
  catalog: Array<{ subject: string; tool: string; value: string; code: string }>;
  summary: { subjects: string[] };
};

const out = {
  generated_from:
    "docs/AccommodationData.xlsx Dropdown_Lookup sheet (via docs/scripts/parse-tide-xlsx.py)",
  rows: parsed.catalog,
  subjects: parsed.summary.subjects,
};

await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, JSON.stringify(out, null, 2) + "\n");
console.log(`wrote ${parsed.catalog.length} rows to ${outPath}`);

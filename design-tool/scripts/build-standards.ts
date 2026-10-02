// Builds lib/standards/catalog.json and crosswalk.json from OSPI's two 2026
// adoption workbooks (docs/batch-item-generation-design.md, slice 1).
//
//   bun run standards:build
//
// The workbooks are committed in lib/standards/sources/ (SOURCES.md has the
// URLs and versions). Each file's sha256 is checked first: to take a new OSPI
// release, replace the file, update the constant here and the table in
// SOURCES.md, run this, and review the JSON diff.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildStandards, serialize } from "../lib/standards/build";

const DIR = join(import.meta.dir, "../lib/standards");
const SOURCES = [
  {
    key: "math",
    file: "sources/math26-final-adoption-spreadsheet.xlsx",
    sha256: "d522101f430758dcbc21d7ecc800977761b3ccdb224de2b3e6fd6217faa80875",
  },
  {
    key: "ela",
    file: "sources/ela26-final-adoption-spreadsheet.xlsx",
    sha256: "d4a8f63b00d2359ac30185b7585181d9336997d1b0b749c0873007f19b7a3ced",
  },
] as const;

const data: Record<string, Buffer> = {};
for (const s of SOURCES) {
  const buf = readFileSync(join(DIR, s.file));
  const got = createHash("sha256").update(buf).digest("hex");
  if (got !== s.sha256) {
    console.error(`checksum mismatch for ${s.file}\n  expected ${s.sha256}\n  found    ${got}`);
    process.exit(1);
  }
  data[s.key] = buf;
}

const { catalog, crosswalk } = await buildStandards({
  math: data.math!,
  ela: data.ela!,
});
writeFileSync(join(DIR, "catalog.json"), serialize(catalog));
writeFileSync(join(DIR, "crosswalk.json"), serialize(crosswalk));
console.log(`catalog.json: ${catalog.length} entries; crosswalk.json: ${crosswalk.length} pairs`);

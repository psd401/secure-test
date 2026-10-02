// Extracts the NGSS performance expectations from the official PDF into the
// committed intermediate lib/standards/sources/ngss-performance-expectations.json
// (docs/batch-item-generation-design.md, slice 1b).
//
//   bun run standards:extract-ngss <path-to-AllDCI.pdf>
//
// The PDF (9.97 MB) is not committed; SOURCES.md has its URL and checksum.
// The checksum is verified first, so a different release fails loudly. Then
// `bun run standards:build` reads the JSON this writes.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { extractText, getDocumentProxy } from "unpdf";
import { parseNgss } from "../lib/standards/ngss";
import { serialize } from "../lib/standards/build";

const PDF_SHA256 = "79e26e426859caa31a235331920b58d57d0d49bd1cfe72c3683088c1eb4e5e05";
const OUT = join(import.meta.dir, "../lib/standards/sources/ngss-performance-expectations.json");

const path = process.argv[2];
if (!path) {
  console.error("usage: bun run standards:extract-ngss <path-to-AllDCI.pdf>");
  process.exit(1);
}
const buf = readFileSync(path);
const got = createHash("sha256").update(buf).digest("hex");
if (got !== PDF_SHA256) {
  console.error(`checksum mismatch for ${path}\n  expected ${PDF_SHA256}\n  found    ${got}`);
  process.exit(1);
}

const doc = await getDocumentProxy(new Uint8Array(buf));
const { text } = await extractText(doc, { mergePages: false });
const entries = parseNgss(text);
writeFileSync(OUT, serialize(entries));
console.log(`${OUT}: ${entries.length} performance expectations from ${text.length} pages`);

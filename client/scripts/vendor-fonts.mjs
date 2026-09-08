// Vendors the PSD brand faces into the shipping client (client UI pass,
// slice A — docs/client-ui-pass-design.md §A) — the same shape as
// vendor-katex.mjs:
//   1. copies the two latin-subset variable woff2 files and their OFL
//      licences from design-tool/app/fonts into
//      Sources/SecureTestCore/Resources/fonts/, so the student page and the
//      teacher's design tool render in the SAME Inter / Josefin Sans;
//   2. writes a MANIFEST of `<file> <bytes> <sha256>` lines that
//      PageFontsTests drift-checks against both the vendored copy and the
//      design-tool original.
//
// The page is a no-origin document whose CSP allows `font-src data:` only,
// so PageFonts inlines these bytes as data URIs at build time.
//
// The Swift package never runs bun; the outputs are checked in. Re-run after
// refreshing design-tool/app/fonts:
//   cd client && bun scripts/vendor-fonts.mjs
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "..", "..");
const SRC_DIR = resolve(ROOT, "design-tool", "app", "fonts");
const OUT_DIR = resolve(
  ROOT, "client", "SecureTestCore", "Sources", "SecureTestCore", "Resources", "fonts",
);

// woff2 first: the MANIFEST order is the order PageFonts emits @font-face in.
export const FONT_FILES = ["inter-latin-var.woff2", "josefin-sans-latin-var.woff2"];
const LICENCE_FILES = ["OFL-inter.txt", "OFL-josefin-sans.txt"];

if (import.meta.main) {
  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });
  const lines = [];
  for (const name of [...FONT_FILES, ...LICENCE_FILES]) {
    const bytes = readFileSync(join(SRC_DIR, name));
    copyFileSync(join(SRC_DIR, name), join(OUT_DIR, name));
    lines.push(`${name} ${bytes.length} ${createHash("sha256").update(bytes).digest("hex")}`);
  }
  writeFileSync(join(OUT_DIR, "MANIFEST"), lines.join("\n") + "\n");
  console.log(`vendored ${FONT_FILES.length} woff2 + ${LICENCE_FILES.length} licences → ${OUT_DIR}`);
}

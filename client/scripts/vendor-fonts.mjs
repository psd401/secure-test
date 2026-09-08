// Vendors the PSD brand faces into the shipping client (client UI pass,
// slice A — docs/client-ui-pass-design.md §A) — the same shape as
// vendor-katex.mjs:
//   1. copies the two latin-subset variable woff2 files and their OFL
//      licences from design-tool/app/fonts into
//      Sources/SecureTestCore/Resources/fonts/, so the student page and the
//      teacher's design tool render in the SAME Inter / Josefin Sans;
//   2. downloads the pinned Atkinson Hyperlegible release — slice B's
//      `optional_font` accommodation (D-B1) — which has no design-tool copy
//      to mirror;
//   3. writes a MANIFEST of `<file> <bytes> <sha256>` lines that
//      PageFontsTests drift-checks against the vendored copy, and (for the
//      brand pair only) against the design-tool original.
//
// The page is a no-origin document whose CSP allows `font-src data:` only,
// so PageFonts inlines these bytes as data URIs at build time.
//
// The Swift package never runs bun; the outputs are checked in. Step 2 is the
// only one that needs the network, and only when re-vendoring. Re-run after
// refreshing design-tool/app/fonts or bumping ATKINSON_VERSION:
//   cd client && bun scripts/vendor-fonts.mjs
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

// Slice B (D-B1): the `optional_font` ("dyslexia-friendly") accommodation.
// Atkinson Hyperlegible is the Braille Institute's face — SIL OFL 1.1, like
// the brand pair. It is taken from the @fontsource package rather than from a
// GitHub release because that package is what publishes the *subset* woff2
// files; the upstream release ships full ttf/otf only.
//
// Pinned deliberately: a font that changes shape under a student mid-year is a
// change to the test, not a dependency bump.
const ATKINSON_VERSION = "5.2.8";
const ATKINSON_TARBALL =
  "https://registry.npmjs.org/@fontsource/atkinson-hyperlegible/-/"
  + `atkinson-hyperlegible-${ATKINSON_VERSION}.tgz`;

// Regular and bold, latin subset — under both names the page's tokens use.
// Not the italics: no rule in the page asks for one, and each is another
// ~18 KB of base64 on every accommodated page.
export const ATKINSON_FILES = [
  ["files/atkinson-hyperlegible-latin-400-normal.woff2", "atkinson-hyperlegible-latin-400.woff2"],
  ["files/atkinson-hyperlegible-latin-700-normal.woff2", "atkinson-hyperlegible-latin-700.woff2"],
  ["LICENSE", "OFL-atkinson-hyperlegible.txt"],
];

/** Downloads the pinned tarball; returns `{ <output name>: Buffer }`. */
async function fetchAtkinson() {
  const work = mkdtempSync(join(tmpdir(), "atkinson-"));
  try {
    const tgz = join(work, "pkg.tgz");
    const res = await fetch(ATKINSON_TARBALL);
    if (!res.ok) throw new Error(`${ATKINSON_TARBALL} → HTTP ${res.status}`);
    writeFileSync(tgz, Buffer.from(await res.arrayBuffer()));
    execFileSync("tar", ["-xzf", tgz, "-C", work]);
    const out = {};
    for (const [from, to] of ATKINSON_FILES) out[to] = readFileSync(join(work, "package", from));
    return out;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  // Fetch BEFORE clearing the output directory: a network failure must not
  // leave the package without the fonts it already had.
  const atkinson = await fetchAtkinson();
  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });
  const lines = [];
  for (const name of [...FONT_FILES, ...LICENCE_FILES]) {
    const bytes = readFileSync(join(SRC_DIR, name));
    copyFileSync(join(SRC_DIR, name), join(OUT_DIR, name));
    lines.push(`${name} ${bytes.length} ${createHash("sha256").update(bytes).digest("hex")}`);
  }
  for (const [, name] of ATKINSON_FILES) {
    const bytes = atkinson[name];
    writeFileSync(join(OUT_DIR, name), bytes);
    lines.push(`${name} ${bytes.length} ${createHash("sha256").update(bytes).digest("hex")}`);
  }
  writeFileSync(join(OUT_DIR, "MANIFEST"), lines.join("\n") + "\n");
  console.log(
    `vendored ${FONT_FILES.length + 2} woff2 + ${LICENCE_FILES.length + 1} licences → ${OUT_DIR}`,
  );
}

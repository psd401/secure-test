// Vendors KaTeX into the shipping client (E5 follow-on, 2026-09-01) — the
// port of PoC-B's slice 13 (ADR 0009) into SecureTestCore:
//   1. copies katex.min.js, katex.min.css, contrib/auto-render.min.js and the
//      woff2 faces from design-tool's node_modules/katex into
//      Sources/SecureTestCore/Resources/katex/ — the SAME version the design
//      tool renders with server-side, so a stem renders identically in the
//      preview and on the student's screen;
//   2. writes Sources/SecureTestCore/GeneratedKatexMacros.swift from
//      @secure-test/schema's K12_MACROS (same format as PoC-B's generator, so
//      packages/schema/test/macros.test.ts can drift-check both).
//
// The Swift package never runs bun; both outputs are checked in.
// Re-run after bumping katex in design-tool or editing macros.ts:
//   cd client && bun scripts/vendor-katex.mjs
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "..", "..");
const KATEX_DIST = resolve(ROOT, "design-tool", "node_modules", "katex", "dist");
const OUT_DIR = resolve(ROOT, "client", "SecureTestCore", "Sources", "SecureTestCore", "Resources", "katex");
export const GENERATED_SWIFT_PATH = resolve(
  ROOT, "client", "SecureTestCore", "Sources", "SecureTestCore", "GeneratedKatexMacros.swift",
);

/** Same format as PoC-B's generator: sorted keys, Swift raw string. */
export function renderGeneratedSwift(macros, version) {
  const sortedKeys = Object.keys(macros).sort();
  const sorted = Object.fromEntries(sortedKeys.map((k) => [k, macros[k]]));
  const json = JSON.stringify(sorted, null, 2);
  return `// Auto-generated. Do not edit by hand.
// Source: @secure-test/schema K12_MACROS; KaTeX ${version} vendored alongside.
// Regenerate with: cd client && bun scripts/vendor-katex.mjs

enum GeneratedKatexMacros {
    static let katexVersion = "${version}"
    static let json: String = #"""
${json}
"""#
}
`;
}

if (import.meta.main) {
  const version = JSON.parse(readFileSync(resolve(KATEX_DIST, "..", "package.json"), "utf8")).version;
  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(join(OUT_DIR, "fonts"), { recursive: true });
  copyFileSync(join(KATEX_DIST, "katex.min.js"), join(OUT_DIR, "katex.min.js"));
  copyFileSync(join(KATEX_DIST, "katex.min.css"), join(OUT_DIR, "katex.min.css"));
  copyFileSync(join(KATEX_DIST, "contrib", "auto-render.min.js"), join(OUT_DIR, "auto-render.min.js"));
  let fonts = 0;
  for (const f of readdirSync(join(KATEX_DIST, "fonts"))) {
    if (!f.endsWith(".woff2")) continue;
    copyFileSync(join(KATEX_DIST, "fonts", f), join(OUT_DIR, "fonts", f));
    fonts += 1;
  }
  writeFileSync(join(OUT_DIR, "VERSION"), `${version}\n`);
  const { K12_MACROS } = await import("../../packages/schema/src/macros.ts");
  writeFileSync(GENERATED_SWIFT_PATH, renderGeneratedSwift(K12_MACROS, version), "utf8");
  console.log(`vendored katex ${version}: js, css, auto-render, ${fonts} woff2 → ${OUT_DIR}`);
  console.log(`wrote ${GENERATED_SWIFT_PATH} (${Object.keys(K12_MACROS).length} macros)`);
}

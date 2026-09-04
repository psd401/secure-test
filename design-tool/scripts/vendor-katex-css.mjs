// Vendors katex.min.css into lib/preview/katex.min.css.ts and copies the
// woff2 font files into public/katex-fonts/.
//
// - The CSS is inlined as a TypeScript constant because Next.js /
//   Turbopack rewrites require.resolve paths in a way that breaks
//   runtime fs.readFileSync against node_modules.
// - The fonts are copied into public/ so they're served by Next.js as
//   static assets at /katex-fonts/<name>.woff2 — the preview iframe's
//   `font-src 'self'` CSP (slice 14) lets the iframe pull them
//   same-origin without any auth indirection.
// - The CSS is rewritten so each `fonts/X.woff2` URL becomes
//   `/katex-fonts/X.woff2`. The woff and ttf fallback URLs are
//   stripped (we don't ship those formats) — same approach PoC-B's
//   TestRunner.swift uses at runtime.
//
// Run after any katex package upgrade:
//   bun scripts/vendor-katex-css.mjs

import { createRequire } from "node:module";
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));

const katexPkgPath = require.resolve("katex/package.json");
const katexDistDir = join(dirname(katexPkgPath), "dist");
const katexCssPath = join(katexDistDir, "katex.min.css");
const katexFontsDir = join(katexDistDir, "fonts");
const katexVersion = JSON.parse(readFileSync(katexPkgPath, "utf8")).version;

let css = readFileSync(katexCssPath, "utf8");

// Strip the woff and ttf fallback URLs so the browser doesn't 404 trying
// to load them (we ship only woff2 — modern WKWebView + every browser the
// design tool targets supports it).
css = css.replace(
  /,url\(fonts\/[^)]+\.(?:woff|ttf)\) format\("(?:woff|truetype)"\)/g,
  "",
);

// Point each remaining `fonts/X.woff2` at the public static path.
css = css.replace(/url\(fonts\/([^)]+\.woff2)\)/g, "url(/katex-fonts/$1)");

if (css.includes("`") || css.includes("${")) {
  throw new Error("katex.min.css contains backtick or ${ — needs escaping");
}

const out = `// Auto-generated. Do not edit by hand.
// Source: katex@${katexVersion} dist/katex.min.css
// Regenerate with: bun scripts/vendor-katex-css.mjs

export const KATEX_VERSION = "${katexVersion}";

export const KATEX_CSS = String.raw\`${css}\`;
`;

const cssDestination = resolve(here, "..", "lib", "preview", "katex.min.css.ts");
writeFileSync(cssDestination, out, "utf8");
console.log(
  `wrote ${cssDestination} (${css.length} bytes of katex@${katexVersion} CSS)`,
);

// Copy fonts into public/katex-fonts/ for Next.js static-asset serving.
const publicFontsDir = resolve(here, "..", "public", "katex-fonts");
rmSync(publicFontsDir, { recursive: true, force: true });
mkdirSync(publicFontsDir, { recursive: true });

const woff2Files = readdirSync(katexFontsDir).filter((f) =>
  f.endsWith(".woff2"),
);
for (const filename of woff2Files) {
  copyFileSync(join(katexFontsDir, filename), join(publicFontsDir, filename));
}
console.log(
  `copied ${woff2Files.length} woff2 fonts to ${publicFontsDir}`,
);

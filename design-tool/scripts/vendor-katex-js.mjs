// Vendors katex.min.js into lib/preview/katex.min.js.ts for the interactive
// editor preview (editor redesign Phase 5 slice B, ADR 0019 §3): the preview
// frame inlines KaTeX as one hash-pinned script, exactly as the student's
// page inlines the client's vendored copy (client/scripts/vendor-katex.mjs —
// the same file from the same design-tool node_modules, so both are one
// version; test/preview-shell.test.ts checks all three agree).
//
// A TypeScript constant for the same reason as katex.min.css.ts: Next.js /
// Turbopack cannot readFileSync from node_modules at request time.
//
// Run after any katex package upgrade (and the client's vendor-katex.mjs):
//   bun scripts/vendor-katex-js.mjs

import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));

const katexPkgPath = require.resolve("katex/package.json");
const katexVersion = JSON.parse(readFileSync(katexPkgPath, "utf8")).version;
const js = readFileSync(join(dirname(katexPkgPath), "dist", "katex.min.js"), "utf8");

// The frame inlines it into a <script> element.
if (/<\/script/i.test(js) || js.includes("<!--")) {
  throw new Error("katex.min.js contains </script or <!-- — cannot be inlined");
}

const out = `// Auto-generated. Do not edit by hand.
// Source: katex@${katexVersion} dist/katex.min.js
// Regenerate with: bun scripts/vendor-katex-js.mjs

export const KATEX_JS_VERSION = "${katexVersion}";

export const KATEX_JS: string = ${JSON.stringify(js)};
`;

const destination = resolve(here, "..", "lib", "preview", "katex.min.js.ts");
writeFileSync(destination, out, "utf8");
console.log(`wrote ${destination} (${js.length} bytes of katex@${katexVersion} JS)`);

// Reads the canonical K-12 macro set from @secure-test/schema and
// writes Sources/PocBClient/GeneratedKatexMacros.swift with a JSON
// constant the WKWebView's inline JS can interpolate directly.
//
// This script is the only thing that imports @secure-test/schema from
// PoC-B. The Swift target itself doesn't depend on bun/Node at build
// time — the generated file is checked into the repo so PoC-B builds
// stay self-contained.
//
// Run after any change to packages/schema/src/macros.ts:
//   cd poc-b-test-loop/client && bun scripts/vendor-katex-macros.mjs

import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Absolute path of the checked-in generated file.
 *
 * Exported so the drift check in packages/schema/test/macros.test.ts can read
 * the same file this script writes, instead of hardcoding the path twice.
 */
export const GENERATED_SWIFT_PATH = resolve(
  here,
  "..",
  "Sources",
  "PocBClient",
  "GeneratedKatexMacros.swift",
);

/**
 * Pure render step: macros object → the exact contents of the .swift file.
 *
 * Exported so the drift check asserts against THIS function rather than
 * re-implementing the format. Re-implementing it would mean a formatting
 * change could pass the test while producing a different file on disk — the
 * test would be checking its own copy of the rules, not the generator's.
 *
 * Keys are sorted so output is deterministic: any reorder in the source object
 * shows up as a one-line diff, never a noisy reshuffle.
 *
 * Swift's raw-string delimiter (#"""..."""#) means backslashes pass through
 * literally — exactly what we want, since the JSON contains double-backslash
 * sequences that the JS engine parses back to single backslashes when the
 * constant is interpolated into the inline JS source.
 */
export function renderGeneratedSwift(macros) {
  const sortedKeys = Object.keys(macros).sort();
  const sorted = Object.fromEntries(sortedKeys.map((k) => [k, macros[k]]));
  const json = JSON.stringify(sorted, null, 2);

  return `// Auto-generated. Do not edit by hand.
// Source: @secure-test/schema K12_MACROS (slice 16).
// Regenerate with: cd poc-b-test-loop/client && bun scripts/vendor-katex-macros.mjs

enum GeneratedKatexMacros {
    static let json: String = #"""
${json}
"""#
}
`;
}

// Only write when invoked as a script — importing this module (as the drift
// check does) must not have the side effect of regenerating the file, or the
// check could "fix" the drift it exists to detect and always pass.
if (import.meta.main) {
  // Import directly from the schema package's source. We use a relative
  // path rather than the package name because the PoC-B client isn't a
  // bun-workspaces member (it's a SwiftPM target). Bun transparently
  // transforms the TS source at runtime so no `bun run build` of the
  // schema package is required first.
  const { K12_MACROS } = await import("../../../packages/schema/src/macros.ts");
  const out = renderGeneratedSwift(K12_MACROS);
  writeFileSync(GENERATED_SWIFT_PATH, out, "utf8");
  console.log(
    `wrote ${GENERATED_SWIFT_PATH} (${Object.keys(K12_MACROS).length} macros, ${out.length} bytes)`,
  );
}

// Copies the student page's base stylesheet (`PageShell.baseStyles`, client/
// SecureTestCore/Sources/SecureTestCore/PageShell.swift) into
// lib/preview/interactive/pageShell.generated.ts for the interactive editor
// preview (editor redesign Phase 5 slice B, ADR 0019). The served renderer
// carries the item styles (renderer.css); the page's tokens, typography and
// layout stay in the Swift shell until renderer slice 5, so the preview takes
// them from the same literal, read by packages/renderer's own extractor.
//
// The client tree is not in the design tool's Docker image, hence a checked-in
// copy; test/preview-shell.test.ts fails while it drifts from the Swift.
//
//   bun scripts/vendor-page-shell.ts   (from design-tool/)
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { collectLiterals, resolveLiteral } from "../../packages/renderer/scripts/extract-swift";

export const PAGE_SHELL_SWIFT = "client/SecureTestCore/Sources/SecureTestCore/PageShell.swift";
const REPO = join(import.meta.dir, "..", "..");

export function extractBaseStyles(): string {
  const source = readFileSync(join(REPO, PAGE_SHELL_SWIFT), "utf8");
  return resolveLiteral("baseStyles", collectLiterals([{ file: PAGE_SHELL_SWIFT, source }]));
}

export function renderModule(css: string): string {
  return `// Auto-generated. Do not edit by hand.
// Source: ${PAGE_SHELL_SWIFT} (PageShell.baseStyles)
// Regenerate with: bun scripts/vendor-page-shell.ts (from design-tool/)

export const PAGE_BASE_STYLES: string = ${JSON.stringify(css)};
`;
}

if (import.meta.main) {
  const css = extractBaseStyles();
  if (css.includes("</")) throw new Error("PageShell.baseStyles contains </ — cannot be inlined");
  const destination = join(import.meta.dir, "..", "lib", "preview", "interactive", "pageShell.generated.ts");
  writeFileSync(destination, renderModule(css), "utf8");
  console.log(`wrote ${destination} (${css.length} bytes)`);
}

// The interactive preview's frame document (editor redesign Phase 5 slice B,
// ADR 0019 §1–§3). Pure: the route hands in the bytes, this assembles them.
//
// The document is the SAME for every assessment — no item content, no key:
//   <head>  the CSP as a <meta> (no frame-ancestors, which is header-only);
//           styles in the student page's order (PageShell.document): the
//           brand fonts, PageShell.baseStyles, KaTeX's CSS, renderer.css
//   <body>  <h1></h1> and <div id="items"></div>, as AssessmentPage.html();
//           KaTeX (inline, hash-pinned); the renderer as an INERT
//           <script type="text/plain"> the bootstrap copies into a real
//           script once the content has arrived (hash-pinned too — a hash
//           source covers an inline script inserted by script); then the
//           bootstrap (inline, hash-pinned).
//
// Hashes are computed here from the exact text inlined, never from
// constants, so a renderer deploy cannot leave a stale pin behind; a mismatch
// fails closed (the browser blocks the script and the preview stays blank).
import { createHash } from "node:crypto";
import { PREVIEW_BOOTSTRAP_JS, RENDERER_SOURCE_ID } from "./bootstrap";

export interface PreviewShellParts {
  rendererJs: string;
  rendererCss: string;
  katexJs: string;
  /** KaTeX's CSS with its fonts already inlined as data: URIs. */
  katexCss: string;
  /** PageShell.baseStyles (lib/preview/interactive/pageShell.generated.ts). */
  baseCss: string;
  /** `@font-face` rules for the brand faces, data: URIs, or "". */
  fontsCss: string;
  /** Test seam; the route always uses PREVIEW_BOOTSTRAP_JS. */
  bootstrapJs?: string;
}

export interface PreviewShell {
  html: string;
  /** The Content-Security-Policy response header. */
  csp: string;
  /** The three `'sha256-…'` sources, in order: bootstrap, KaTeX, renderer. */
  scriptHashes: [string, string, string];
}

/** A CSP hash source for one inline script's text (UTF-8, SHA-256, base64). */
export function scriptHashSource(text: string): string {
  return `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;
}

/**
 * ADR 0019 §2. `header: true` adds the two directives a <meta> policy cannot
 * carry — `frame-ancestors 'self'` and `sandbox allow-scripts` (the latter
 * keeps the document opaque-origin even if someone opens the URL outside the
 * editor's sandboxed iframe).
 */
export function previewCsp(hashes: readonly string[], options: { header: boolean }): string {
  const directives = [
    "default-src 'none'",
    `script-src ${hashes.join(" ")}`,
    "style-src 'unsafe-inline'",
    "img-src data:",
    "font-src data:",
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ];
  if (options.header) directives.push("frame-ancestors 'self'", "sandbox allow-scripts");
  return directives.join("; ");
}

/** Refuses text that could end its element early or change how it parses. */
function assertInlinable(label: string, text: string, element: "script" | "style"): void {
  if (new RegExp(`</${element}`, "i").test(text)) {
    throw new Error(`${label} contains </${element} and cannot be inlined`);
  }
  if (element === "script" && text.includes("<!--")) {
    throw new Error(`${label} contains <!-- and cannot be inlined`);
  }
}

export function buildPreviewShell(parts: PreviewShellParts): PreviewShell {
  const bootstrapJs = parts.bootstrapJs ?? PREVIEW_BOOTSTRAP_JS;
  assertInlinable("the bootstrap", bootstrapJs, "script");
  assertInlinable("KaTeX", parts.katexJs, "script");
  assertInlinable("renderer.js", parts.rendererJs, "script");
  const styles = [parts.fontsCss, parts.baseCss, parts.katexCss, parts.rendererCss].filter((s) => s.length > 0);
  styles.forEach((css, i) => assertInlinable(`stylesheet ${i + 1}`, css, "style"));

  const scriptHashes: [string, string, string] = [
    scriptHashSource(bootstrapJs),
    scriptHashSource(parts.katexJs),
    scriptHashSource(parts.rendererJs),
  ];
  const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${previewCsp(scriptHashes, { header: false })}">
<title>Student preview</title>
${styles.map((css) => `<style>${css}</style>`).join("\n")}
</head><body>
<h1></h1>
<div id="items"></div>
<script>${parts.katexJs}</script>
<script type="text/plain" id="${RENDERER_SOURCE_ID}">${parts.rendererJs}</script>
<script>${bootstrapJs}</script>
</body></html>
`;
  return { html, csp: previewCsp(scriptHashes, { header: true }), scriptHashes };
}

/** KaTeX's vendored CSS points at /katex-fonts/<file>; the frame has no network. */
export function inlineKatexFonts(css: string, readFont: (file: string) => Uint8Array | null): string {
  return css.replace(/url\(\/katex-fonts\/([A-Za-z0-9_-]+\.woff2)\)/g, (whole, file: string) => {
    const bytes = readFont(file);
    return bytes ? `url(data:font/woff2;base64,${Buffer.from(bytes).toString("base64")})` : whole;
  });
}

/** The brand faces, as PageFonts.swift writes them. */
export const BRAND_FACES = [
  { family: "Inter", file: "inter-latin-var.woff2", weightRange: "100 900" },
  { family: "Josefin Sans", file: "josefin-sans-latin-var.woff2", weightRange: "100 700" },
] as const;

export function brandFontsCss(readFont: (file: string) => Uint8Array | null): string {
  return BRAND_FACES.flatMap((face) => {
    const bytes = readFont(face.file);
    if (!bytes) return [];
    return [
      `@font-face {
  font-family: '${face.family}';
  src: url(data:font/woff2;base64,${Buffer.from(bytes).toString("base64")}) format('woff2');
  font-weight: ${face.weightRange};
  font-style: normal;
  font-display: swap;
}`,
    ];
  }).join("\n");
}

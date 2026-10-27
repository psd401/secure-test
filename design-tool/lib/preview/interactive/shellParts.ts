// Where the interactive preview frame's bytes come from (ADR 0019 §3).
//
// - The renderer: the current SIGNED renderer the delivery bundle would name
//   (`currentRenderer()`, which has re-verified the manifest signature and
//   every file's hash), read from the same storage the renderer route serves.
//   When none is named (dev, or renderer delivery not set up), the locally
//   built `packages/renderer/dist` (`bun run build` there). Neither → null,
//   and the route answers 503.
// - KaTeX: the design tool's vendored copy (lib/preview/katex.min.js.ts and
//   katex.min.css.ts — the version the client vendors), its fonts read from
//   public/katex-fonts and inlined as data: URIs (the frame has no network).
// - The page's base styles and brand fonts: PageShell.baseStyles
//   (pageShell.generated.ts) and public/fonts, as PageFonts.swift inlines them.
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { currentRenderer, rendererObjectKey } from "@/lib/renderer/current";
import { getStorageProvider } from "@/lib/storage/provider";
import { KATEX_CSS } from "@/lib/preview/katex.min.css";
import { KATEX_JS } from "@/lib/preview/katex.min.js";
import { PAGE_BASE_STYLES } from "./pageShell.generated";
import { brandFontsCss, inlineKatexFonts, type PreviewShellParts } from "./shell";

export type PreviewRendererOrigin = "signed" | "local";

export interface PreviewRenderer {
  js: string;
  css: string;
  origin: PreviewRendererOrigin;
  /** The manifest sha256 (signed) or the dist file's mtime (local). */
  tag: string;
}

const utf8 = new TextDecoder("utf-8", { fatal: true });
let signedCache: PreviewRenderer | null = null;

/** `process.cwd()` is design-tool/ in dev and in the standalone image. */
function localDist(file: string): string {
  return join(process.cwd(), "..", "packages", "renderer", "dist", file);
}

export async function loadPreviewRenderer(): Promise<PreviewRenderer | null> {
  const current = await currentRenderer();
  if (current) {
    if (signedCache?.tag === current.sha256) return signedCache;
    const storage = getStorageProvider();
    const js = utf8.decode(await storage.get(rendererObjectKey(current.sha256, "renderer.js")));
    const css = utf8.decode(await storage.get(rendererObjectKey(current.sha256, "renderer.css")));
    signedCache = { js, css, origin: "signed", tag: current.sha256 };
    return signedCache;
  }
  try {
    const jsPath = localDist("renderer.js");
    return {
      js: readFileSync(jsPath, "utf8"),
      css: readFileSync(localDist("renderer.css"), "utf8"),
      origin: "local",
      tag: String(statSync(jsPath).mtimeMs),
    };
  } catch {
    return null;
  }
}

function publicFile(dir: string, file: string): Uint8Array | null {
  try {
    return readFileSync(join(process.cwd(), "public", dir, file));
  } catch {
    return null;
  }
}

let staticCache: Pick<PreviewShellParts, "katexJs" | "katexCss" | "baseCss" | "fontsCss"> | null = null;

/** Everything but the renderer: fixed for the life of the process. */
export function staticShellParts(): Pick<PreviewShellParts, "katexJs" | "katexCss" | "baseCss" | "fontsCss"> {
  staticCache ??= {
    katexJs: KATEX_JS,
    katexCss: inlineKatexFonts(KATEX_CSS, (file) => publicFile("katex-fonts", file)),
    baseCss: PAGE_BASE_STYLES,
    fontsCss: brandFontsCss((file) => publicFile("fonts", file)),
  };
  return staticCache;
}

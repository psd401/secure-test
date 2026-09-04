// Spike S3 (docs/stimulus-design.md, 2026-09-01): does the text layer, via
// unpdf / pdf.js, expose emphasis per run — bold / italic from the font,
// underline from anything at all — so E6 (rich text in stems) could ride
// E5's extractor rework? Throwaway. Prints every text item whose font name
// suggests bold/italic on the pages given, plus the font names seen.
//
// Usage (repo root): bun docs/scripts/stimulus-fontruns-spike.ts "<pdf name substring>" [page]
import { createRequire } from "node:module";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const DT = join(resolve(import.meta.dir, "../.."), "design-tool");
const require = createRequire(join(DT, "package.json"));
const { getDocumentProxy } = require("unpdf") as { getDocumentProxy: (d: Uint8Array) => Promise<any> };
const SAMPLES = join(DT, "samples");
const filter = (process.argv[2] ?? "").toLowerCase();
const onlyPage = process.argv[3] ? Number(process.argv[3]) : undefined;
const name = readdirSync(SAMPLES).find((f) => f.toLowerCase().endsWith(".pdf") && f.toLowerCase().includes(filter));
if (!name) throw new Error(`no sample matches "${filter}"`);
const doc = await getDocumentProxy(new Uint8Array(readFileSync(join(SAMPLES, name))));
console.log(`${name}: ${doc.numPages} pages`);
const fontsSeen = new Map<string, number>();
for (let p = 1; p <= doc.numPages; p++) {
  if (onlyPage && p !== onlyPage) continue;
  const page = await doc.getPage(p);
  // Fonts land in page.commonObjs while the operator list is built — before
  // that, commonObjs.get throws "isn't resolved yet".
  await page.getOperatorList();
  const tc = await page.getTextContent();
  // pdf.js resolves font objects lazily into page.commonObjs; a text item's
  // fontName is the key. The loaded font carries the PDF's BaseFont name
  // (e.g. "Arial-BoldMT", "TimesNewRomanPS-BoldItalicMT") — the only
  // emphasis signal in a text layer. Underline is a drawn path, not text.
  const fontName = (key: string): string => {
    try { const f = page.commonObjs.get(key); return f?.name ?? f?.loadedName ?? key; } catch { return key; }
  };
  for (const it of tc.items as any[]) {
    if (!it.str?.trim()) continue;
    const fn = fontName(it.fontName);
    fontsSeen.set(fn, (fontsSeen.get(fn) ?? 0) + 1);
    let f: any = null;
    try { f = page.commonObjs.get(it.fontName); } catch {}
    // pdf.js sets bold/italic from the descriptor flags + the BaseFont name.
    const bold = !!f?.bold || /bold|black|heavy|semibold|demibold/i.test(fn);
    const italic = !!f?.italic || /italic|oblique/i.test(fn);
    const size = Math.round(Math.hypot(it.transform[0], it.transform[1]) * 10) / 10;
    if (bold || italic || /sub|sup/i.test(process.env.SHOW ?? "")) console.log(`  p${p} ${bold ? "BOLD " : ""}${italic ? "ITALIC " : ""}[${fn} ${size}pt y=${Math.round(it.transform[5])}] "${it.str.slice(0, 60)}"`);
  }
}
if (/sub|sup/i.test(process.env.SHOW ?? "")) {
  // E7 probe: a subscript is a separate run at a smaller size on a lower baseline.
  for (let p = 1; p <= doc.numPages; p++) {
    if (onlyPage && p !== onlyPage) continue;
    const page = await doc.getPage(p); await page.getOperatorList();
    const tc = await page.getTextContent();
    const sizes = (tc.items as any[]).filter((i) => i.str?.trim()).map((i) => Math.hypot(i.transform[0], i.transform[1]));
    const body = sizes.sort((a, b) => a - b)[Math.floor(sizes.length / 2)] ?? 0;
    for (const it of tc.items as any[]) {
      const sz = Math.hypot(it.transform[0], it.transform[1]);
      if (it.str?.trim() && sz < body * 0.8) console.log(`  p${p} SMALL ${sz.toFixed(1)}pt (body ${body.toFixed(1)}) y=${Math.round(it.transform[5])} "${it.str.slice(0, 40)}"`);
    }
  }
}
console.log("fonts seen:", [...fontsSeen].map(([k, v]) => `${k}×${v}`).join(", "));

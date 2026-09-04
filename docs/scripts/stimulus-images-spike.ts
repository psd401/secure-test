// Spike S1 (docs/stimulus-design.md, 2026-09-01): can unpdf / pdf.js — the
// pure-JS extractor the app already ships (ADR 0013) — recover each raster
// figure in the teacher sample WITH its page position, so E5's extraction
// can place [FIGURE n] markers and attach the figure as an asset?
//
// Throwaway. Walks every page's operator list with a CTM stack (save /
// restore / transform / form-XObject begin+end) and records the bbox of
// every image paint in viewport space (top-left origin, rotation applied —
// the same frame PyMuPDF's page.get_image_rects reports in), pulls the
// pixels through unpdf's extractImages, writes each figure as a PNG for a
// legibility spot-check, and compares against the PyMuPDF baseline the
// stimulus scan produced (42 figures, >40pt on both sides).
//
// Usage (from the repo root; unpdf resolves through design-tool):
//   bun docs/scripts/stimulus-images-spike.ts <out-dir> [pymupdf-baseline.json]
import { createRequire } from "node:module";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { deflateSync } from "node:zlib";

const ROOT = resolve(import.meta.dir, "../..");
const DT = join(ROOT, "design-tool");
const require = createRequire(join(DT, "package.json"));
const { getDocumentProxy, extractImages, getResolvedPDFJS } = require("unpdf") as {
  getDocumentProxy: (data: Uint8Array) => Promise<any>;
  extractImages: (doc: any, page: number) => Promise<any[]>;
  getResolvedPDFJS: () => Promise<any>;
};
const SAMPLES = join(DT, "samples");
const OUT = process.argv[2] ?? join(SAMPLES, "spike-s1");
const BASELINE = process.argv[3];
mkdirSync(OUT, { recursive: true });
const MIN_PT = 40;

type M = [number, number, number, number, number, number];
const mul = (m1: M, m2: M): M => [
  m1[0] * m2[0] + m1[2] * m2[1],
  m1[1] * m2[0] + m1[3] * m2[1],
  m1[0] * m2[2] + m1[2] * m2[3],
  m1[1] * m2[2] + m1[3] * m2[3],
  m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
  m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
];
const apply = (m: M, x: number, y: number) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

// ---- minimal PNG writer (gray / rgb / rgba) ----
const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf: Uint8Array): number {
  let c = -1;
  for (const b of buf) c = CRC[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type: string, data: Uint8Array): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), Buffer.from(data)]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(width: number, height: number, channels: number, data: Uint8ClampedArray | Uint8Array): Buffer {
  // 2-channel (gray+alpha) is expanded to RGBA; 1 → gray, 3 → rgb, 4 → rgba.
  let ch = channels, src: Uint8Array = data as Uint8Array;
  if (channels === 2) {
    const out = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) { out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = data[i * 2]!; out[i * 4 + 3] = data[i * 2 + 1]!; }
    ch = 4; src = out;
  }
  const colorType = ch === 1 ? 0 : ch === 3 ? 2 : 6;
  const stride = width * ch;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(src.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = colorType; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array(0)),
  ]);
}

interface Found {
  pdf: string; page: number; name: string; kind: string;
  bbox: [number, number, number, number]; px_w: number; px_h: number; channels: number;
  ppp: number; // pixels per point (72 × ppp = effective dpi)
  file?: string;
}

const pdfjs = await getResolvedPDFJS();
const OPS = pdfjs.OPS as Record<string, number>;
const found: Found[] = [];
const pdfs = readdirSync(SAMPLES).filter((f) => f.toLowerCase().endsWith(".pdf")).sort();

for (const name of pdfs) {
  const doc = await getDocumentProxy(new Uint8Array(readFileSync(join(SAMPLES, name))));
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const vp = page.getViewport({ scale: 1 });
    const base = vp.transform as M; // PDF user space → top-left-origin page space
    const ops = await page.getOperatorList();
    const stack: M[] = [];
    let ctm: M = base;
    const paints: { name: string; kind: string; bbox: [number, number, number, number]; w?: number; h?: number }[] = [];
    const record = (name: string, kind: string, m: M, w?: number, h?: number) => {
      const pts = [apply(m, 0, 0), apply(m, 1, 0), apply(m, 0, 1), apply(m, 1, 1)];
      const xs = pts.map((q) => q[0]!), ys = pts.map((q) => q[1]!);
      paints.push({ name, kind, bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], w, h });
    };
    for (let i = 0; i < ops.fnArray.length; i++) {
      const fn = ops.fnArray[i], args = ops.argsArray[i];
      if (fn === OPS.save) stack.push(ctm);
      else if (fn === OPS.restore) ctm = stack.pop() ?? ctm;
      else if (fn === OPS.transform) ctm = mul(ctm, args as M);
      else if (fn === OPS.paintFormXObjectBegin) { stack.push(ctm); if (args?.[0]) ctm = mul(ctm, args[0] as M); }
      else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() ?? ctm;
      else if (fn === OPS.paintImageXObject) record(String(args[0]), "image", ctm);
      else if (fn === OPS.paintImageXObjectRepeat) {
        const [id, sx, sy, pos] = args as [string, number, number, number[]];
        for (let k = 0; k < pos.length; k += 2) record(String(id), "image-repeat", mul(ctm, [sx, 0, 0, sy, pos[k]!, pos[k + 1]!]));
      }
      else if (fn === OPS.paintInlineImageXObject) record("inline", "inline", ctm, args[0]?.width, args[0]?.height);
      else if (fn === OPS.paintImageMaskXObject) record("mask", "mask", ctm, args[0]?.width, args[0]?.height);
    }
    // pixels
    let imgs: any[] = [];
    try { imgs = await extractImages(doc, p); } catch (e) { console.log(`  extractImages failed ${name} p${p}: ${(e as Error).message}`); }
    const byKey = new Map<string, any>(imgs.map((im) => [String(im.key), im]));
    let n = 0;
    for (const pt of paints) {
      const [x0, y0, x1, y1] = pt.bbox;
      if (x1 - x0 <= MIN_PT || y1 - y0 <= MIN_PT) continue; // same floor as the scan
      const im = byKey.get(pt.name);
      const px_w = im?.width ?? pt.w ?? 0, px_h = im?.height ?? pt.h ?? 0;
      const rec: Found = {
        pdf: name, page: p, name: pt.name, kind: pt.kind,
        bbox: [x0, y0, x1, y1].map((v) => Math.round(v * 10) / 10) as Found["bbox"],
        px_w, px_h, channels: im?.channels ?? 0, ppp: px_w ? Math.round((px_w / (x1 - x0)) * 100) / 100 : 0,
      };
      if (im?.data) {
        const file = `${name.replace(/\.pdf$/i, "").replace(/[^\w.-]+/g, "_").slice(0, 40)}-p${p}-${++n}.png`;
        writeFileSync(join(OUT, file), png(im.width, im.height, im.channels, im.data));
        rec.file = file;
      }
      found.push(rec);
    }
  }
  console.log(`${name}: ${found.filter((f) => f.pdf === name).length} figures ≥${MIN_PT}pt`);
}
writeFileSync(join(OUT, "unpdf-figures.json"), JSON.stringify(found, null, 1));

// ---- compare with the PyMuPDF baseline ----
if (BASELINE) {
  const base = JSON.parse(readFileSync(BASELINE, "utf8")) as { pdf: string; page: number; bbox: number[]; px_w: number; px_h: number }[];
  const iou = (a: number[], b: number[]) => {
    const ix = Math.max(0, Math.min(a[2]!, b[2]!) - Math.max(a[0]!, b[0]!));
    const iy = Math.max(0, Math.min(a[3]!, b[3]!) - Math.max(a[1]!, b[1]!));
    const inter = ix * iy;
    const ua = (a[2]! - a[0]!) * (a[3]! - a[1]!) + (b[2]! - b[0]!) * (b[3]! - b[1]!) - inter;
    return ua > 0 ? inter / ua : 0;
  };
  let matched = 0, withPixels = 0;
  const perPdf = new Map<string, { base: number; unpdf: number; matched: number }>();
  const used = new Set<number>();
  for (const b of base) {
    const row = perPdf.get(b.pdf) ?? { base: 0, unpdf: 0, matched: 0 };
    row.base++;
    let best = -1, bestIou = 0;
    found.forEach((f, i) => {
      if (used.has(i) || f.pdf !== b.pdf || f.page !== b.page) return;
      const v = iou(f.bbox, b.bbox);
      if (v > bestIou) { bestIou = v; best = i; }
    });
    if (best >= 0 && bestIou >= 0.5) { used.add(best); matched++; row.matched++; if (found[best]!.file) withPixels++; }
    else console.log(`  UNMATCHED baseline: ${b.pdf} p${b.page} bbox ${b.bbox.join(",")} (best IoU ${bestIou.toFixed(2)})`);
    perPdf.set(b.pdf, row);
  }
  for (const f of found) { const row = perPdf.get(f.pdf) ?? { base: 0, unpdf: 0, matched: 0 }; row.unpdf++; perPdf.set(f.pdf, row); }
  console.log("\npdf | pymupdf | unpdf | matched(IoU≥.5)");
  for (const [pdf, r] of [...perPdf].sort()) console.log(`${pdf.slice(0, 40).padEnd(40)} | ${r.base} | ${r.unpdf} | ${r.matched}`);
  console.log(`\nTOTAL baseline ${base.length}, unpdf ${found.length}, matched ${matched}, matched with pixels ${withPixels}`);
  const ppps = found.filter((f) => f.ppp > 0).map((f) => f.ppp).sort((a, b) => a - b);
  console.log(`effective dpi (72×px/pt): min ${Math.round(ppps[0]! * 72)}, median ${Math.round(ppps[Math.floor(ppps.length / 2)]! * 72)}, max ${Math.round(ppps.at(-1)! * 72)}`);
  const kinds = found.reduce<Record<string, number>>((a, f) => ((a[f.kind] = (a[f.kind] ?? 0) + 1), a), {});
  console.log("kinds:", JSON.stringify(kinds));
}

// Help-page capture (docs/help-capture.md): a fictional quiz PDF for the
// "Import items from PDF" screenshot. Local dev runs the mock extractor,
// which reads the MC:/ST:/ES:/SET: markers (lib/pdfImport/mockProvider.ts).
// Two charts drawn as vector paths (2026-10-08, for the figure strip): the
// first is placed on question 1 by a SET line, the second on nothing, so the
// strip shows one "Used with item 1" and one "Not used".
//
//   cd design-tool && bun scripts/help-capture/make-pdf.ts /tmp/photosynthesis-quiz.pdf
import { buildPdf } from "../../test/helpers/pdf";

const out = process.argv[2];
if (!out) {
  console.error("usage: make-pdf.ts <output.pdf>");
  process.exit(2);
}

const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
const text = (font: "F1" | "F2", size: number, x: number, y: number, s: string) =>
  `BT /${font} ${size} Tf 1 0 0 1 ${x} ${y} Tm (${esc(s)}) Tj ET`;

/** A bar chart: bold title above, bars with labels under them, two axes. */
function chart(title: string, top: number, bars: { label: string; value: number; rgb: string }[]): string[] {
  const left = 110;
  const height = 130;
  const base = top - 20 - height;
  const parts = [text("F2", 12, 72, top, title)];
  bars.forEach((b, i) => {
    const x = left + 14 + i * 70;
    parts.push(`q ${b.rgb} rg ${x} ${base} 46 ${(height * b.value).toFixed(1)} re f Q`);
    parts.push(text("F1", 9, x + 4, base - 12, b.label));
  });
  // Light gridlines make the drawing dense enough to read as a chart.
  for (let g = 1; g <= 4; g++) {
    parts.push(`q 0.85 0.85 0.85 RG 0.5 w ${left} ${base + (g * height) / 4} m ${left + 70 * bars.length} ${base + (g * height) / 4} l S Q`);
  }
  parts.push(
    `q 0 0 0 RG 1 w ${left} ${base} m ${left} ${base + height} l S Q`,
    `q 0 0 0 RG 1 w ${left} ${base} m ${left + 70 * bars.length} ${base} l S Q`,
  );
  return parts;
}

const lines = (top: number, ls: string[]) => ls.map((l, i) => text("F1", 11, 72, top - i * 18, l));
// The mock extractor runs each segment to the next marker, so the charts
// (titles, markers, bar labels) sit above every segment, out of the way.
const page = [
  text("F2", 16, 72, 750, "Photosynthesis Quiz"),
  ...chart("Oxygen bubbles per minute, by light colour", 715, [
    { label: "Red", value: 0.85, rgb: "0.80 0.30 0.25" },
    { label: "Green", value: 0.2, rgb: "0.30 0.60 0.35" },
    { label: "Blue", value: 0.95, rgb: "0.20 0.40 0.75" },
    { label: "Yellow", value: 0.45, rgb: "0.90 0.75 0.20" },
  ]),
  ...chart("Plant mass over two weeks", 525, [
    { label: "Day 0", value: 0.9, rgb: "0.35 0.55 0.45" },
    { label: "Day 7", value: 0.75, rgb: "0.35 0.55 0.45" },
    { label: "Day 14", value: 0.6, rgb: "0.35 0.55 0.45" },
  ]),
  ...lines(330, [
    "SET: #1-1 | figure=1 | Use the chart for question 1.",
    "MC: #1 Which colour of light produced the most oxygen? | a:Red | b:Green | c:Blue | *c",
    "MC: #2 Where in the cell does photosynthesis happen? | a:Mitochondrion | b:Chloroplast | c:Nucleus | *b",
    "ST: #3 What gas do plants take in for photosynthesis? | carbon dioxide",
    "ES: #4 Explain why a plant kept in the dark slowly loses mass.",
  ]),
].join("\n");

await Bun.write(
  out,
  buildPdf([
    "<</Type/Catalog/Pages 2 0 R>>",
    "<</Type/Pages/Kids[3 0 R]/Count 1>>",
    "<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<</Font<</F1 5 0 R/F2 6 0 R>>>>/Contents 4 0 R>>",
    `<</Length ${page.length}>>\nstream\n${page}\nendstream`,
    "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>",
    "<</Type/Font/Subtype/Type1/BaseFont/Helvetica-Bold>>",
  ]),
);

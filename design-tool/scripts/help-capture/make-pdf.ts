// Help-page capture (docs/help-capture.md): a fictional one-page quiz PDF for
// the "Import items from PDF" screenshot. Local dev runs the mock extractor,
// which reads the MC:/ST:/ES: markers (lib/pdfImport/mockProvider.ts).
//
//   cd design-tool && bun scripts/help-capture/make-pdf.ts /tmp/photosynthesis-quiz.pdf
import { makeTextPdf } from "../../test/helpers/pdf";

const out = process.argv[2];
if (!out) {
  console.error("usage: make-pdf.ts <output.pdf>");
  process.exit(2);
}
await Bun.write(
  out,
  makeTextPdf([
    "Photosynthesis Quiz",
    "MC: #1 Where in the cell does photosynthesis happen? | a:Mitochondrion | b:Chloroplast | c:Nucleus | *b",
    "ST: #2 What gas do plants take in for photosynthesis? | carbon dioxide",
    "MC: #3 Which pigment absorbs most of the light? | a:Chlorophyll | b:Melanin | c:Keratin | *a",
    "ES: #4 Explain why a plant kept in the dark slowly loses mass.",
  ]),
);

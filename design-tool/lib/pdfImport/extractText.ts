import { extractText, getDocumentProxy } from "unpdf";

// Slice 42: text-layer PDF extraction via unpdf (pure JS, no native deps —
// the ADR 0013 lesson rules out headless-Chrome / native rasterization in
// this environment). Spike 2026-07-09: 66-page OSPI PDF → 170k chars in
// ~490ms. Image/scanned PDFs yield little text; looksScanned() detects
// that so the route can reject with a helpful message. OCR is deferred but
// a KNOWN future need (docs/phase-3-slices.md).

export interface ExtractedPdf {
  text: string;
  pageCount: number;
}

export async function extractPdfText(bytes: Uint8Array): Promise<ExtractedPdf> {
  // pdfjs TRANSFERS the buffer it is handed — the caller's Uint8Array is
  // detached (byteLength 0) after this call. Copy so callers keep their
  // bytes; the scanned/OCR branch forwards them to the provider (ADR 0015).
  const pdf = await getDocumentProxy(bytes.slice());
  const { totalPages, text } = await extractText(pdf, { mergePages: true });
  return { text, pageCount: totalPages };
}

// Below this many extracted characters per page we treat the PDF as
// scanned/image-only (no usable text layer). A prose test PDF runs
// thousands of chars/page; a scanned one runs ~0. 40 is a wide margin that
// still rejects near-empty text layers.
export const MIN_CHARS_PER_PAGE = 40;

export function looksScanned(text: string, pageCount: number): boolean {
  if (pageCount <= 0) return true;
  const nonWhitespace = text.replace(/\s+/g, "").length;
  return nonWhitespace / pageCount < MIN_CHARS_PER_PAGE;
}

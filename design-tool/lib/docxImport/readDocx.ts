import { inflateRawSync } from "node:zlib";
import { parseWordDocument, type WordDocument } from "./document";

// Editor redesign Phase 7 slice B (R-10, docs/editor-redesign-design.md):
// read a .docx on the server for item import. A .docx is a zip archive; the
// text is in word/document.xml and the automatic list numbers ("1.", "a)")
// are worked out from word/numbering.xml. This is a minimal zip reader —
// only what a Word or Google Docs export needs (stored or deflated entries,
// no ZIP64, no encryption) — so no new dependency comes in for it.

export class DocxReadError extends Error {}

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

/** Each inflated part is capped here, so a zip bomb stops at the cap. A
 * text-heavy document.xml compresses about tenfold; the 5 MiB upload cap
 * (lib/ai/documentUpload.ts) therefore fits well inside. */
export const MAX_DOCX_PART_BYTES = 40 * 1024 * 1024;

/** The named entries of a zip archive, inflated; a name not in the archive
 * is simply absent from the map. Throws DocxReadError on anything else. */
export function readZipEntries(
  bytes: Uint8Array,
  names: readonly string[],
  maxBytes: number = MAX_DOCX_PART_BYTES,
): Map<string, Uint8Array> {
  if (bytes.byteLength < 22) throw new DocxReadError("not a zip archive");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The end-of-central-directory record is the last 22 bytes, plus a
  // comment of up to 65535 bytes.
  let eocd = -1;
  for (let i = bytes.byteLength - 22; i >= Math.max(0, bytes.byteLength - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new DocxReadError("not a zip archive");
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const want = new Set(names);
  const out = new Map<string, Uint8Array>();
  const decoder = new TextDecoder();
  for (let k = 0; k < count; k++) {
    if (p + 46 > bytes.byteLength || view.getUint32(p, true) !== CENTRAL_SIG) {
      throw new DocxReadError("damaged zip directory");
    }
    const flags = view.getUint16(p + 8, true);
    const method = view.getUint16(p + 10, true);
    const compressed = view.getUint32(p + 20, true);
    const size = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (!want.has(name)) continue;
    if (flags & 1) throw new DocxReadError("the document is password-protected");
    if (compressed === 0xffffffff || size === 0xffffffff || local === 0xffffffff) {
      throw new DocxReadError("ZIP64 archives are not supported");
    }
    if (local + 30 > bytes.byteLength || view.getUint32(local, true) !== LOCAL_SIG) {
      throw new DocxReadError("damaged zip entry");
    }
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const data = bytes.subarray(start, start + compressed);
    if (data.byteLength !== compressed) throw new DocxReadError("truncated zip entry");
    if (method === 0) {
      if (compressed > maxBytes) throw new DocxReadError(`${name} is too large`);
      out.set(name, data);
    } else if (method === 8) {
      try {
        out.set(name, new Uint8Array(inflateRawSync(data, { maxOutputLength: maxBytes })));
      } catch {
        throw new DocxReadError(`${name} could not be unpacked`);
      }
    } else {
      throw new DocxReadError(`unsupported zip compression method ${method}`);
    }
  }
  return out;
}

/** A .docx as the import needs it. Throws DocxReadError when the file is
 * not a readable Word document. */
export function readDocx(bytes: Uint8Array): WordDocument {
  const parts = readZipEntries(bytes, ["word/document.xml", "word/numbering.xml"]);
  const doc = parts.get("word/document.xml");
  if (!doc) throw new DocxReadError("no word/document.xml: not a Word document");
  const numbering = parts.get("word/numbering.xml");
  const decoder = new TextDecoder();
  return parseWordDocument(decoder.decode(doc), numbering ? decoder.decode(numbering) : null);
}

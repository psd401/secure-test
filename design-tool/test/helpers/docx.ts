import { deflateRawSync } from "node:zlib";

// Hand-built .docx files for tests (no teacher document enters the repo):
// a zip archive of the parts Word needs, with word/document.xml and an
// optional word/numbering.xml written from the small builders below. Used by
// test/docx-import.test.ts (editor redesign Phase 7 slice B, R-10).

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A zip archive of `files` (deflated unless `stored`). */
export function buildZip(files: Record<string, string | Uint8Array>, opts: { stored?: boolean } = {}): Uint8Array {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const raw = typeof content === "string" ? enc.encode(content) : content;
    const data = opts.stored ? raw : new Uint8Array(deflateRawSync(raw));
    const nameBytes = enc.encode(name);
    const crc = crc32(raw);
    const method = opts.stored ? 0 : 8;
    const local = new Uint8Array(30 + nameBytes.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(8, method, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(data, 30 + nameBytes.length);
    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(10, method, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, raw.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const centralSize = centrals.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, centrals.length, true);
  ev.setUint16(10, centrals.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + centralSize + 22);
  let at = 0;
  for (const part of [...locals, ...centrals, eocd]) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** One run. */
export function run(text: string, f: { b?: boolean; i?: boolean } = {}): string {
  const rpr = f.b || f.i ? `<w:rPr>${f.b ? "<w:b/>" : ""}${f.i ? "<w:i/>" : ""}</w:rPr>` : "";
  return `<w:r>${rpr}<w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
}

/** One paragraph of runs (a plain string is one plain run). `num` puts it in
 * an automatic list; `style` names its paragraph style. */
export function para(
  content: string | string[],
  opts: { num?: { id: number; level?: number }; style?: string } = {},
): string {
  const runs = typeof content === "string" ? run(content) : content.join("");
  const ppr =
    opts.num || opts.style
      ? `<w:pPr>${opts.style ? `<w:pStyle w:val="${opts.style}"/>` : ""}${
          opts.num ? `<w:numPr><w:ilvl w:val="${opts.num.level ?? 0}"/><w:numId w:val="${opts.num.id}"/></w:numPr>` : ""
        }<w:rPr><w:b/></w:rPr></w:pPr>`
      : "";
  return `<w:p>${ppr}${runs}</w:p>`;
}

/** A table of plain-text cells. */
export function table(rows: string[][]): string {
  return `<w:tbl><w:tblPr/>${rows
    .map((r) => `<w:tr>${r.map((c) => `<w:tc><w:tcPr/>${para(c)}</w:tc>`).join("")}</w:tr>`)
    .join("")}</w:tbl>`;
}

/** A picture, as Word writes one inside a run (the image part is not
 * included — the import never reads it). */
export const PICTURE_RUN =
  '<w:r><w:drawing><wp:inline><a:graphic><a:graphicData><pic:pic><pic:nvPicPr><pic:cNvPr id="1" name="Picture 1"/></pic:nvPicPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>';

export function documentXml(body: string[]): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
    body.join("") +
    '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr></w:body></w:document>'
  );
}

/** numbering.xml with one decimal "%1." list (abstract 0, level 0) and a
 * lower-letter "%2)" second level, reachable through num ids 1 and 2 — num 2
 * restarts level 0 at 1 (Word's "Restart at 1"). */
export const NUMBERING_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
  '<w:abstractNum w:abstractNumId="0">' +
  '<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl>' +
  '<w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="lowerLetter"/><w:lvlText w:val="%2)"/></w:lvl>' +
  "</w:abstractNum>" +
  '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>' +
  '<w:num w:numId="2"><w:abstractNumId w:val="0"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num>' +
  "</w:numbering>";

/** A whole .docx from body parts. */
export function makeDocx(body: string[], opts: { numbering?: string | null; stored?: boolean } = {}): Uint8Array {
  const files: Record<string, string> = {
    "[Content_Types].xml":
      '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    "_rels/.rels":
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    "word/document.xml": documentXml(body),
  };
  if (opts.numbering !== null) files["word/numbering.xml"] = opts.numbering ?? NUMBERING_XML;
  return buildZip(files, { stored: opts.stored });
}

export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

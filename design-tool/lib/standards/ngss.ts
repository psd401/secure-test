// Pure parsing of the NGSS "All Disciplinary Core Ideas" PDF text into
// performance expectations (docs/batch-item-generation-design.md, slice 1b).
// scripts/extract-ngss.ts reads the PDF (not committed), checks its checksum
// and writes the result to sources/ngss-performance-expectations.json; the
// catalog build reads that JSON. Input here is one string per PDF page.

export type NgssEntry = {
  code: string;
  text: string;
  clarification?: string;
  assessment_boundary?: string;
  /** The PDF marks engineering-integrated expectations with a trailing asterisk. */
  engineering?: true;
};

export const NGSS_CODE = /^((?:K|[1-5]|K-2|3-5|MS|HS)-(?:PS|LS|ESS|ETS)\d-\d)\.\s+/;

// A tag can wrap right after its first word ("[Clarification\nStatement:").
const BRACKET_START = /\[\s*(?:Clarification|Assessment)\b/;
const norm = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * One performance expectation: `CODE. statement` wrapped over lines, then up
 * to two bracketed groups that can wrap over lines and page breaks. Whatever
 * follows (section headings, element tables) is ignored.
 */
function parseOne(code: string, firstLine: string, more: string[]): NgssEntry {
  const lines = [firstLine, ...more];
  const statement: string[] = [];
  let rest = "";
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const at = line.search(BRACKET_START);
    if (at >= 0) {
      statement.push(line.slice(0, at));
      rest = [line.slice(at), ...lines.slice(i + 1)].join(" ");
      break;
    }
    statement.push(line);
    if (/[.*]\s*$/.test(line)) {
      rest = lines.slice(i + 1).join(" ");
      break;
    }
  }

  let text = norm(statement.join(" "));
  const entry: NgssEntry = { code, text };
  if (text.endsWith("*")) {
    text = norm(text.slice(0, -1));
    entry.text = text;
    entry.engineering = true;
  }
  if (!text.endsWith(".")) throw new Error(`NGSS ${code}: statement does not end with a period: "${text}"`);

  let tail = norm(rest);
  let tags = 0;
  for (;;) {
    // The second word is read loosely: HS-PS1-2 prints "Clarification Steatement".
    const m = /^\[\s*(Clarification|Assessment)\s+[A-Za-z]+\s*:\s*/.exec(tail);
    if (!m) break;
    const close = tail.indexOf("]", m[0].length);
    if (close === -1) throw new Error(`NGSS ${code}: unterminated [${m[1]} tag`);
    const body = norm(tail.slice(m[0].length, close));
    if (m[1] === "Clarification") {
      if (entry.clarification !== undefined) throw new Error(`NGSS ${code}: two clarification statements`);
      entry.clarification = body;
    } else {
      if (entry.assessment_boundary !== undefined) throw new Error(`NGSS ${code}: two assessment boundaries`);
      entry.assessment_boundary = body;
    }
    tags += 1;
    tail = tail.slice(close + 1).trim();
  }
  // Every bracket tag inside this expectation must have been consumed.
  const seen = (lines.join(" ").match(new RegExp(BRACKET_START, "g")) ?? []).length;
  if (seen !== tags) throw new Error(`NGSS ${code}: found ${seen} bracket tags, parsed ${tags}`);
  return entry;
}

function ordered(e: NgssEntry): NgssEntry {
  const out: NgssEntry = { code: e.code, text: e.text };
  if (e.clarification !== undefined) out.clarification = e.clarification;
  if (e.assessment_boundary !== undefined) out.assessment_boundary = e.assessment_boundary;
  if (e.engineering) out.engineering = true;
  return out;
}


// Two pages of the PDF (MS-LS3, MS-ESS1) come out of the text layer with a stray
// space after many letters ("E mphasis", "ty pes", "[C larification S tatement").
// A page is "damaged" when it shows one of those signatures; on those pages a
// space between letter runs is dropped when the joined word occurs on an
// undamaged page (or in EXTRA_WORDS) and the pieces were not already two words.
const DAMAGE = /\bw ith\b|\bC larification\b|\bA ssessment\b/;
// Words the damaged pages need that no undamaged page carries.
const EXTRA_WORDS = ["Punnett"];

function vocabulary(pages: string[]): Set<string> {
  const vocab = new Set(EXTRA_WORDS.map((w) => w.toLowerCase()));
  for (const page of pages) {
    if (DAMAGE.test(page)) continue;
    for (const w of page.match(/[A-Za-z]+/g) ?? []) vocab.add(w.toLowerCase());
  }
  return vocab;
}

function repairLine(line: string, vocab: Set<string>): string {
  const isWord = (w: string) => w.length > 1 ? vocab.has(w.toLowerCase()) : "aAI".includes(w);
  const toks = line.split(" ");
  const out: string[] = [];
  for (let i = 0; i < toks.length; ) {
    let merged = false;
    for (const n of [3, 2]) {
      if (i + n > toks.length) continue;
      const parts = toks.slice(i, i + n);
      const first = /^([^A-Za-z]*)([A-Za-z]+)$/.exec(parts[0]!);
      const last = /^([A-Za-z]+)((?:[’'-][A-Za-z]+)*[^A-Za-z]*)$/.exec(parts[n - 1]!);
      if (!first || !last || !parts.slice(1, -1).every((t) => /^[A-Za-z]+$/.test(t))) continue;
      const core = [first[2]!, ...parts.slice(1, -1), last[1]!];
      const word = core.join("");
      if (!vocab.has(word.toLowerCase()) || core.every((c) => c.length > 1 && isWord(c))) continue;
      out.push(`${first[1]}${word}${last[2]}`);
      i += n;
      merged = true;
      break;
    }
    if (!merged) {
      out.push(toks[i]!);
      i += 1;
    }
  }
  return out.join(" ");
}

function repairPages(pages: string[]): string[] {
  if (!pages.some((p) => DAMAGE.test(p))) return pages;
  const vocab = vocabulary(pages);
  return pages.map((p) => (DAMAGE.test(p) ? p.split("\n").map((l) => repairLine(l, vocab)).join("\n") : p));
}

export function parseNgss(pages: string[]): NgssEntry[] {
  const lines = repairPages(pages).join("\n").split("\n");
  const found = new Map<string, NgssEntry>();
  for (let i = 0; i < lines.length; i += 1) {
    const m = NGSS_CODE.exec(lines[i]!);
    if (!m) continue;
    let j = i + 1;
    while (j < lines.length && !NGSS_CODE.test(lines[j]!)) j += 1;
    const entry = ordered(parseOne(m[1]!, lines[i]!.slice(m[0].length), lines.slice(i + 1, j)));
    const have = found.get(entry.code);
    if (have && JSON.stringify(have) !== JSON.stringify(entry)) {
      throw new Error(`NGSS ${entry.code} appears twice with different text`);
    }
    found.set(entry.code, entry);
  }
  return [...found.values()].sort((a, b) => a.code.localeCompare(b.code, "en", { numeric: true }));
}

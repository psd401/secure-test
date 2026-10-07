// FB slice 4 (docs/fill-in-blank-design.md, D-3 / D-9): a fill-in-the-blank
// proposal from a model — the PDF importer or Generate questions — before
// CreateItemBody (the one write-shape authority) judges it.
//
// The model is asked for what it can write reliably: blank ids as plain
// `b1…`, a dropdown's options as TEXT strings, its answer as the correct
// option's TEXT (`correct_option`), and a typed blank's accepted answers as
// `keys`. Option ids are the server's job (o1…, like match pair ids, E1), so
// a half-numbered list cannot collide and the key is matched by text. Pure
// and client-safe: no server imports.

import { fillBlankMarkerIds } from "@secure-test/schema";
import { orderBlanksByStem } from "@/lib/items/fillBlankEditor";

const BLANK_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
/** A printed answer line: three or more underscores. */
export const UNDERSCORE_RUN_RE = /_{3,}/g;

/** Mirrors lib/api/items.ts (slice 1's caps). */
const MAX_OPTIONS = 12;
const MAX_KEYS = 10;

function str(v: unknown): string | null {
  return typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : null;
}

function asKeyList(v: unknown): string[] {
  const list = Array.isArray(v) ? v : v === undefined || v === null ? [] : [v];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const k of list) {
    const s = str(k);
    if (!s) continue;
    const folded = s.toLowerCase();
    if (seen.has(folded)) continue;
    seen.add(folded);
    out.push(s);
  }
  return out.slice(0, MAX_KEYS);
}

/** One raw blank → the write shape, as far as it can be read. */
function normalizeBlank(raw: unknown, index: number, fallbackKey: string[]): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const b = raw as Record<string, unknown>;
  const rawId = str(b.id);
  const id = rawId && BLANK_ID_RE.test(rawId) ? rawId : `b${index + 1}`;
  const rawOptions = Array.isArray(b.options) ? b.options : [];
  const isDropdown = b.kind === "dropdown" || (b.kind !== "text" && rawOptions.length > 0);
  if (isDropdown) {
    // Options as text (or {id?, text}); duplicates by text drop (a student
    // cannot tell two equal choices apart). The model's own ids are kept
    // only to find its key, then replaced by o1…
    const options: { id: string; text: string }[] = [];
    const byOwnId = new Map<string, string>();
    const seen = new Set<string>();
    for (const o of rawOptions) {
      const text = o && typeof o === "object" ? str((o as { text?: unknown }).text) : str(o);
      if (!text) continue;
      const folded = text.toLowerCase();
      if (seen.has(folded)) continue;
      seen.add(folded);
      const newId = `o${options.length + 1}`;
      options.push({ id: newId, text });
      const ownId = o && typeof o === "object" ? str((o as { id?: unknown }).id) : null;
      if (ownId) byOwnId.set(ownId, newId);
    }
    const capped = options.slice(0, MAX_OPTIONS);
    // The key by text first (what the prompt asks for), then by the model's
    // own option id. No match → no key: the card shows "Needs answer key"
    // rather than a guess.
    const keyText = str(b.correct_option ?? b.correct ?? b.answer);
    let correct: string | undefined;
    if (keyText) {
      correct = capped.find((o) => o.text.toLowerCase() === keyText.toLowerCase())?.id;
    }
    if (!correct) {
      const ownKey = str(b.correct_option_id);
      const mapped = ownKey ? byOwnId.get(ownKey) : undefined;
      if (mapped && capped.some((o) => o.id === mapped)) correct = mapped;
    }
    return { id, kind: "dropdown", options: capped, ...(correct ? { correct_option_id: correct } : {}) };
  }
  let keys = asKeyList(b.keys ?? b.key ?? b.answers ?? b.answer ?? b.correct_answer);
  if (keys.length === 0 && fallbackKey.length > 0) keys = fallbackKey;
  return {
    id,
    kind: "text",
    ...(keys.length > 0 ? { keys } : {}),
    ...(typeof b.exact_form === "boolean" ? { exact_form: b.exact_form } : {}),
  };
}

/**
 * A raw `fill_blank` proposal → the write shape. Blanks become
 * `{id, kind:"dropdown", options:[{id:"o1",text}], correct_option_id?}` or
 * `{id, kind:"text", keys?, exact_form?}`; a stem that still carries `____`
 * lines and no markers gets a marker per line, in order, when the counts
 * match; blanks are put in stem order ("Blank n" everywhere is the n-th
 * marker); a `correct_answer` string becomes the key of a lone typed blank
 * and is removed (the type takes none). Anything else is left for
 * CreateItemBody to refuse with its own message.
 */
export function normalizeFillBlankProposal(cand: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(cand.blanks)) return cand;
  const rawBlanks = cand.blanks as unknown[];
  const { correct_answer: rawAnswer, ...rest } = cand;
  const fallback = rawBlanks.length === 1 ? asKeyList(rawAnswer) : [];
  const blanks = rawBlanks.map((b, i) => normalizeBlank(b, i, fallback));
  let stem = rest.stem;
  if (typeof stem === "string" && fillBlankMarkerIds(stem).length === 0) {
    const runs = stem.match(UNDERSCORE_RUN_RE) ?? [];
    const ids = blanks.map((b) => (b && typeof b === "object" ? (b as { id?: unknown }).id : null));
    if (runs.length > 0 && runs.length === blanks.length && ids.every((x) => typeof x === "string")) {
      let n = 0;
      stem = stem.replace(UNDERSCORE_RUN_RE, () => `[[${ids[n++] as string}]]`);
    }
  }
  const ordered =
    typeof stem === "string" && blanks.every((b) => b && typeof b === "object" && typeof (b as { id?: unknown }).id === "string")
      ? orderBlanksByStem(stem, blanks as { id: string }[])
      : blanks;
  return { ...rest, ...(stem !== undefined ? { stem } : {}), blanks: ordered };
}

/** Every blank of a normalized proposal carries a key (D-9: a generated item always has one). */
export function everyBlankKeyed(cand: Record<string, unknown>): boolean {
  const blanks = cand.blanks;
  if (!Array.isArray(blanks) || blanks.length === 0) return false;
  return blanks.every((b) => {
    if (!b || typeof b !== "object") return false;
    const blank = b as { kind?: unknown; correct_option_id?: unknown; keys?: unknown };
    return blank.kind === "dropdown"
      ? typeof blank.correct_option_id === "string"
      : Array.isArray(blank.keys) && blank.keys.length > 0;
  });
}

/**
 * The marker ids that sit inside `$…$` math — an odd number of unescaped `$`
 * before them. The preview, print and client split the stem at its markers
 * (FB slice 1's documented limit), so a marker inside math leaves both halves
 * as raw `$`. Generate questions drops such an element (its prompt says
 * never); a PDF candidate is left for the teacher to fix in the editor.
 */
export function markersInsideMath(stem: string): string[] {
  const out: string[] = [];
  let dollars = 0;
  let i = 0;
  while (i < stem.length) {
    const ch = stem[i]!;
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "$") dollars++;
    if (ch === "[" && stem[i + 1] === "[") {
      const m = /^\[\[([A-Za-z0-9_-]{1,40})\]\]/.exec(stem.slice(i));
      if (m) {
        if (dollars % 2 === 1) out.push(m[1]!);
        i += m[0].length;
        continue;
      }
    }
    i++;
  }
  return out;
}

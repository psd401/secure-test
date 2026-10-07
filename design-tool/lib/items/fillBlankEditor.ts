// FB slice 2 (docs/fill-in-blank-design.md): the pure logic behind the
// fill-in-the-blank editor form (app/dashboard/[id]/FillBlankEditor.tsx). The
// repo has no DOM harness, so everything a click decides lives here and is
// unit-tested (test/fill-blank-editor.test.ts); the component only wires it.
//
// The stem holds `[[<id>]]` markers and `blanks` holds one entry per marker
// (slice 1's write boundary refuses anything else). Ids are generated here
// and never typed by the teacher. "Blank n" is the blank's position in the
// `blanks` array everywhere a teacher reads it (instant feedback, results,
// the queue — slice 1), so the editor keeps that array in STEM order: the
// numbering the teacher sees in the form matches what students and reports
// show.

import {
  fillBlankMarkerIds,
  type FillBlankBlank,
  type FillBlankDropdown,
  type FillBlankText,
} from "@secure-test/schema";

/** Mirrors lib/api/items.ts (slice 1's caps). */
export const MAX_BLANKS = 20;
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 12;
export const MAX_KEYS = 10;

/** The text the Add button seeds; readiness flags it until edited (SEED_TEXT). */
export const FILL_BLANK_SEED_STEM = "New sentence with a [[b1]].";

export function marker(id: string): string {
  return `[[${id}]]`;
}

/**
 * FB slice 4: a read-only card's sentence (PDF import, Generate questions)
 * with each `[[id]]` marker shown as a gap, for display only — the stored
 * stem keeps its markers. `numbered` puts "(n)" after each gap, n = the
 * marker's position, so the card's key lines ("Blank n: …") line up; a
 * repeated marker gets the number of its first appearance.
 */
export function stemWithGaps(stem: string, opts: { numbered?: boolean } = {}): string {
  const order = new Map<string, number>();
  return stem.replace(/\[\[([A-Za-z0-9_-]{1,40})\]\]/g, (_m, id: string) => {
    if (!order.has(id)) order.set(id, order.size + 1);
    return opts.numbered ? `____ (${order.get(id)})` : "____";
  });
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The next generated blank id: `b<n>` with n one past the highest number in
 * use by a blank OR a marker still in the stem. Never the lowest free number:
 * a removed `b1` is not handed out again, so an id an earlier attempt's
 * responses used (a test unpublished and edited) never comes back naming a
 * different blank.
 */
export function nextBlankId(stem: string, blanks: readonly { id: string }[]): string {
  let max = 0;
  for (const id of [...blanks.map((b) => b.id), ...fillBlankMarkerIds(stem)]) {
    const m = /^b(\d+)$/.exec(id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `b${max + 1}`;
}

/** Next option id for a dropdown: o1, o2, … (first number not taken). */
export function nextOptionId(options: readonly { id: string }[]): string {
  const ids = new Set(options.map((o) => o.id));
  let n = options.length + 1;
  while (ids.has(`o${n}`)) n += 1;
  return `o${n}`;
}

/**
 * Put `blanks` in the order their markers first appear in the stem. A blank
 * whose marker is gone keeps its relative order at the end — it is not
 * dropped (the editor shows it as "not in the question" with Put back /
 * Remove), so deleting a marker by accident never deletes the answer key.
 */
export function orderBlanksByStem<T extends { id: string }>(stem: string, blanks: readonly T[]): T[] {
  const firstAt = new Map<string, number>();
  fillBlankMarkerIds(stem).forEach((id, i) => {
    if (!firstAt.has(id)) firstAt.set(id, i);
  });
  const placed = blanks.filter((b) => firstAt.has(b.id));
  placed.sort((a, b) => firstAt.get(a.id)! - firstAt.get(b.id)!);
  const orphans = blanks.filter((b) => !firstAt.has(b.id));
  return [...placed, ...orphans];
}

export interface InsertResult {
  stem: string;
  blanks: FillBlankBlank[];
  /** Where the caret goes: just after the inserted marker. */
  caret: number;
}

/**
 * "Insert blank": put a new marker at [start, end) of the stem and add its
 * blank (typed by default). Selected text is replaced by the marker and
 * becomes the typed blank's first accepted answer — select "leeward", press
 * Insert blank, and the blank's key is already there. A space is added on a
 * side whose neighbour is a word character so the marker never glues to a word.
 */
export function insertBlankAt(
  stem: string,
  blanks: readonly FillBlankBlank[],
  start: number,
  end: number,
): InsertResult {
  const s = Math.max(0, Math.min(start, stem.length));
  const e = Math.max(s, Math.min(end, stem.length));
  const id = nextBlankId(stem, blanks);
  const selected = stem.slice(s, e).trim();
  const before = stem.slice(0, s);
  const after = stem.slice(e);
  const padL = /\w$/.test(before) ? " " : "";
  const padR = /^\w/.test(after) ? " " : "";
  const inserted = `${padL}${marker(id)}${padR}`;
  const nextStem = `${before}${inserted}${after}`;
  const blank: FillBlankText = selected ? { id, kind: "text", keys: [selected] } : { id, kind: "text" };
  return {
    stem: nextStem,
    blanks: orderBlanksByStem(nextStem, [...blanks, blank]),
    caret: before.length + padL.length + marker(id).length,
  };
}

/**
 * Delete every `[[id]]` from the stem, tidying the space the marker leaves:
 * "the [[b1]] side" → "the side", "[[b1]] side" → "side", "the [[b1]]." →
 * "the.".
 */
export function removeMarker(stem: string, id: string): string {
  const re = new RegExp(`( ?)${escapeRe(marker(id))}( ?)`, "g");
  // Keep one space only when the marker sat between two spaces.
  return stem.replace(re, (_m, l: string, r: string) => (l && r ? " " : ""));
}

/** Remove a blank: its entry AND its marker(s), so nothing orphaned is left behind. */
export function removeBlank(
  stem: string,
  blanks: readonly FillBlankBlank[],
  id: string,
): { stem: string; blanks: FillBlankBlank[] } {
  return { stem: removeMarker(stem, id), blanks: blanks.filter((b) => b.id !== id) };
}

/** "Put it back": a blank whose marker was deleted gets it appended to the stem. */
export function restoreMarker(
  stem: string,
  blanks: readonly FillBlankBlank[],
  id: string,
): { stem: string; blanks: FillBlankBlank[] } {
  const sep = stem.length === 0 || /\s$/.test(stem) ? "" : " ";
  const next = `${stem}${sep}${marker(id)}`;
  return { stem: next, blanks: orderBlanksByStem(next, blanks) };
}

/** A marker the teacher typed (or left behind) that names no blank: add a typed blank for it. */
export function addBlankForMarker(
  stem: string,
  blanks: readonly FillBlankBlank[],
  id: string,
): FillBlankBlank[] {
  if (blanks.some((b) => b.id === id)) return [...blanks];
  return orderBlanksByStem(stem, [...blanks, { id, kind: "text" }]);
}

/** Markers in the stem that name no blank, once each, in stem order. */
export function orphanMarkers(stem: string, blanks: readonly { id: string }[]): string[] {
  const ids = new Set(blanks.map((b) => b.id));
  return [...new Set(fillBlankMarkerIds(stem))].filter((id) => !ids.has(id));
}

/** Markers that appear more than once in the stem, once each. */
export function duplicateMarkers(stem: string): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const id of fillBlankMarkerIds(stem)) {
    if (seen.has(id)) dup.add(id);
    seen.add(id);
  }
  return [...dup];
}

export function isInStem(stem: string, id: string): boolean {
  return fillBlankMarkerIds(stem).includes(id);
}

function emptyDropdown(id: string): FillBlankDropdown {
  return { id, kind: "dropdown", options: [{ id: "o1", text: "" }, { id: "o2", text: "" }] };
}

/**
 * Switch a blank's kind, carrying the answer across instead of discarding it:
 * dropdown → typed keeps the correct option's text as the accepted answer;
 * typed → dropdown makes each accepted answer an option (padded to two) with
 * the first one correct. A dropdown's other (wrong) options are not kept.
 */
export function setBlankKind(blank: FillBlankBlank, kind: FillBlankBlank["kind"]): FillBlankBlank {
  if (blank.kind === kind) return blank;
  if (kind === "text") {
    const d = blank as FillBlankDropdown;
    const correct = d.options.find((o) => o.id === d.correct_option_id)?.text.trim();
    return correct ? { id: blank.id, kind: "text", keys: [correct] } : { id: blank.id, kind: "text" };
  }
  const keys = ((blank as FillBlankText).keys ?? []).map((k) => k.trim()).filter((k) => k.length > 0);
  if (keys.length === 0) return emptyDropdown(blank.id);
  const options = keys.slice(0, MAX_OPTIONS).map((text, i) => ({ id: `o${i + 1}`, text }));
  while (options.length < MIN_OPTIONS) options.push({ id: nextOptionId(options), text: "" });
  return { id: blank.id, kind: "dropdown", options, correct_option_id: "o1" };
}

/**
 * "Same options as blank n": the target takes a copy of the source's options
 * (same ids and text, the source's order — D-6). The target's own correct
 * answer is kept when an option with the same text exists in the copy;
 * otherwise it is cleared (each blank has its own answer — the source's is
 * never copied).
 */
export function copyOptionsFrom(target: FillBlankDropdown, source: FillBlankDropdown): FillBlankDropdown {
  const options = source.options.map((o) => ({ ...o }));
  const wasText = target.options.find((o) => o.id === target.correct_option_id)?.text.trim();
  const match = wasText ? options.find((o) => o.text.trim() === wasText) : undefined;
  const out: FillBlankDropdown = { id: target.id, kind: "dropdown", options };
  if (match) out.correct_option_id = match.id;
  return out;
}

/** Does this blank carry a key as it will be SAVED (blank keys dropped)? */
export function hasBlankKey(blank: FillBlankBlank): boolean {
  if (blank.kind === "dropdown") return blank.correct_option_id != null;
  return (blank.keys ?? []).some((k) => k.trim().length > 0);
}

/** E3-F1, as for tables: no keyed blank → the unset scoring method is human. */
export function hasKeyedBlank(blanks: readonly FillBlankBlank[] | null): boolean {
  return (blanks ?? []).some(hasBlankKey);
}

/** The live line under the blank list (the table's "n cells checked" pattern, E3-F1). */
export function blankCountLine(blanks: readonly FillBlankBlank[], handScored = false): string {
  // FB-R3: method Human — the teacher scores every blank, one point each.
  if (handScored) {
    return `Scored by hand: ${blanks.length} blank${blanks.length === 1 ? "" : "s"}, one point each`;
  }
  const keyed = blanks.filter(hasBlankKey).length;
  if (keyed === 0) {
    return "No blank has an answer yet, so this question is hand-scored until you add some";
  }
  const head = `${keyed} blank${keyed === 1 ? "" : "s"} checked, one point each`;
  return keyed < blanks.length ? `${head}; a blank with no answer is not scored` : head;
}

/**
 * The `blanks` a save sends: stem order, keys only when set (a null correct
 * option, blank accepted answers and a false `exact_form` are the absence of
 * the field — the convention slice 1's compactBlanks stores).
 */
export function blanksForSave(stem: string, blanks: readonly FillBlankBlank[]): FillBlankBlank[] {
  return orderBlanksByStem(stem, blanks).map((b): FillBlankBlank => {
    if (b.kind === "dropdown") {
      const out: FillBlankDropdown = { id: b.id, kind: "dropdown", options: b.options };
      if (b.correct_option_id != null) out.correct_option_id = b.correct_option_id;
      return out;
    }
    const out: FillBlankText = { id: b.id, kind: "text" };
    const keys = (b.keys ?? []).filter((k) => k.trim().length > 0);
    if (keys.length > 0) out.keys = keys;
    if (b.exact_form) out.exact_form = true;
    return out;
  });
}

/**
 * The publish lock (lib/api/requireDraft.ts withoutBlankKeys): on a
 * published test only a blank's key (`correct_option_id`, `keys`) may
 * change. The editor compares blanks with those removed to decide whether
 * Save may light up.
 */
export function blanksWithoutKeys(blanks: readonly FillBlankBlank[] | null): unknown[] {
  return (blanks ?? []).map((b) => {
    const { correct_option_id: _o, keys: _k, ...rest } = b as FillBlankBlank & {
      correct_option_id?: string;
      keys?: string[];
    };
    if (rest.kind === "text" && !(rest as { exact_form?: boolean }).exact_form) {
      delete (rest as { exact_form?: boolean }).exact_form;
    }
    return rest;
  });
}

/**
 * Slice 1's write-boundary messages ("blank "b2" has no [[b2]] marker in the
 * stem", "a dropdown blank needs at least 2 options", …) arrive as the 400's
 * `detail` — a ZodError's JSON issue list. Pick out the blank-related ones so
 * the card can say what is wrong instead of only "isn't complete yet".
 */
export function fillBlankIssueMessages(detail: string | undefined): string[] {
  if (!detail) return [];
  let issues: unknown;
  try {
    issues = JSON.parse(detail);
  } catch {
    return [];
  }
  if (!Array.isArray(issues)) return [];
  const out: string[] = [];
  for (const iss of issues) {
    const message = (iss as { message?: unknown }).message;
    if (typeof message === "string" && /blank|dropdown/i.test(message) && !out.includes(message)) {
      out.push(message);
    }
  }
  return out;
}

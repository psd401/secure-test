// Class insights slice 4 (docs/class-insights-design.md, D-1 / D-4 / D-5 /
// D-6): the chat's pure half — everything the route does to a teacher's
// message, the thread's pseudonyms, the evidence pack and the pulled answers
// before a model sees them. No database, no provider: the tests prove the
// rules with plain objects.
//
//   - `extendPseudonyms` keeps the THREAD's S-numbering stable: the pack
//     numbers students by attempt-id order, so a new student shifts every
//     later S-number; the thread keeps the number it first gave an attempt
//     and gives a new attempt the next free one. `relabelPack` rewrites the
//     pack into the thread's numbering so history, pack and reply agree.
//   - `pseudonymize` takes every in-scope display name out of a text (D-1):
//     full names case-insensitively on word boundaries, longest first; a first
//     name alone only when no other student in scope shares it.
//   - `selectAnswers` is D-6's on-demand pull: only when the message names an
//     essay or short-text question, narrowed to the students it names, never
//     an answer with an OPEN safeguarding alert, names inside the answers
//     replaced, ≤ 300 words in all, shared fairly.

import { GONE_STUDENT } from "./reportView";
import type { ClassInsightsPackInput, FilledClaim } from "./report";
import { REPORT_SECTION_TITLES, REPORT_SECTIONS, type ClassInsightsReport } from "./report";

/** 40 TOTAL turns (teacher + assistant counted separately) = 20 exchanges. */
export const MAX_THREAD_TURNS = 40;
/** Turns of history re-sent with each call. */
export const HISTORY_TURNS = 12;
export const MAX_MESSAGE_CHARS = 1000;
export const MAX_REPLY_CHARS = 1500;
/** D-6: words of students' writing one turn may read, across every answer. */
export const ANSWER_WORD_CAP = 300;
export const TRUNCATION_MARK = "[…]";

const PULLABLE_TYPES = new Set(["essay", "short_text"]);

// ---------------------------------------------------------------------------
// Thread pseudonyms

export interface ExtendedPseudonyms {
  /** The thread's full map after this turn: `S<n>` → attempt id. */
  pseudonyms: Record<string, string>;
  /** The pack's label → the thread's label, for every student in the pack. */
  packToThread: Map<string, string>;
  /** Thread label → display name, for every student in the CURRENT pack. */
  namesByThread: Array<{ label: string; name: string }>;
}

function labelNumber(label: string): number {
  return Number(label.slice(1));
}

export function extendPseudonyms(
  thread: Record<string, string>,
  packNames: Record<string, { attempt_id: string; display_name: string }>,
): ExtendedPseudonyms {
  const pseudonyms = { ...thread };
  const byAttempt = new Map(Object.entries(thread).map(([label, attempt]) => [attempt, label]));
  let next = Math.max(0, ...Object.keys(thread).map(labelNumber)) + 1;
  const packToThread = new Map<string, string>();
  const namesByThread: ExtendedPseudonyms["namesByThread"] = [];
  const packLabels = Object.keys(packNames).sort((a, b) => labelNumber(a) - labelNumber(b));
  for (const packLabel of packLabels) {
    const { attempt_id, display_name } = packNames[packLabel]!;
    let label = byAttempt.get(attempt_id);
    if (!label) {
      label = `S${next++}`;
      pseudonyms[label] = attempt_id;
      byAttempt.set(attempt_id, label);
    }
    packToThread.set(packLabel, label);
    namesByThread.push({ label, name: display_name });
  }
  return { pseudonyms, packToThread, namesByThread };
}

/** The pack in the thread's numbering: student ids and `student.S<n>.*` keys. */
export function relabelPack(
  pack: ClassInsightsPackInput,
  packToThread: ReadonlyMap<string, string>,
): ClassInsightsPackInput {
  const map = (label: string) => packToThread.get(label) ?? label;
  const figures: Record<string, number> = {};
  for (const [key, value] of Object.entries(pack.figures)) {
    const m = /^student\.(S\d+)\.(.*)$/.exec(key);
    figures[m ? `student.${map(m[1]!)}.${m[2]}` : key] = value;
  }
  return {
    ...pack,
    students: pack.students.map((s) => ({ ...s, id: map(s.id) })),
    figures,
  };
}

// ---------------------------------------------------------------------------
// Names out (D-1)

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function fold(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Display names that are not a name at all. */
const NOT_A_NAME = new Set(["(unknown)"]);

/** A display name's spellings: as stored, and "First Last" for "Last, First". */
function nameVariants(name: string): { full: string[]; first: string | null } {
  const n = name.replace(/\s+/g, " ").trim();
  if (!n || NOT_A_NAME.has(n.toLowerCase())) return { full: [], first: null };
  const comma = /^([^,]+),\s*(.+)$/.exec(n);
  if (comma) {
    const last = comma[1]!.trim();
    const given = comma[2]!.trim();
    return { full: [n, `${given} ${last}`], first: given.split(" ")[0] ?? null };
  }
  return { full: [n], first: n.split(" ")[0] ?? null };
}

export interface Pseudonymizer {
  /** `markers`: write `[[S4]]` (a stored teacher turn) instead of `S4`. */
  apply(text: string, opts?: { markers?: boolean }): string;
}

/**
 * Build once per turn from the CURRENT pack's names in thread numbering.
 * A full name shared by two students becomes "S3 or S7"; a first name shared
 * by two is left alone (it identifies nobody in scope). Case-insensitive on
 * both — over-matching a first name that is also a word ("Will") costs a
 * garbled sentence, under-matching sends a name.
 */
export function buildPseudonymizer(names: Array<{ label: string; name: string }>): Pseudonymizer {
  const full = new Map<string, Set<string>>();
  const firstCount = new Map<string, Set<string>>();
  for (const { label, name } of names) {
    const v = nameVariants(name);
    for (const f of v.full) {
      const key = fold(f);
      if (!full.has(key)) full.set(key, new Set());
      full.get(key)!.add(label);
    }
    if (v.first && v.first.length >= 2) {
      const key = fold(v.first);
      if (!firstCount.has(key)) firstCount.set(key, new Set());
      firstCount.get(key)!.add(label);
    }
  }
  const lookup = new Map<string, string[]>();
  for (const [key, labels] of full) lookup.set(key, [...labels]);
  for (const [key, labels] of firstCount) {
    if (labels.size === 1 && !lookup.has(key)) lookup.set(key, [...labels]);
  }
  const patterns = [...lookup.keys()]
    .sort((a, b) => b.length - a.length)
    .map((k) => k.split(" ").map(escapeRegExp).join("\\s+"));
  const re =
    patterns.length > 0
      ? new RegExp(`(?<![\\p{L}\\p{N}_])(?:${patterns.join("|")})(?![\\p{L}\\p{N}_])`, "giu")
      : null;

  return {
    apply(text, opts = {}) {
      if (!re) return text;
      return text.replace(re, (match) => {
        const labels = (lookup.get(fold(match)) ?? []).sort(
          (a, b) => labelNumber(a) - labelNumber(b),
        );
        const shown = labels.map((l) => (opts.markers ? `[[${l}]]` : l));
        return shown.length === 0 ? match : shown.join(" or ");
      });
    },
  };
}

/**
 * The teacher's message as it is stored and sent: marker-shaped brackets the
 * teacher typed are flattened (the markers are ours), then names out.
 */
export function pseudonymizeMessage(
  message: string,
  p: Pseudonymizer,
): { stored: string; plain: string } {
  const flattened = message.trim().replace(/\[\[/g, "[").replace(/\]\]/g, "]");
  const stored = p.apply(flattened, { markers: true });
  return { stored, plain: plainLabels(stored) };
}

/** `[[S4]]` → `S4`. */
export function plainLabels(text: string): string {
  return text.replace(/\[\[([QS]\d+)\]\]/g, "$1");
}

// ---------------------------------------------------------------------------
// What a message mentions

/** Q labels the message names — `Q4`, `q4`, "question 4" — that the pack has. */
export function mentionedQuestions(message: string, pack: ClassInsightsPackInput): string[] {
  const known = new Set(pack.assessment.items.map((i) => i.label));
  const out = new Set<string>();
  for (const m of message.matchAll(/\b(?:q\s?|question\s+)(\d+)\b/gi)) {
    const label = `Q${Number(m[1])}`;
    if (known.has(label)) out.add(label);
  }
  return [...out].sort((a, b) => labelNumber(a) - labelNumber(b));
}

/** S labels in the (pseudonymized) message that are students in the pack. */
export function mentionedStudents(message: string, pack: ClassInsightsPackInput): string[] {
  const known = new Set(pack.students.map((s) => s.id));
  const out = new Set<string>();
  for (const m of message.matchAll(/\bS(\d+)\b/g)) {
    const label = `S${Number(m[1])}`;
    if (known.has(label)) out.add(label);
  }
  return [...out].sort((a, b) => labelNumber(a) - labelNumber(b));
}

/** The essay / short-text questions among `labels` — the only ones D-6 pulls. */
export function pullableQuestions(labels: string[], pack: ClassInsightsPackInput): string[] {
  const type = new Map(pack.assessment.items.map((i) => [i.label, i.type]));
  return labels.filter((l) => PULLABLE_TYPES.has(type.get(l) ?? ""));
}

// ---------------------------------------------------------------------------
// The answer pull (D-6)

export interface AnswerCandidate {
  response_id: string;
  question: string;
  /** Thread label. */
  student: string;
  text: string;
  open_alert: boolean;
}

export interface PulledAnswer {
  response_id: string;
  question: string;
  student: string;
  text: string;
  truncated: boolean;
}

function words(text: string): string[] {
  return text.split(/\s+/).filter((w) => w.length > 0);
}

/**
 * Fair shares of `cap` words: answers shorter than an equal share keep every
 * word and give the rest back; the longer ones split what is left. An answer
 * whose share is zero (more answers than words) is left out entirely.
 */
export function shareWords(lengths: number[], cap: number): number[] {
  const allot = lengths.map(() => 0);
  const order = lengths.map((len, i) => ({ len, i })).sort((a, b) => a.len - b.len || a.i - b.i);
  let remaining = cap;
  for (let k = 0; k < order.length; k++) {
    const left = order.length - k;
    const share = Math.floor(remaining / left);
    const { len, i } = order[k]!;
    allot[i] = Math.min(len, share);
    remaining -= allot[i]!;
  }
  return allot;
}

export function selectAnswers(
  candidates: AnswerCandidate[],
  p: Pseudonymizer,
  cap = ANSWER_WORD_CAP,
): PulledAnswer[] {
  const usable = candidates
    .filter((c) => !c.open_alert)
    .map((c) => ({ ...c, words: words(p.apply(c.text)) }))
    .filter((c) => c.words.length > 0)
    .sort(
      (a, b) =>
        labelNumber(a.question) - labelNumber(b.question) ||
        labelNumber(a.student) - labelNumber(b.student),
    );
  const allot = shareWords(
    usable.map((c) => c.words.length),
    cap,
  );
  return usable.flatMap((c, i) => {
    const n = allot[i]!;
    if (n === 0) return [];
    const truncated = n < c.words.length;
    return [
      {
        response_id: c.response_id,
        question: c.question,
        student: c.student,
        text: c.words.slice(0, n).join(" ") + (truncated ? ` ${TRUNCATION_MARK}` : ""),
        truncated,
      },
    ];
  });
}

/** A student's writing cannot close the block it is quoted in. */
export function neutraliseAnswersTag(text: string): string {
  return text.replace(/<\/student_answers/gi, "<\\/student_answers");
}

// ---------------------------------------------------------------------------
// The stored report, in the thread's numbering

export interface ReportForChat {
  claims: string[];
  /** The report was written from an earlier pack. */
  stale: boolean;
}

/**
 * The shared report's claims as plain lines in the THREAD's labels: its
 * `[[S4]]` → its attempt → the thread's label (else the gone-student
 * wording); its `[[Q3]]` → its item → the current label (else "a deleted
 * question"). No name ever enters.
 */
export function reportForChat(
  row: { report: ClassInsightsReport; pseudonyms: Record<string, string>; item_ids: Record<string, string> },
  threadPseudonyms: Record<string, string>,
  currentItems: Record<string, string>,
  stale: boolean,
): ReportForChat {
  const threadByAttempt = new Map(Object.entries(threadPseudonyms).map(([l, a]) => [a, l]));
  const labelByItem = new Map(Object.entries(currentItems).map(([l, id]) => [id, l]));
  const swap = (text: string) =>
    text.replace(/\[\[([QS]\d+)\]\]/g, (_, label: string) => {
      if (label.startsWith("S")) {
        const attempt = row.pseudonyms[label];
        return (attempt && threadByAttempt.get(attempt)) || GONE_STUDENT;
      }
      const item = row.item_ids[label];
      return (item && labelByItem.get(item)) || "a deleted question";
    });
  const claims = REPORT_SECTIONS.flatMap((section) =>
    (row.report[section] ?? []).map(
      (c: FilledClaim) => `${REPORT_SECTION_TITLES[section]}: ${swap(c.text)}`,
    ),
  );
  return { claims, stale };
}

// ---------------------------------------------------------------------------
// The provider's input

export interface ClassInsightsChatInput {
  /** The evidence pack, no hash, in the thread's numbering. */
  pack: ClassInsightsPackInput;
  /** The shared report for this section, or null when none is stored. */
  report: ReportForChat | null;
  /** The last HISTORY_TURNS turns, oldest first, labels plain. */
  history: Array<{ role: "teacher" | "assistant"; text: string }>;
  /** D-6: pulled answers; empty when the message asked for none. */
  answers: PulledAnswer[];
  /** The teacher's pseudonymized message, labels plain. */
  message: string;
}

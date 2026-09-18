// Slice 1 of docs/student-work-export-design.md: the rules behind the
// printable class packet (`/dashboard/[id]/results/work`), pulled out of the
// page so each one is testable on its own.
//
// Pure: query parameters, attempt ids, score rows and item/response shapes in
// — labels, orderings and selections out. Nothing here reads the database or
// renders anything; the page draws what these return.

import { UUID_RE } from "@/lib/uuid";

export const PACKET_SCORE_MODES = ["none", "teacher", "ai", "both"] as const;
export type PacketScoresMode = (typeof PACKET_SCORE_MODES)[number];

export interface PacketQuery {
  /** Required by the page: one PDF per class means one URL per section. */
  section: string | null;
  /** The item ids to include, in the caller's order; null = every item. */
  items: string[] | null;
  /** `questions=0` prints answers only. */
  questions: boolean;
  scores: PacketScoresMode;
  /** D-1: labels instead of names, with a teacher key page last. */
  anon: boolean;
}

type SearchParams = Record<string, string | string[] | undefined>;

/**
 * The LAST value wins, not the first — slice 2's toolbar relies on this: the
 * `questions` checkbox sits after a `questions=0` hidden field with the same
 * name, so an unchecked box still submits (the hidden field's `0`) and a
 * checked one overrides it (the checkbox's `1`, later in the form and so
 * later in the query string). A repeated parameter from anywhere else (a
 * hand-edited URL, a browser's history restore) resolves the same way.
 */
function lastParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value.length > 0 ? value[value.length - 1]! : null;
  return value ?? null;
}

function allValues(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) return value;
  return value === undefined ? [] : [value];
}

/** `0` / `false` / `no` are off; an absent parameter falls back to `fallback`. */
function flag(raw: string | null, fallback: boolean): boolean {
  if (raw === null) return fallback;
  const v = raw.trim().toLowerCase();
  if (v === "") return fallback;
  return !(v === "0" || v === "false" || v === "no");
}

/**
 * The packet's whole URL contract. Never throws and never 400s: a packet is a
 * link a teacher bookmarks and hand-edits, so an unreadable value falls back
 * to the documented default (an unknown `scores` becomes `none` — the safest
 * of the four) rather than taking the page down.
 */
export function parsePacketQuery(searchParams: SearchParams): PacketQuery {
  const rawSection = lastParam(searchParams.section);
  const section = rawSection && rawSection.trim() !== "" ? rawSection.trim() : null;

  // `items` is a comma list (a hand-edited or bookmarked URL) OR one value per
  // parameter (the toolbar's item checklist, one checkbox per question, all
  // named `items`) — every value is split on commas and merged, so both
  // shapes land the same set.
  const ids: string[] = [];
  for (const raw of allValues(searchParams.items)) {
    for (const part of raw.split(",")) {
      const id = part.trim().toLowerCase();
      if (UUID_RE.test(id) && !ids.includes(id)) ids.push(id);
    }
  }

  const rawScores = (lastParam(searchParams.scores) ?? "").trim().toLowerCase();
  const scores = (PACKET_SCORE_MODES as readonly string[]).includes(rawScores)
    ? (rawScores as PacketScoresMode)
    : "none";

  return {
    section,
    items: ids.length > 0 ? ids : null,
    questions: flag(lastParam(searchParams.questions), true),
    scores,
    anon: flag(lastParam(searchParams.anon), false),
  };
}

/**
 * The handful of LaTeX commands a stem is likely to carry, as the symbol a
 * checklist label should show (2026-09-14 hand-run: `\times` survived the
 * `$` strip as a bare backslash word). Any other `\command` is dropped and
 * braces go with it, so `\frac{1}{2}` reads `12` — an excerpt, not a render.
 */
const LATEX_EXCERPT_SYMBOLS: Record<string, string> = {
  "\\times": "×",
  "\\div": "÷",
  "\\cdot": "·",
  "\\pm": "±",
  "\\le": "≤",
  "\\leq": "≤",
  "\\ge": "≥",
  "\\geq": "≥",
  "\\ne": "≠",
  "\\neq": "≠",
  "\\pi": "π",
  "\\sqrt": "√",
  "\\degree": "°",
  "\\infty": "∞",
};

/**
 * A short, plain-text label for the toolbar's item checklist: strip image
 * refs, `$…$` math markers and the handful of markdown characters a stem may
 * carry, collapse whitespace, then cut to `max` characters. Never throws; a
 * blank stem gives `""`.
 */
export function stemExcerpt(stem: string, max = 60): string {
  const stripped = (stem ?? "")
    .replace(/!\[[^\]]*\]\(asset:[^)]*\)/gi, "")
    .replace(/\$\$?/g, "")
    .replace(/\\[a-zA-Z]+/g, (cmd) => LATEX_EXCERPT_SYMBOLS[cmd] ?? "")
    .replace(/[{}]/g, "")
    .replace(/[*_`#>[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (stripped.length <= max) return stripped;
  return `${stripped.slice(0, max - 1).trimEnd()}…`;
}

/**
 * D-1: `Student 01 … Student NN` for the section's handed-in attempts.
 *
 * The order is the attempt ids sorted lexically, which is stable across
 * re-prints of the same set of attempts and independent of names, sections and
 * hand-in times. A hand-in that arrives after a print shifts the labels — the
 * key page carries that caveat, because nothing here can prevent it.
 *
 * Width is the count's, floored at two, so a class of nine reads "Student 01"
 * and a class of a hundred and four reads "Student 001".
 */
export function anonymousLabels(attemptIds: string[]): Map<string, string> {
  const sorted = [...new Set(attemptIds)].sort();
  const width = Math.max(2, String(sorted.length).length);
  const labels = new Map<string, string>();
  sorted.forEach((id, i) => {
    labels.set(id, `Student ${String(i + 1).padStart(width, "0")}`);
  });
  return labels;
}

/** The structural part of a `scores` row this file reads. */
export interface PacketScoreRow {
  method: string;
  status: string;
  points: number;
  max_points: number;
  rationale: unknown;
  created_at: Date;
}

export interface PacketScores<T> {
  teacher: T | null;
  ai: T | null;
}

/**
 * Which two score rows a packet prints for one response.
 *
 * - **teacher** — the one `final` row whose method is the teacher's: `human`
 *   when they scored it, `auto` when their answer key did. Both are the
 *   teacher's judgement, so both print on the teacher side.
 * - **ai** — the LATEST `ai` row by `created_at`, whatever its status. A
 *   proposal the teacher has not reviewed yet is exactly the one they most
 *   want to annotate, so it prints, headed as a proposal (see
 *   `packetScoreHeading`).
 * - `research` rows (docs/scoring-corpus-design.md) are an operator's data
 *   set and never print. The page's query excludes them too; this is the
 *   second lock, so a future caller cannot leak one by forgetting the filter.
 * - `superseded` rows (docs/pass-back-design.md, D-2) never print either. They
 *   are the scores from BEFORE a pass back, kept as a record on the per-student
 *   page alone; a packet printed after a pass back is about the answers as they
 *   stand. Without this the `ai` branch below would happily pick a superseded
 *   AI final as the latest `ai` row and head it "AI proposal".
 */
export function selectPacketScores<T extends PacketScoreRow>(
  mode: PacketScoresMode,
  rowsForResponse: T[],
): PacketScores<T> {
  if (mode === "none") return { teacher: null, ai: null };
  let teacher: T | null = null;
  let ai: T | null = null;
  for (const row of rowsForResponse) {
    if (row.status === "research" || row.status === "superseded") continue;
    if (row.status === "final" && (row.method === "human" || row.method === "auto")) {
      teacher = row;
      continue;
    }
    if (row.method === "ai") {
      if (!ai || row.created_at >= ai.created_at) ai = row;
    }
  }
  return {
    teacher: mode === "ai" ? null : teacher,
    ai: mode === "teacher" ? null : ai,
  };
}

/**
 * The heading above a score block — including the empty case, so the page
 * never has to compose "No teacher score" itself.
 */
export function packetScoreHeading(
  kind: "teacher" | "ai",
  row: PacketScoreRow | null,
): string {
  if (kind === "teacher") {
    if (!row) return "No teacher score";
    return row.method === "auto" ? "Auto score (your answer key)" : "Teacher score";
  }
  if (!row) return "No AI score";
  return row.status === "final" ? "AI score (accepted)" : "AI proposal";
}

export interface ChoiceCheckboxLine {
  id: string;
  text: string;
  selected: boolean;
}

/**
 * Every choice of a multiple-choice item in the item's own order, each marked
 * selected or not — the request's "checkboxes for multiselect". The page draws
 * `☑` / `☐`; the key is never consulted, because a packet is a reading packet
 * and not an answer key.
 *
 * Returns [] for any other item type, and for an MC item with no choices.
 */
export function choiceCheckboxLines(
  item: { type: string; choices?: Array<{ id: string; text: string }> },
  response: Record<string, unknown> | null | undefined,
): ChoiceCheckboxLine[] {
  if (item.type !== "multiple_choice_single" && item.type !== "multiple_choice_multi") {
    return [];
  }
  const chosen = new Set<string>();
  if (response) {
    if (typeof response.choice_id === "string") chosen.add(response.choice_id);
    if (Array.isArray(response.choice_ids)) {
      for (const v of response.choice_ids) if (typeof v === "string") chosen.add(v);
    }
  }
  return (item.choices ?? []).map((c) => ({
    id: c.id,
    text: c.text,
    selected: chosen.has(c.id),
  }));
}

/**
 * "Fixture, Ada" and "Ada Fixture" both sort under F: a roster name arrives
 * "Last, First" and a hand-entered overlay name arrives "First Last", and a
 * teacher collating a stack expects one alphabet either way.
 */
function nameSortKey(name: string): [string, string] {
  const trimmed = (name ?? "").trim();
  if (trimmed === "") return ["", ""];
  const comma = trimmed.indexOf(",");
  if (comma !== -1) {
    return [
      trimmed.slice(0, comma).trim().toLowerCase(),
      trimmed.slice(comma + 1).trim().toLowerCase(),
    ];
  }
  const parts = trimmed.split(/\s+/);
  const last = parts.length > 1 ? parts[parts.length - 1]! : parts[0]!;
  const first = parts.length > 1 ? parts.slice(0, -1).join(" ") : "";
  return [last.toLowerCase(), first.toLowerCase()];
}

/**
 * The order the pages print in: by student last name, then first name, then
 * attempt id (named), or by attempt id (anonymous — which IS label order, so
 * a packet reads Student 01, 02, … down the stack).
 *
 * Returns a new array; the caller's is untouched.
 */
export function packetOrdering<T extends { attempt_id: string; student: { name: string } }>(
  rows: T[],
  anon: boolean,
): T[] {
  return [...rows].sort((a, b) => {
    if (!anon) {
      const ka = nameSortKey(a.student.name);
      const kb = nameSortKey(b.student.name);
      if (ka[0] !== kb[0]) return ka[0] < kb[0] ? -1 : 1;
      if (ka[1] !== kb[1]) return ka[1] < kb[1] ? -1 : 1;
    }
    return a.attempt_id < b.attempt_id ? -1 : a.attempt_id > b.attempt_id ? 1 : 0;
  });
}

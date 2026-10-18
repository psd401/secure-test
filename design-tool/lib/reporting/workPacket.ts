// Slice 1 of docs/student-work-export-design.md: the rules behind the
// printable class packet (`/dashboard/[id]/results/work`), pulled out of the
// page so each one is testable on its own.
//
// Pure: query parameters, attempt ids, score rows and item/response shapes in
// — labels, orderings and selections out. Nothing here reads the database or
// renders anything; the page draws what these return.

import { UUID_RE } from "@/lib/uuid";
import { FILL_BLANK_MARKER_RE } from "@secure-test/schema";

export const PACKET_SCORE_MODES = ["none", "teacher", "ai", "both"] as const;
export type PacketScoresMode = (typeof PACKET_SCORE_MODES)[number];

export interface PacketQuery {
  /**
   * Batch print (docs/batch-print-design.md, D-1): the sections to print, one
   * `section` parameter each, trimmed, blanks and repeats dropped, in URL
   * order (the packet sorts them, 8.2). Empty with no attempts = the chooser.
   */
  sections: string[];
  /**
   * Chosen students, one `attempt` parameter each, lower-cased uuids (a
   * non-uuid is dropped). One attempt alone is "one student's work"
   * (pilot-teacher request, 2026-09-23); several print together. A chosen
   * student prints whether or not they have handed in (8.1).
   */
  attempts: string[];
  /**
   * D-3: `in_progress=1` adds the work not yet handed in to a SECTION's run,
   * with the in-progress mark. Off by default. Chosen students ignore it.
   */
  inProgress: boolean;
  /** The item ids to include, in the caller's order; null = every item. */
  items: string[] | null;
  /** `questions=0` prints answers only. */
  questions: boolean;
  scores: PacketScoresMode;
  /** D-1: labels instead of names, with a teacher key page last. */
  anon: boolean;
  /**
   * RT D-10 (docs/rich-text-essay-design.md): `spacing=double` prints every
   * essay answer double-spaced, formatted or not. A teacher-side display
   * choice, default off (single); any other value is single.
   */
  doubleSpace: boolean;
  /**
   * U-23 (beta teachers, 2026-10-13): `answers=0` leaves out what the student
   * wrote or chose, keeping the question and the score / feedback blocks — a
   * feedback sheet to hand back. Default on. Read it through
   * `packetHidesAnswers`, never directly: with `scores=none` it is ignored.
   */
  answers: boolean;
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
  const sections: string[] = [];
  for (const raw of allValues(searchParams.section)) {
    const label = raw.trim();
    if (label !== "" && !sections.includes(label)) sections.push(label);
  }

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

  // A non-uuid `attempt` is the same as none, by the rule above; the
  // toolbar's "Everyone in this section" option submits it blank.
  const attempts: string[] = [];
  for (const raw of allValues(searchParams.attempt)) {
    const id = raw.trim().toLowerCase();
    if (UUID_RE.test(id) && !attempts.includes(id)) attempts.push(id);
  }

  const rawScores = (lastParam(searchParams.scores) ?? "").trim().toLowerCase();
  const scores = (PACKET_SCORE_MODES as readonly string[]).includes(rawScores)
    ? (rawScores as PacketScoresMode)
    : "none";

  return {
    sections,
    attempts,
    inProgress: flag(lastParam(searchParams.in_progress), false),
    items: ids.length > 0 ? ids : null,
    questions: flag(lastParam(searchParams.questions), true),
    scores,
    anon: flag(lastParam(searchParams.anon), false),
    doubleSpace: (lastParam(searchParams.spacing) ?? "").trim().toLowerCase() === "double",
    answers: flag(lastParam(searchParams.answers), true),
  };
}

/**
 * U-23 decision 1.5: answers are left out only when a score side prints —
 * `answers=0` with `scores=none` would print question numbers and nothing
 * else, so the answers print as usual and the toolbar says why. A rule
 * rather than a disabled checkbox because the toolbar is a plain GET form
 * with no client JS (the page's FERPA posture).
 */
export function packetHidesAnswers(query: Pick<PacketQuery, "answers" | "scores">): boolean {
  return !query.answers && query.scores !== "none";
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
    // FB slice 3: a fill-in-the-blank marker reads "(blank)", not "b1" (the
    // markdown strip below would eat a "___").
    .replace(FILL_BLANK_MARKER_RE, "(blank)")
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
  /** Hybrid transparency (D-1): null on an AI row no teacher reviewed. */
  reviewed_by_sub: string | null;
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
  if (row.status !== "final") return "AI proposal";
  // Hybrid transparency (D-1): a final AI score Hybrid settled on its own is
  // not one the teacher accepted.
  return row.reviewed_by_sub === null ? "AI score (not reviewed)" : "AI score (approved)";
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

/** The structural part of a results row the batch rules read. */
export interface PacketRowLike {
  attempt_id: string;
  status: "submitted" | "in_progress";
  student: { name: string; section: string | null };
}

/** One section's stretch of a batch packet (docs/batch-print-design.md). */
export interface PacketRun<T> {
  /** Null only for chosen students no section resolves for. */
  section: string | null;
  rows: T[];
  /** True when the run is chosen students, not the whole section. */
  chosen: boolean;
}

export type PacketSelection<T> =
  | { kind: "chooser" }
  | { kind: "not_found" }
  | { kind: "single"; row: T }
  | { kind: "batch"; runs: PacketRun<T>[] };

/** Sections alphabetically (8.2), the no-section group last. */
function compareSections(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a.localeCompare(b);
}

/**
 * Who a packet prints (docs/batch-print-design.md, D-1, D-3, D-4, 8.1, 8.2).
 *
 * - A chosen attempt that is not this assessment's is not found — the same
 *   answer as a missing assessment, so the URL cannot probe.
 * - With sections, chosen students outside them are ignored (the toolbar's
 *   "switched sections without resetting the picker" case); when none are
 *   left, the sections print in full.
 * - Exactly one chosen student left is "one student's work", as before.
 *   Several print grouped by their own sections.
 * - A section's run is its handed-in work, plus in-progress work when
 *   `inProgress` is set. A chosen student prints whatever their status.
 * - No section and no student: the chooser.
 */
export function selectPacket<T extends PacketRowLike>(
  rows: readonly T[],
  query: Pick<PacketQuery, "sections" | "attempts" | "inProgress" | "anon">,
): PacketSelection<T> {
  const byId = new Map(rows.map((r) => [r.attempt_id, r]));
  const named: T[] = [];
  for (const id of query.attempts) {
    const row = byId.get(id);
    if (!row) return { kind: "not_found" };
    named.push(row);
  }
  const wanted = new Set(query.sections);
  const chosen =
    query.sections.length > 0
      ? named.filter((r) => r.student.section !== null && wanted.has(r.student.section))
      : named;

  if (chosen.length === 1) return { kind: "single", row: chosen[0]! };
  if (chosen.length > 1) {
    const groups = new Map<string | null, T[]>();
    for (const r of chosen) {
      const list = groups.get(r.student.section) ?? [];
      list.push(r);
      groups.set(r.student.section, list);
    }
    return {
      kind: "batch",
      runs: [...groups.entries()]
        .sort((a, b) => compareSections(a[0], b[0]))
        .map(([section, list]) => ({
          section,
          rows: packetOrdering(list, query.anon),
          chosen: true,
        })),
    };
  }
  if (query.sections.length === 0) return { kind: "chooser" };
  return {
    kind: "batch",
    runs: [...query.sections].sort(compareSections).map((section) => ({
      section,
      rows: packetOrdering(
        rows.filter(
          (r) =>
            r.student.section === section &&
            (r.status === "submitted" || query.inProgress),
        ),
        query.anon,
      ),
      chosen: false,
    })),
  };
}

/**
 * D-2: anonymous labels for every attempt in one section, numbered per
 * section. Handed-in work gets the section packet's "Student NN" (numbered
 * over the section's handed-in attempts, so a narrowed or single print keeps
 * the number the full packet gives); work not handed in gets "In progress n",
 * in the packet's order — the toolbar picker's labels.
 */
export function sectionAnonymousLabels<T extends PacketRowLike>(
  rows: readonly T[],
  section: string | null,
): Map<string, string> {
  const inSection = rows.filter((r) => r.student.section === section);
  const labels = anonymousLabels(
    inSection.filter((r) => r.status === "submitted").map((r) => r.attempt_id),
  );
  packetOrdering(
    inSection.filter((r) => r.status === "in_progress"),
    true,
  ).forEach((r, i) => labels.set(r.attempt_id, `In progress ${i + 1}`));
  return labels;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/**
 * The screen strip's line for one run. A one-section packet with no work in
 * progress reads exactly as before ("N of M students in S handed in"); a
 * batch names each section, and says how much of a run is not handed in.
 */
export function stripLine<T extends PacketRowLike>(
  run: PacketRun<T>,
  enrolled: number | null,
  multiRun: boolean,
): string {
  if (run.chosen) {
    return `${plural(run.rows.length, "student")} chosen in ${run.section ?? "no section"}`;
  }
  const handed = run.rows.filter((r) => r.status === "submitted").length;
  const notYet = run.rows.length - handed;
  const base =
    enrolled === null
      ? `${multiRun && run.section ? `${run.section}: ` : ""}${handed} handed in`
      : `${handed} of ${enrolled} students in ${run.section} handed in`;
  return notYet > 0 ? `${base} · ${notYet} not handed in` : base;
}

/** The key page's count line for one run (D-2: a key page per section). */
export function keyCountLine<T extends PacketRowLike>(run: PacketRun<T>): string {
  if (run.chosen) return `${plural(run.rows.length, "chosen attempt")}`;
  const handed = run.rows.filter((r) => r.status === "submitted").length;
  const notYet = run.rows.length - handed;
  return notYet > 0
    ? `${plural(run.rows.length, "attempt")}, ${notYet} not handed in`
    : plural(handed, "handed-in attempt");
}

/**
 * Batch print slice 2 (docs/batch-print-design.md, 9.1): above this many
 * students in the ticked sections the toolbar offers no student checkboxes.
 * The form is a plain GET with no client JS, so the browser puts every ticked
 * id in the URL; 200 ids (~45 bytes each) stays well under the 16 KB the ALB
 * and Node accept.
 */
export const PACKET_STUDENT_CHOICE_CAP = 200;

export type StudentChoices<T> =
  | { tooMany: true; count: number }
  | { tooMany: false; groups: Array<{ section: string | null; rows: T[] }> };

/**
 * The toolbar's student checkboxes: everyone with an attempt (handed in or
 * not) in each ticked section, one group per section in the packet's order,
 * or `tooMany` above the cap.
 */
export function studentChoices<T extends PacketRowLike>(
  rows: readonly T[],
  sections: readonly (string | null)[],
  anon: boolean,
  cap: number = PACKET_STUDENT_CHOICE_CAP,
): StudentChoices<T> {
  const ordered = [...new Set(sections)].sort(compareSections);
  const groups = ordered.map((section) => ({
    section,
    rows: packetOrdering(
      rows.filter((r) => r.student.section === section),
      anon,
    ),
  }));
  const count = groups.reduce((n, g) => n + g.rows.length, 0);
  return count > cap ? { tooMany: true, count } : { tooMany: false, groups };
}

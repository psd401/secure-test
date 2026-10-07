// Instant feedback at hand-in (docs/instant-feedback-design.md, roadmap row
// IF, slice 1): what a student is shown right after THEIR OWN hand-in.
//
// Pure: the assessment's two settings + release stamp, its items, the
// attempt's responses and FINAL scores in; the `feedback` object the submit
// route returns out (or null at `off`). No DB, no request context, so the
// rule "no key before the teacher's chosen moment" is testable on the JSON
// itself.
//
// ADR 0016 holds: this is a post-submit response, never part of the delivery
// bundle. A `correct_answer` key is emitted only at the `answers` level, only
// once answers may be shown (D-4), and only on a missed question.

import type { ItemConfig, ItemRow, ItemType } from "@/db/schema";
import { effectiveScoringMethod } from "@/lib/api/items";
import { itemMaxPoints } from "@/lib/scoring/results";
import { fillBlankAnswer, filledBlankAnswerText } from "@/lib/items/fillBlankAnswer";

export type FeedbackLevel = "score" | "right_wrong" | "answers";
export type FeedbackResult = "correct" | "partial" | "incorrect" | "pending";

export interface FeedbackItem {
  item_id: string;
  /** 1..n by position — the number the student saw on the test. */
  number: number;
  result: FeedbackResult;
  /** Null on a pending item: no points are shown for what is not scored. */
  earned: number | null;
  max: number | null;
  /** Plain text (KaTeX-renderable), lines joined by "\n"; null = not answered. */
  your_answer: string | null;
  /** Only on a missed question, only at `answers`, only once answers may show. */
  correct_answer?: string;
}

export interface Feedback {
  level: FeedbackLevel;
  earned: number;
  max_auto: number;
  pending_count: number;
  items?: FeedbackItem[];
  answers_note?: string;
}

/** D-4: the copy shown at `answers` before the teacher releases them. */
export const ANSWERS_NOTE = "Your teacher will go over the correct answers.";

export interface FeedbackSettings {
  student_feedback: string;
  answers_release: string;
  answers_released_at: Date | string | null;
}

export type FeedbackItemInput = Pick<
  ItemRow,
  "id" | "position" | "type" | "choices" | "correct_choice_ids" | "correct_answer" | "config"
> & {
  /** FB slice 3: a fill_blank's blanks are numbered by their markers' order. */
  stem?: string;
};

export interface FeedbackInput {
  settings: FeedbackSettings;
  items: FeedbackItemInput[];
  /** item id → the saved response payload. */
  responses: Map<string, Record<string, unknown>>;
  /** item id → the response's FINAL score. Proposed / research rows never. */
  finals: Map<string, { points: number; max_points: number }>;
}

/** D-4: may a `correct_answer` reach the student at this hand-in? */
export function answersShown(settings: FeedbackSettings): boolean {
  return (
    settings.student_feedback === "answers" &&
    (settings.answers_release === "at_hand_in" || settings.answers_released_at != null)
  );
}

// ---------------------------------------------------------------------------
// Text rendering. Plain text the client renders with the test's KaTeX rules:
// no HTML, no asset ids. An image ref becomes its alt text, or "[image]".

const ASSET_REF_RE = /!\[([^\]]*)\]\(asset:[^)]*\)/g;

export function plainText(text: string): string {
  return text.replace(ASSET_REF_RE, (_m, alt: string) => (alt.trim() ? alt.trim() : "[image]"));
}

type Choice = { id: string; text: string };

function choiceText(choices: Choice[], id: string): string {
  const c = choices.find((x) => x.id === id);
  return plainText(c ? c.text : id);
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function regionLabel(config: ItemConfig, id: string): string {
  const index = (config.regions ?? []).findIndex((r) => r.id === id);
  return index >= 0 ? `Region ${index + 1}` : "Region";
}

/** The keyed cells of a table, in row-then-column authoring order. */
function keyedCells(config: ItemConfig): Array<{ rowId: string; colId: string; label: string; key: string }> {
  const keys = config.cell_keys ?? {};
  const rows = config.rows ?? [];
  const cols = config.columns ?? [];
  const out: Array<{ rowId: string; colId: string; label: string; key: string }> = [];
  rows.forEach((row, ri) => {
    for (const col of cols) {
      const key = keys[row.id]?.[col.id];
      if (key === undefined) continue;
      const rowLabel = row.label.trim() ? plainText(row.label) : `Row ${ri + 1}`;
      out.push({ rowId: row.id, colId: col.id, label: `${rowLabel}, ${plainText(col.label)}`, key });
    }
  });
  return out;
}

/**
 * FB: each blank's teacher-facing label and, for a keyed blank, the key as
 * text — "Blank n" numbered in stem order through the shared reading
 * (lib/items/fillBlankAnswer.ts, slice 3), so the number is the one the
 * student saw; a dropdown key as its option text, a typed blank's accepted
 * answers joined with " or " (D-5).
 */
function blankLines(item: FeedbackItemInput): Array<{ label: string; key: string | null }> {
  const config = (item.config ?? {}) as ItemConfig;
  return fillBlankAnswer(item.stem ?? "", config.blanks, null).blanks.map((b) => ({
    label: `Blank ${b.number}`,
    key: b.keyed
      ? b.expected.map((e) => (b.format === "content" ? plainText(e) : e)).join(" or ")
      : null,
  }));
}

/** The student's answer as text, or null when there is none. */
export function yourAnswerText(
  item: FeedbackItemInput,
  response: Record<string, unknown> | undefined,
): string | null {
  if (!response) return null;
  const config = (item.config ?? {}) as ItemConfig;
  const choices = (item.choices ?? []) as Choice[];
  switch (response.type) {
    case "multiple_choice_single":
      return typeof response.choice_id === "string" ? choiceText(choices, response.choice_id) : null;
    case "multiple_choice_multi": {
      const ids = strings(response.choice_ids);
      return ids.length > 0 ? ids.map((id) => choiceText(choices, id)).join("\n") : null;
    }
    case "short_text":
    case "essay":
      return typeof response.text === "string" ? response.text : null;
    case "match": {
      const pairs = config.pairs ?? [];
      const matches = (response.matches ?? {}) as Record<string, unknown>;
      // Authoring order of the left column, not the order the response object
      // happens to list its keys in.
      const lines = pairs
        .filter((p) => typeof matches[p.id] === "string")
        .map((p) => {
          const right = pairs.find((q) => q.id === matches[p.id]);
          return `${p.left} → ${right ? right.right : "?"}`;
        });
      return lines.length > 0 ? lines.join("\n") : null;
    }
    case "order": {
      const sequence = config.sequence ?? [];
      const ids = strings(response.ordered_ids);
      if (ids.length === 0) return null;
      return ids
        .map((id, i) => `${i + 1}. ${sequence.find((e) => e.id === id)?.label ?? "?"}`)
        .join("\n");
    }
    case "hotspot": {
      const ids = strings(response.region_ids);
      return ids.length > 0 ? ids.map((id) => regionLabel(config, id)).join("\n") : null;
    }
    case "table": {
      const cells = (response.cells ?? {}) as Record<string, Record<string, unknown>>;
      const keyed = keyedCells(config);
      // A keyless table is pending and its cells are not listed one by one.
      if (keyed.length === 0) return "[table]";
      return keyed
        .map((c) => {
          const v = cells[c.rowId]?.[c.colId];
          return `${c.label}: ${typeof v === "string" && v.trim() ? v : "(blank)"}`;
        })
        .join("\n");
    }
    case "drawing_upload":
      return "[drawing]";
    case "fill_blank": {
      // FB: every blank in stem order (the shared reading, slice 3), a
      // dropdown answer as its option text — never its id; an unanswered
      // blank reads "(blank)" like an empty table cell. Lines, not the
      // sentence: the client escapes this text and runs only the `$…$` pass
      // over it (InstantFeedbackPage.swift), so stem emphasis would show as
      // raw `**`, and a richer shape would need a client release.
      const answers = (response.answers ?? {}) as Record<string, unknown>;
      const blanks = fillBlankAnswer(item.stem ?? "", config.blanks, answers).blanks;
      if (blanks.length === 0) return null;
      return blanks
        .map((b) => {
          const text = filledBlankAnswerText(b);
          return `Blank ${b.number}: ${b.format === "content" ? plainText(text) : text}`;
        })
        .join("\n");
    }
    default:
      return null;
  }
}

/** The key as text, or null when the item carries none. */
export function correctAnswerText(item: FeedbackItemInput): string | null {
  const config = (item.config ?? {}) as ItemConfig;
  const choices = (item.choices ?? []) as Choice[];
  const keyIds = strings(item.correct_choice_ids);
  switch (item.type) {
    case "multiple_choice_single":
    case "multiple_choice_multi":
      return keyIds.length > 0 ? keyIds.map((id) => choiceText(choices, id)).join("\n") : null;
    case "short_text":
      return item.correct_answer ? item.correct_answer : null;
    case "match": {
      const pairs = config.pairs ?? [];
      return pairs.length > 0 ? pairs.map((p) => `${p.left} → ${p.right}`).join("\n") : null;
    }
    case "order": {
      const sequence = config.sequence ?? [];
      return sequence.length > 0 ? sequence.map((e, i) => `${i + 1}. ${e.label}`).join("\n") : null;
    }
    case "hotspot": {
      const ids = config.correct_region_ids ?? [];
      return ids.length > 0 ? ids.map((id) => regionLabel(config, id)).join("\n") : null;
    }
    case "table": {
      const keyed = keyedCells(config);
      return keyed.length > 0 ? keyed.map((c) => `${c.label}: ${c.key}`).join("\n") : null;
    }
    case "fill_blank": {
      // Only keyed blanks — an unkeyed blank earns no point (D-2) and has no
      // answer to show.
      const keyed = blankLines(item).filter((b) => b.key !== null);
      return keyed.length > 0 ? keyed.map((b) => `${b.label}: ${b.key}`).join("\n") : null;
    }
    default:
      return null;
  }
}

/**
 * Does this auto-method item carry the key the scorer needs? Mirrors the
 * `return null; // no answer key` branches of `scoreResponse`
 * (lib/scoring/auto.ts): an unanswered KEYED item is a 0, not a pending one.
 */
function hasAutoKey(item: FeedbackItemInput): boolean {
  return correctAnswerText(item) !== null &&
    (item.type !== "multiple_choice_single" || strings(item.correct_choice_ids).length === 1);
}

function resultFor(points: number, max: number): FeedbackResult {
  if (points >= max) return "correct";
  if (points <= 0) return "incorrect";
  return "partial";
}

/**
 * Build the feedback for one hand-in, or null when the level is `off` (or a
 * value this build does not know — fail closed: show nothing).
 *
 * Counting rules (D-2, "Mixed tests"):
 *   - an AUTO-method item with a final score counts its points into `earned`
 *     and its max into `max_auto` — the same finals the results matrix sums;
 *   - an AUTO-method item with a key but NO response counts as 0 of its max
 *     (`incorrect`): the student skipped it, and calling it "scored by your
 *     teacher" would be untrue;
 *   - everything else — essays, drawings, keyless items, `human` / `ai` /
 *     `hybrid` methods, and an answered auto item without a final — is
 *     `pending` and counted in `pending_count`.
 */
export function buildFeedback(input: FeedbackInput): Feedback | null {
  const level = input.settings.student_feedback;
  if (level !== "score" && level !== "right_wrong" && level !== "answers") return null;
  const showKey = answersShown(input.settings);

  const ordered = [...input.items].sort((a, b) => a.position - b.position);
  let earned = 0;
  let maxAuto = 0;
  let pending = 0;
  const lines: FeedbackItem[] = [];

  ordered.forEach((item, index) => {
    const response = input.responses.get(item.id);
    const final = input.finals.get(item.id);
    const isAuto = effectiveScoringMethod(item.type as ItemType, item.config) === "auto";
    const yours = yourAnswerText(item, response);

    let result: FeedbackResult;
    let points: number | null = null;
    let max: number | null = null;
    if (isAuto && final) {
      points = final.points;
      max = final.max_points;
      result = resultFor(points, max);
    } else if (isAuto && !response && hasAutoKey(item)) {
      points = 0;
      max = itemMaxPoints(item);
      result = "incorrect";
    } else {
      result = "pending";
    }

    if (result === "pending") {
      pending++;
    } else {
      earned += points!;
      maxAuto += max!;
    }

    const line: FeedbackItem = {
      item_id: item.id,
      number: index + 1,
      result,
      earned: points,
      max,
      your_answer: yours,
    };
    if (showKey && (result === "incorrect" || result === "partial")) {
      const key = correctAnswerText(item);
      if (key !== null) line.correct_answer = key;
    }
    lines.push(line);
  });

  const feedback: Feedback = { level, earned, max_auto: maxAuto, pending_count: pending };
  if (level === "score") return feedback;
  feedback.items = lines;
  if (level === "answers" && !showKey) feedback.answers_note = ANSWERS_NOTE;
  return feedback;
}

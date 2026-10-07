// FB slice 3 (docs/fill-in-blank-design.md): a fill-in-the-blank answer read
// as the sentence the student saw — the stem cut at its `[[id]]` markers, each
// blank carrying the student's answer, whether it is keyed and right, and the
// expected answer(s). Every teacher read surface (review queue, per-student
// page, work packet) and the instant-feedback / answer-view lines draw from
// this ONE reading, so "Blank n" is the same blank everywhere.
//
// Pure: stem + blanks + the response's `answers` in, segments out. No HTML —
// a text segment is raw stem source (the caller renders it through
// renderItemContent), an answer is raw text (the caller escapes it, or renders
// a dropdown option's text as content, since option text takes math, §Proposed
// shape).
//
// Numbering and marker reading mirror the preview's renderFillBlankStem
// (lib/preview/renderHtml.ts): blanks are numbered in the order their markers
// first appear, a repeated marker and a marker naming no blank stay literal
// text. A blank with no marker at all (the write boundary refuses one; an
// imported bundle might carry one) is still scored, so it is kept, numbered
// after the placed ones, in `unplaced`.

import { FILL_BLANK_MARKER_RE, isKeyedBlank, type FillBlankBlank } from "@secure-test/schema";
import { fillBlankTextMatches } from "@/lib/scoring/auto";

export interface FilledBlank {
  id: string;
  /** 1-based, stem order (the preview's and the student's numbering). */
  number: number;
  kind: "dropdown" | "text";
  /**
   * How the caller renders `answer` and `expected`: a dropdown's option text
   * is teacher content (math, emphasis) → `content`; a typed answer and a
   * typed key are plain text → escape them.
   */
  format: "content" | "plain";
  /** The answer as text — a dropdown's option TEXT, never its id. Null = no answer. */
  answer: string | null;
  /** A dropdown answer naming an option this item no longer has. `answer` is null. */
  unknown_option: boolean;
  /** Has a marker in the stem. */
  placed: boolean;
  keyed: boolean;
  /** The scorer's own verdict on a keyed blank (lib/scoring/auto.ts); null when unkeyed. */
  right: boolean | null;
  /** The key as text: a dropdown's correct option text, or every accepted typed answer (D-5). Empty when unkeyed. */
  expected: string[];
}

export type FillBlankSegment =
  | { kind: "text"; text: string }
  | { kind: "blank"; blank: FilledBlank };

export interface FilledSentence {
  segments: FillBlankSegment[];
  /** Blanks no marker places, numbered after the placed ones. */
  unplaced: FilledBlank[];
  /** Every blank, in number order. */
  blanks: FilledBlank[];
  /** Keyed blanks (D-2: each is a point) and how many of them are right. */
  keyed_count: number;
  right_count: number;
}

function fill(
  blank: FillBlankBlank,
  number: number,
  placed: boolean,
  answers: Record<string, unknown>,
): FilledBlank {
  const raw = answers[blank.id];
  const value = typeof raw === "string" ? raw : undefined;
  const keyed = isKeyedBlank(blank);
  if (blank.kind === "dropdown") {
    const option = value ? blank.options.find((o) => o.id === value) : undefined;
    const correct = blank.options.find((o) => o.id === blank.correct_option_id);
    return {
      id: blank.id,
      number,
      kind: "dropdown",
      format: "content",
      answer: option ? option.text : null,
      unknown_option: !!value && !option,
      placed,
      keyed,
      // Option-id equality, exactly the scorer's rule; no answer is wrong.
      right: keyed ? value !== undefined && value === blank.correct_option_id : null,
      expected: keyed ? [correct ? correct.text : blank.correct_option_id!] : [],
    };
  }
  const keys = blank.keys ?? [];
  return {
    id: blank.id,
    number,
    kind: "text",
    format: "plain",
    answer: value !== undefined && value.trim() !== "" ? value : null,
    unknown_option: false,
    placed,
    keyed,
    // Any key matching earns the point (D-5), through the short-text rule
    // with the blank's own exact_form — the scorer's call, so the mark here
    // is what "auto" decided.
    right: keyed
      ? value !== undefined && fillBlankTextMatches(value, keys, blank.exact_form === true)
      : null,
    expected: keyed ? [...keys] : [],
  };
}

export function fillBlankAnswer(
  stem: string,
  blanks: readonly FillBlankBlank[] | null | undefined,
  answers: Record<string, unknown> | null | undefined,
): FilledSentence {
  const list = blanks ?? [];
  const given = answers ?? {};
  const byId = new Map(list.map((b) => [b.id, b] as const));
  const placedIds = new Set<string>();
  const segments: FillBlankSegment[] = [];
  const out: FilledBlank[] = [];
  let last = 0;
  for (const m of stem.matchAll(FILL_BLANK_MARKER_RE)) {
    const blank = byId.get(m[1]!);
    // An orphaned or repeated marker is not a blank: it stays in the text
    // that follows (the preview's reading).
    if (!blank || placedIds.has(blank.id)) continue;
    placedIds.add(blank.id);
    const text = stem.slice(last, m.index);
    if (text) segments.push({ kind: "text", text });
    last = m.index! + m[0].length;
    const filled = fill(blank, out.length + 1, true, given);
    out.push(filled);
    segments.push({ kind: "blank", blank: filled });
  }
  const tail = stem.slice(last);
  if (tail) segments.push({ kind: "text", text: tail });

  const unplaced: FilledBlank[] = [];
  for (const blank of list) {
    if (placedIds.has(blank.id)) continue;
    const filled = fill(blank, out.length + 1, false, given);
    out.push(filled);
    unplaced.push(filled);
  }
  const keyed = out.filter((b) => b.keyed);
  return {
    segments,
    unplaced,
    blanks: out,
    keyed_count: keyed.length,
    right_count: keyed.filter((b) => b.right === true).length,
  };
}

/** The answer as one plain line — "(blank)" when none, never an option id. */
export function filledBlankAnswerText(blank: FilledBlank): string {
  if (blank.answer !== null) return blank.answer;
  return blank.unknown_option ? "(a choice no longer on this question)" : "(blank)";
}

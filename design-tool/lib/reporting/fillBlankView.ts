// FB slice 3 (docs/fill-in-blank-design.md): the filled sentence as HTML, for
// the teacher's read surfaces — the review queue (rendered in its route, since
// the panel is a client component and KaTeX stays out of its bundle), the
// per-student page and the work packet. One renderer, so the three read alike.
//
// Escaping: every stem text segment goes through renderItemContent (it
// escapes its own text, renders KaTeX and emphasis); a dropdown's option text
// is teacher content and goes through it too; a typed answer and a typed key
// are escaped plain text. Nothing reaches the markup raw.
//
// `showKey` is the W-1 gate (hand-run 2026-09-14): a ✓ / ✗ against the key IS
// the key, so with it off the sentence carries the student's answers only —
// no marks, no "expected", no keyed / unkeyed notes.

import { escapeHtml } from "@/lib/escapeHtml";
import {
  fillBlankAnswer,
  filledBlankAnswerText,
  type FilledBlank,
  type FilledSentence,
} from "@/lib/items/fillBlankAnswer";
import { renderItemContent, type ResolvedAsset } from "@/lib/items/renderItemContent";
import type { FillBlankBlank } from "@secure-test/schema";

export interface FillBlankHtmlOptions {
  /** Marks, expected answers and the key notes (W-1). */
  showKey: boolean;
  /** The "Keyed blanks matching the key: n of m." line under the sentence (with `showKey`). */
  summary?: boolean;
}

function text(value: string, format: FilledBlank["format"], resolved: Map<string, ResolvedAsset>): string {
  return format === "content" ? renderItemContent(value, resolved) : escapeHtml(value);
}

function blankHtml(
  blank: FilledBlank,
  sentence: FilledSentence,
  resolved: Map<string, ResolvedAsset>,
  showKey: boolean,
): string {
  const state = !showKey || !blank.keyed ? "fb-unkeyed" : blank.right ? "fb-right" : "fb-wrong";
  let html =
    `<span class="fb-blank ${state}">` +
    `<span class="fb-num" aria-hidden="true">${blank.number}</span>` +
    `<span class="sr-only">Blank ${blank.number}: </span>`;
  html +=
    blank.answer !== null
      ? `<span class="fb-answer">${text(blank.answer, blank.format, resolved)}</span>`
      : `<span class="fb-answer fb-empty">${escapeHtml(filledBlankAnswerText(blank))}</span>`;
  if (showKey && blank.keyed) {
    html += blank.right
      ? `<span class="fb-mark" title="Matches the key"><span aria-hidden="true">✓</span><span class="sr-only"> (matches the key)</span></span>`
      : `<span class="fb-mark" title="Does not match the key"><span aria-hidden="true">✗</span><span class="sr-only"> (does not match the key)</span></span>` +
        `<span class="fb-expected">expected ${blank.expected
          .map((e) => text(e, blank.format, resolved))
          .join(" or ")}</span>`;
  } else if (showKey && sentence.keyed_count > 0) {
    // A partly keyed item: this blank earns no point (D-2) — say so, so the
    // teacher does not read the missing mark as an oversight.
    html += `<span class="fb-nokey">no key, not scored</span>`;
  }
  return html + `</span>`;
}

/** The sentence with every blank filled; the unplaced blanks and the summary after it. */
export function renderFilledSentenceHtml(
  sentence: FilledSentence,
  resolved: Map<string, ResolvedAsset>,
  options: FillBlankHtmlOptions,
): string {
  const { showKey } = options;
  let html = `<div class="fb-sentence">`;
  for (const seg of sentence.segments) {
    html +=
      seg.kind === "text"
        ? renderItemContent(seg.text, resolved)
        : blankHtml(seg.blank, sentence, resolved, showKey);
  }
  html += `</div>`;
  if (sentence.unplaced.length > 0) {
    html +=
      `<p class="fb-unplaced">Not in the question text: ` +
      sentence.unplaced.map((b) => blankHtml(b, sentence, resolved, showKey)).join(" ") +
      `</p>`;
  }
  if (showKey && options.summary) {
    const line =
      sentence.keyed_count === 0
        ? "No blank has a key — score each blank by hand (1 point each)."
        : `Keyed blanks matching the key: ${sentence.right_count} of ${sentence.keyed_count}.` +
          (sentence.keyed_count < sentence.blanks.length
            ? ` ${sentence.blanks.length - sentence.keyed_count} blank${sentence.blanks.length - sentence.keyed_count === 1 ? " has" : "s have"} no key and ${sentence.blanks.length - sentence.keyed_count === 1 ? "is" : "are"} not scored.`
            : "");
    html += `<p class="fb-summary">${escapeHtml(line)}</p>`;
  }
  return html;
}

/** Convenience: an item row's stem + blanks and a stored response, straight to HTML. */
export function renderFillBlankAnswerHtml(
  stem: string,
  blanks: readonly FillBlankBlank[] | null | undefined,
  response: Record<string, unknown> | null | undefined,
  resolved: Map<string, ResolvedAsset>,
  options: FillBlankHtmlOptions,
): string {
  const answers =
    response && typeof response.answers === "object" && response.answers !== null
      ? (response.answers as Record<string, unknown>)
      : null;
  return renderFilledSentenceHtml(fillBlankAnswer(stem, blanks, answers), resolved, options);
}

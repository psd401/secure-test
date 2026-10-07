// RT slice 2 (docs/rich-text-essay-design.md, "Teacher side"): the ONE
// renderer for a student's essay answer on the teacher's screens — the
// scoring queue, the per-student page, its "Earlier versions" list and the
// work packet. (The Google Docs release maps the same cleaned html to
// Docs-friendly markup in lib/googleDocs/content.ts.)
//
// A formatted essay's `html` was cleaned at ingest (slice 1), but it is
// cleaned AGAIN here, at render: a stored row may predate a sanitiser fix, and
// a jsonb column is not a promise anyone re-checked. Only the rebuilt subset
// (p / br / strong / em / u / ul / ol / li, data-indent="first") ever reaches
// a page. A plain essay — no `html`, or one that cleans to nothing — renders
// as its escaped `text`, exactly as every surface showed it before RT.
//
// Word count, AI scoring, safeguarding and insights never come through here:
// they read `text` (D-7).

import { escapeHtml } from "@/lib/escapeHtml";
import { sanitizeEssayHtml } from "@/lib/richText/essayHtml";

/** The class on the wrapper of a formatted essay; its CSS is in app/globals.css. */
export const ESSAY_RICH_CLASS = "essay-rich";

function asRecord(response: unknown): Record<string, unknown> | null {
  return response && typeof response === "object" ? (response as Record<string, unknown>) : null;
}

/**
 * The re-cleaned html of a formatted essay answer, or null when the answer is
 * plain (no `html`, a non-essay response, or html that cleans to nothing).
 * Accepts a `responses.response` or a `response_revisions.response` alike.
 */
export function essayRichHtml(response: unknown): string | null {
  const r = asRecord(response);
  if (!r) return null;
  if (r.type !== undefined && r.type !== "essay") return null;
  if (typeof r.html !== "string" || r.html === "") return null;
  const clean = sanitizeEssayHtml(r.html);
  return clean === "" ? null : clean;
}

/**
 * The answer as HTML for a teacher's page.
 *
 * - Formatted: `<div class="essay-rich">…cleaned html…</div>`. The class
 *   resets `white-space` to normal (the html's paragraphs and `<br>` carry the
 *   line breaks, and the containers around it keep `pre-wrap` / `pre-line` for
 *   plain answers), sets the first-line indent (D-4) and draws the lists (D-9).
 * - Plain: the escaped `text`, newlines kept as newlines — the surface's own
 *   container (`white-space: pre-wrap` / `pre-line`) shows them, as it did
 *   before RT. A missing `text` is "".
 */
export function renderEssayAnswerHtml(response: unknown): string {
  const rich = essayRichHtml(response);
  if (rich !== null) return `<div class="${ESSAY_RICH_CLASS}">${rich}</div>`;
  const text = asRecord(response)?.text;
  return escapeHtml(typeof text === "string" ? text : "");
}

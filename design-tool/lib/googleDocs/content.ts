// Row GD slice 3 (docs/google-docs-release-design.md, R-5): the Doc's body as
// HTML, which Drive converts to a Google Doc on upload. Pure — attempt data
// in, a string out — so every content box is tested without Drive.
//
// A Doc cannot run KaTeX, so math in a prompt or source stays as its LaTeX
// source, and a picture (`![alt](asset:<uuid>)`) becomes "[Image: alt]". A
// short answer (FR D-5) is likewise the student's typed text, escaped — the
// screen renders it as math (lib/reporting/shortTextView.ts), the Doc cannot.

import type { FeedbackBlock, FeedbackContents } from "@/lib/reporting/feedbackRelease";
import { pictureKey, type DocAnswer, type DocPicture } from "@/lib/googleDocs/wholeTest";

export { scoreLabel } from "@/lib/reporting/feedbackRelease";

/**
 * The Doc's boxes: prompt and sources (GD D-2), plus FR's D-2 / R-2 set
 * (teacher score, AI score, teacher feedback, AI feedback, rubric table).
 * Slice 3 replaced the single `score` box; an old row or an old dialog's
 * `score` reads as both score boxes (readReleaseContents, sendDialog.ts).
 */
export interface ReleaseContents extends FeedbackContents {
  prompt: boolean;
  sources: boolean;
}

export interface EssaySection {
  /** 1-based question number in the assessment. */
  number: number;
  stem: string;
  stimulus: string | null;
  sources: Array<{ label: string; text: string }>;
  /**
   * FR D-5 (docs/feedback-release-design.md): a short answer sits beside the
   * essays. Absent = essay, so a caller from before slice 5 still compiles.
   */
  kind?: "essay" | "short_text" | "item";
  /** The student's text, or null when the question was left blank. */
  answer: string | null;
  /**
   * RT slice 2 (docs/rich-text-essay-design.md): a formatted essay's html,
   * ALREADY re-cleaned by essayRichHtml (lib/richText/renderEssayAnswer.ts);
   * null for a plain essay. When set it is what the Doc shows; `answer` stays
   * the plain reading. Optional so a caller from before RT still compiles.
   */
  answer_html?: string | null;
  /**
   * FR R-3: this question's labelled blocks from buildFeedbackRelease
   * (lib/reporting/feedbackRelease.ts), already filtered by the boxes ticked.
   */
  feedback: FeedbackBlock[];
  /**
   * U-25 slice 4 (docs/google-docs-whole-test-design.md): any other item
   * type's answer (kind "item"), key-free by type (wholeTest.ts, D-11).
   */
  answer_view?: DocAnswer;
  /** Slice 4 (1.1): the question's own pictures, under its stem. */
  pictures?: DocPicture[];
  /** Slice 4: a fill-in-the-blank's stem is its answer sentence, not printed twice. */
  stem_in_answer?: boolean;
}

export interface DocInput {
  studentName: string;
  assessmentName: string;
  /** D-12: set when the attempt was not handed in; the send's instant. */
  draftAsOf: Date | null;
  essays: EssaySection[];
  contents: ReleaseContents;
  /** FR D-4: the per-student overall teacher feedback, printed once at the top. */
  overall?: FeedbackBlock | null;
  /**
   * RT D-10: the essay answers carry line spacing 2.0, so the Doc stays
   * double-spaced as the student edits it. Essays only — prompt, sources and
   * feedback keep normal spacing. Default off.
   */
  doubleSpace?: boolean;
  /**
   * U-25 slice 4 (1.3): a whole-test Doc carries every question's text and
   * stimulus whatever the Prompt box says; Sources stays a box.
   */
  wholeTest?: boolean;
  /**
   * Slice 4, images: resolved pictures as `data:` URIs by `pictureKey`. A
   * picture missing here goes in as a line of text.
   */
  pictures?: ReadonlyMap<string, string>;
}

const TZ = "America/Los_Angeles";
const STAMP_DATE = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const STAMP_TIME = new Intl.DateTimeFormat("en-GB", {
  timeZone: TZ,
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** "2026-10-05 14:30", Pacific (D-5). */
export function releaseStamp(at: Date): string {
  return `${STAMP_DATE.format(at)} ${STAMP_TIME.format(at)}`;
}

/** "<student name> – <assessment> – 2026-10-05 14:30" (D-5). */
export function docTitle(studentName: string, assessmentName: string, at: Date): string {
  return `${studentName} – ${assessmentName} – ${releaseStamp(at)}`;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const IMAGE_REF = /!\[([^\]]*)\]\(asset:[0-9a-f-]{36}\)/gi;

/** Item content as plain text: pictures become "[Image: alt]". */
export function plainContent(text: string): string {
  return text.replace(IMAGE_REF, (_m, alt: string) =>
    alt.trim() ? `[Image: ${alt.trim()}]` : "[Image]",
  );
}

/**
 * GD-1 (row 439, 2026-10-05): Drive's HTML import gives a bare `<p>` no space
 * after it, so an essay's paragraphs ran together into one block. Body
 * paragraphs carry their own spacing; Drive keeps an inline margin as
 * "space after".
 */
export const PARAGRAPH_OPEN = '<p style="margin:0 0 10pt 0">';

/**
 * RT D-10: Drive keeps an inline `line-height` as the paragraph's line
 * spacing (Docs' own HTML export writes `line-height:2.0` for double), so the
 * Doc is double-spaced, not a picture of double spacing.
 */
export const DOUBLE_SPACING = "line-height:2.0";

/** Blank lines split paragraphs; single newlines stay as line breaks. */
export function paragraphs(text: string, open: string = PARAGRAPH_OPEN): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p !== "")
    .map((p) => `${open}${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
    .join("\n");
}

/** A plain essay answer's paragraphs, double-spaced when asked (D-10). */
function plainAnswerHtml(text: string, doubleSpace: boolean): string {
  const open = doubleSpace ? `<p style="margin:0 0 10pt 0;${DOUBLE_SPACING}">` : PARAGRAPH_OPEN;
  return paragraphs(text, open);
}

/**
 * RT slice 2: a formatted essay as Docs-friendly HTML. The input is the
 * sanitiser's canonical output (lib/richText/essayHtml.ts serialize), so its
 * only tags are exactly `<p>`, `<p data-indent="first">`, `<br>`, `<strong>`,
 * `<em>`, `<u>`, `<ul>`, `<ol>`, `<li>` and their closers, and every `<` in the
 * student's words is already `&lt;` — so a tag-for-tag replacement cannot
 * touch text. Mapped for Drive's importer:
 *
 * - `<p>` → no margin: each Enter was a paragraph, and a blank line the
 *   student typed is its own empty paragraph, so the Doc spaces the essay as
 *   the student did (unlike a plain answer, whose blank lines are the
 *   paragraph breaks — GD-1).
 * - `data-indent="first"` → `text-indent:36pt`, half an inch, MLA (D-4).
 * - `<strong>` / `<em>` → `<b>` / `<i>`, the tags the rest of this Doc uses;
 *   `<u>` stays.
 * - D-10 double spacing → `line-height:2.0` on every paragraph and list item.
 */
export function docRichAnswerHtml(cleanHtml: string, doubleSpace: boolean): string {
  const spacing = doubleSpace ? `;${DOUBLE_SPACING}` : "";
  return cleanHtml
    .replaceAll('<p data-indent="first">', `<p style="margin:0;text-indent:36pt${spacing}">`)
    .replaceAll("<p>", `<p style="margin:0${spacing}">`)
    .replaceAll("<li>", doubleSpace ? `<li style="${DOUBLE_SPACING}">` : "<li>")
    .replaceAll("<strong>", "<b>")
    .replaceAll("</strong>", "</b>")
    .replaceAll("<em>", "<i>")
    .replaceAll("</em>", "</i>");
}

/**
 * FR R-3: one block as Doc HTML. Labels come from the block (D-1), so the
 * renderer never names a source itself.
 */
function blockHtml(block: FeedbackBlock): string {
  if (block.kind === "score") {
    return `<p><b>${escapeHtml(block.label)}:</b> ${block.points} of ${block.max_points}</p>`;
  }
  if (block.kind === "rubric_table") {
    const { columns } = block;
    const head = `<tr><th>Criterion</th>${columns.level ? "<th>Level</th>" : ""}${columns.points ? "<th>Points</th>" : ""}${columns.ai_feedback ? "<th>AI feedback</th>" : ""}</tr>`;
    const rows = block.rows.map((r) => {
      const cells = [`<td>${escapeHtml(r.criterion)}</td>`];
      if (columns.level) cells.push(`<td>${escapeHtml(r.level ?? "")}</td>`);
      if (columns.points) cells.push(`<td>${r.points ?? ""}</td>`);
      if (columns.ai_feedback) cells.push(`<td>${escapeHtml(r.ai_feedback ?? "")}</td>`);
      return `<tr>${cells.join("")}</tr>`;
    });
    return `<table border="1">${head}${rows.join("")}</table>`;
  }
  const out = [`<p><b>${escapeHtml(block.label)}:</b></p>`];
  if (block.text) out.push(paragraphs(block.text));
  if (block.criteria.length > 0) {
    out.push(
      `<ul>${block.criteria.map((c) => `<li><b>${escapeHtml(c.criterion)}:</b> ${escapeHtml(c.text)}</li>`).join("")}</ul>`,
    );
  }
  return out.join("");
}

/** A picture as an `<img>`, or its text stand-in when it was not resolved. */
function pictureHtml(picture: DocPicture, pictures: ReadonlyMap<string, string> | undefined): string {
  const src = pictures?.get(pictureKey(picture.ref));
  if (src) return `<p><img src="${src}" alt="${escapeHtml(picture.alt)}" style="max-width:100%"></p>`;
  return `<p><i>[Picture: ${escapeHtml(picture.alt)}]</i></p>`;
}

/** Slice 4: one non-text answer (wholeTest.ts), never a mark or a key (D-11). */
export function docAnswerHtml(answer: DocAnswer, pictures?: ReadonlyMap<string, string>): string {
  switch (answer.kind) {
    case "none":
      return `<p><i>No answer.</i></p>`;
    case "choices":
      // D-12: every option, the student's marked.
      return answer.options
        .map((o) => `<p style="margin:0 0 4pt 0">${o.chosen ? "☑" : "☐"} ${escapeHtml(plainContent(o.text))}</p>`)
        .join("");
    case "lines": {
      const tag = answer.ordered ? "ol" : "ul";
      return `<${tag}>${answer.lines.map((l) => `<li>${escapeHtml(plainContent(l))}</li>`).join("")}</${tag}>`;
    }
    case "fill_blank": {
      const sentence = answer.segments
        .map((s) => ("text" in s ? escapeHtml(plainContent(s.text)) : `<b>[${escapeHtml(plainContent(s.answer))}]</b>`))
        .join("")
        .replace(/\r\n?/g, "\n")
        .replace(/\n/g, "<br>");
      const rest = answer.unplaced.map((b) => `<p>Blank ${b.number}: ${escapeHtml(plainContent(b.answer))}</p>`);
      return `${PARAGRAPH_OPEN}${sentence}</p>${rest.join("")}`;
    }
    case "table": {
      const showLabels = answer.rows.some((r) => r.label.trim() !== "");
      const head = `<tr>${showLabels ? `<th>${escapeHtml(answer.corner)}</th>` : ""}${answer.columns.map((c) => `<th>${escapeHtml(c)}</th>`).join("")}</tr>`;
      const rows = answer.rows.map(
        (r) =>
          `<tr>${showLabels ? `<th>${escapeHtml(r.label)}</th>` : ""}${r.cells.map((c) => `<td>${escapeHtml(c)}</td>`).join("")}</tr>`,
      );
      return `<table border="1">${head}${rows.join("")}</table>`;
    }
    case "picture":
      return pictureHtml(answer.picture, pictures);
  }
}

export function buildDocHtml(input: DocInput): string {
  const { contents } = input;
  const parts: string[] = [];
  parts.push(`<h1>${escapeHtml(input.studentName)}</h1>`);
  parts.push(`<p>${escapeHtml(input.assessmentName)}</p>`);
  if (input.draftAsOf) {
    parts.push(
      `<p><i>Draft — not handed in as of ${escapeHtml(releaseStamp(input.draftAsOf))}</i></p>`,
    );
  }
  if (input.overall) parts.push(blockHtml(input.overall));
  const many = input.essays.length > 1;
  const whole = input.wholeTest === true;
  for (const essay of input.essays) {
    if (many || whole) parts.push(`<h2>Question ${essay.number}</h2>`);
    if (whole) {
      // 1.3: the question text always; no "Prompt" heading, as on a test.
      if (essay.stimulus && essay.stimulus.trim()) {
        parts.push(paragraphs(plainContent(essay.stimulus)));
      }
      if (!essay.stem_in_answer) parts.push(paragraphs(plainContent(essay.stem)));
      for (const pic of essay.pictures ?? []) parts.push(pictureHtml(pic, input.pictures));
    } else if (contents.prompt) {
      if (essay.stimulus && essay.stimulus.trim()) {
        parts.push(paragraphs(plainContent(essay.stimulus)));
      }
      parts.push(`<h3>Prompt</h3>`, paragraphs(plainContent(essay.stem)));
    }
    if (contents.sources) {
      for (const src of essay.sources) {
        parts.push(`<h3>${escapeHtml(src.label)}</h3>`, paragraphs(plainContent(src.text)));
      }
    }
    if (essay.kind === "item") {
      parts.push(`<h3>Answer</h3>`, docAnswerHtml(essay.answer_view ?? { kind: "none" }, input.pictures));
      for (const block of essay.feedback) parts.push(blockHtml(block));
      continue;
    }
    const shortAnswer = essay.kind === "short_text";
    parts.push(`<h3>${shortAnswer ? "Answer" : many || whole ? "Response" : "Essay"}</h3>`);
    // RT D-10 double spacing and rich text are essays only; a short answer
    // (FR D-5) is plain paragraphs at normal spacing.
    const doubleSpace = input.doubleSpace === true && !shortAnswer;
    parts.push(
      essay.answer_html && !shortAnswer
        ? docRichAnswerHtml(essay.answer_html, doubleSpace)
        : essay.answer && essay.answer.trim()
          ? plainAnswerHtml(essay.answer, doubleSpace)
          : `<p><i>No response.</i></p>`,
    );
    for (const block of essay.feedback) parts.push(blockHtml(block));
  }
  return `<!doctype html><html><head><meta charset="utf-8"></head><body>\n${parts.join("\n")}\n</body></html>`;
}

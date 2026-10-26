// Editor redesign Phase 7 slice A (R-8, docs/editor-redesign-design.md):
// where each proposed question sits on the source PDF, so the review pane
// can draw a numbered region on the page and link it both ways to the card.
//
// The model returns no positions. What the pipeline does have is the
// printed question number each candidate claims (`source_number(s)`,
// readSourceNumbers) and, on the text path, every text line's page and
// height (extractPdfLayout). A line that starts "N." / "N)" is an anchor;
// a candidate is placed at the anchor carrying its number, walked in
// document order. A candidate with no number (or a number that is not
// printed at a line start) is placed "by order": the page of the candidate
// before it, with no box. A scan has no text layer, so nothing is placed
// and the pane says so. Pure; shared by the route and the panel.

export interface PageSize {
  /** Points, the page as displayed (rotation applied). */
  width: number;
  height: number;
}

export interface QuestionAnchor {
  /** The printed question number. */
  number: number;
  /** 1-based. */
  page: number;
  /** Baseline of the numbered line, points from the top of the page. */
  y: number;
}

export interface CandidateRegion {
  /** 1-based page. */
  page: number;
  /** Fractions of the page height (0 = top); null when placed by order. */
  top: number | null;
  bottom: number | null;
  /** `number`: found by its printed number. `order`: no number matched,
   * so it is shown on the page of the question before it. */
  how: "number" | "order";
}

// Only a number that starts a line counts, and it needs a space (or the end
// of the line) after it: "2.5 g" and "page 14." are not questions.
const ANCHOR_RE = /^[ \t]*\(?(\d{1,3})[.)](?=\s|$)/;
/** How far above the numbered line's baseline the region starts (a line of
 * 12 pt type, plus a little air). */
export const REGION_HEAD_PT = 14;

/** The numbered lines of one page, top to bottom. `text` may carry the E6
 * emphasis markers (`**`, `_`), which are ignored. */
export function anchorsFromLines(
  lines: readonly { y: number; text: string }[],
  page: number,
): QuestionAnchor[] {
  const out: QuestionAnchor[] = [];
  for (const l of [...lines].sort((a, b) => a.y - b.y)) {
    const m = ANCHOR_RE.exec(l.text.replace(/\*\*|_/g, ""));
    if (m) out.push({ number: Number(m[1]), page, y: l.y });
  }
  return out;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/**
 * One region (or null) per candidate, aligned with `sourceNumbers` (the raw
 * candidate list, in the order the model returned it — document order).
 * Anchors are walked forward from the last match, so a test with two forms
 * numbered from 1, or an answer key numbered again at the end, places each
 * question on its own copy of the number. A number not found ahead is looked
 * for again on the anchor just used (two items made from one printed
 * question share it), then anywhere.
 */
export function locateCandidates(
  sourceNumbers: readonly (readonly number[])[],
  anchors: readonly QuestionAnchor[],
  pages: readonly PageSize[],
): (CandidateRegion | null)[] {
  const sorted = [...anchors].sort((a, b) => a.page - b.page || a.y - b.y);
  let cursor = 0;
  let prev: CandidateRegion | null = null;
  return sourceNumbers.map((numbers) => {
    const first = numbers[0];
    let at = -1;
    if (first !== undefined) {
      at = sorted.findIndex((a, i) => i >= cursor && a.number === first);
      if (at < 0 && cursor > 0 && sorted[cursor - 1]!.number === first) at = cursor - 1;
      if (at < 0) at = sorted.findIndex((a) => a.number === first);
    }
    if (at < 0) {
      const region: CandidateRegion | null = prev ? { page: prev.page, top: null, bottom: null, how: "order" } : null;
      if (region) prev = region;
      return region;
    }
    // A match set built from rows 1-5 runs to row 5's anchor.
    const last = numbers[numbers.length - 1]!;
    let end = at;
    if (numbers.length > 1) {
      const e = sorted.findIndex((a, i) => i > at && a.number === last);
      if (e > at) end = e;
    }
    const start = sorted[at]!;
    const height = pages[start.page - 1]?.height ?? 0;
    // The region runs to the next numbered line on the same page, else to
    // the foot of the page (a question that runs over is shown on its first
    // page only).
    const next = sorted[end + 1];
    const endAnchor = sorted[end]!;
    const bottomPt =
      endAnchor.page !== start.page
        ? height
        : next && next.page === start.page
          ? next.y - REGION_HEAD_PT
          : height;
    const region: CandidateRegion =
      height > 0
        ? {
            page: start.page,
            top: clamp01((start.y - REGION_HEAD_PT) / height),
            bottom: clamp01(bottomPt / height),
            how: "number",
          }
        : { page: start.page, top: null, bottom: null, how: "number" };
    cursor = Math.max(cursor, end + 1);
    prev = region;
    return region;
  });
}

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
  /** A2: where the page's text and figures start and end, points from the
   * top (contentBounds). Absent on a page with no text or figures, on a
   * Word document's pseudo-page and on results from before A2; a region
   * then runs to the page edge, as it always did. */
  contentTop?: number;
  contentBottom?: number;
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
  /** A2: the same question carried on to later pages, one box per page
   * (fractions of that page's height), up to the next numbered line. */
  continues?: { page: number; top: number; bottom: number }[];
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

/** A2: a footer (or header) line that is only a page number ("3",
 * "Page 3", "3 of 4", "- 3 -") is not content: the last question stops
 * above it. Only the page's last or first line is tested, so a bare
 * number inside a question (a table cell, an answer) still counts. */
const PAGE_NUMBER_RE = /^[\s\-–—]*(page\s*)?\d{1,4}(\s*(of|\/)\s*\d{1,4})?[\s\-–—]*$/i;
/** Below a line's baseline: its descenders, plus a little air. */
export const REGION_FOOT_PT = 8;
/** A continuation shorter than this (the next question starts right at the
 * top of the page) is not drawn. */
const MIN_CONTINUATION_PT = 10;

/**
 * A2: the top and bottom of one page's content, points from the top: the
 * first and last text line (a page-number footer left out) and any figure
 * box above or below them. Undefined on a page with neither.
 */
export function contentBounds(
  lines: readonly { y: number; text: string }[],
  figureBoxes: readonly { top: number; bottom: number }[],
): { contentTop: number; contentBottom: number } | undefined {
  const tops: number[] = [];
  const bottoms: number[] = [];
  const isPageNumber = (l: { text: string } | undefined) =>
    l !== undefined && PAGE_NUMBER_RE.test(l.text.replace(/\*\*|_/g, ""));
  const sorted = [...lines].sort((a, b) => a.y - b.y);
  if (isPageNumber(sorted[sorted.length - 1])) sorted.pop();
  if (isPageNumber(sorted[0])) sorted.shift();
  for (const l of sorted) {
    tops.push(l.y - REGION_HEAD_PT);
    bottoms.push(l.y + REGION_FOOT_PT);
  }
  for (const f of figureBoxes) {
    tops.push(f.top);
    bottoms.push(f.bottom);
  }
  if (tops.length === 0) return undefined;
  return { contentTop: Math.max(0, Math.min(...tops)), contentBottom: Math.max(...bottoms) };
}

/** Where a box that runs to the end of a page stops: the content's bottom
 * when known, else the page edge. */
function pageFoot(pages: readonly PageSize[], page: number): number {
  const size = pages[page - 1];
  const height = size?.height ?? 0;
  return size?.contentBottom === undefined ? height : Math.min(height, size.contentBottom);
}

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
    // The question runs to the next numbered line. With none after it (the
    // last question), it runs to the end of the content on the page of its
    // last number. A2: a box ends at the content, not at the foot of the
    // page, and a question that runs over a page break gets a box on each
    // page it covers ("continues").
    const next = sorted[end + 1];
    const endAnchor = sorted[end]!;
    const stop = next
      ? { page: next.page, y: next.y - REGION_HEAD_PT }
      : { page: endAnchor.page, y: pageFoot(pages, endAnchor.page) };
    const bottomPt = stop.page === start.page ? stop.y : pageFoot(pages, start.page);
    let region: CandidateRegion;
    if (height > 0) {
      region = {
        page: start.page,
        top: clamp01((start.y - REGION_HEAD_PT) / height),
        bottom: clamp01(bottomPt / height),
        how: "number",
      };
      const continues: NonNullable<CandidateRegion["continues"]> = [];
      for (let pg = start.page + 1; pg <= stop.page; pg++) {
        const size = pages[pg - 1];
        if (!size || size.height <= 0 || size.contentTop === undefined) continue;
        const top = size.contentTop;
        const bottom = pg === stop.page ? stop.y : pageFoot(pages, pg);
        if (bottom - top < MIN_CONTINUATION_PT) continue;
        continues.push({ page: pg, top: clamp01(top / size.height), bottom: clamp01(bottom / size.height) });
      }
      if (continues.length > 0) region.continues = continues;
    } else {
      region = { page: start.page, top: null, bottom: null, how: "number" };
    }
    cursor = Math.max(cursor, end + 1);
    prev = region;
    return region;
  });
}

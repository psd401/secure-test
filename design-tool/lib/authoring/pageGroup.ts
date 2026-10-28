// Page groups (2026-10-28, James; Route B of the page-break request): an
// item set with no stimulus text, no sources and no source link, over two or
// more questions, is not an unfinished stimulus but questions the teacher
// keeps on one student page. No column marks it — decided 2026-10-28 to infer
// it, accepting that a stimulus stretched over two questions before its text
// is written reads as a group until it has text. A set of one with nothing in
// it is still an empty stimulus (readiness flags it).
//
// The student renderer (AssessmentPage.swift `isPageGroup`) hides an empty
// block whatever its size — a student is never shown an empty box — so only
// the teacher-facing surfaces use the two-question rule. Pure.

export interface PageGroupShape {
  stimulus_text?: string | null;
  /** The preview's name for the same text. */
  stimulus?: string | null;
  sources?: readonly unknown[] | null;
  source_item_id?: string | null;
  /** The preview's resolved E12 source. */
  source?: unknown;
}

export function isPageGroup(set: PageGroupShape, memberCount: number): boolean {
  const text = (set.stimulus_text ?? set.stimulus ?? "").trim();
  return (
    memberCount >= 2 &&
    text === "" &&
    (set.sources ?? []).length === 0 &&
    !set.source_item_id &&
    !set.source
  );
}

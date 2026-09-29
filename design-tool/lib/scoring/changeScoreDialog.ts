/**
 * Change a final score (docs/change-score-design.md, slice 2): the pure logic
 * behind the per-student page's "Change" dialog — kept apart from the React
 * component so the repo's static-markup tests (no DOM harness) can pin it.
 */

/** The three ways a final score comes to exist, in the words the page uses. */
const METHOD_LABEL: Record<string, string> = {
  auto: "auto",
  ai: "AI",
  human: "you",
};

export const REASON_MAX = 500;

/** Any final score can be changed, whatever its method (D-2). */
export function canChange(score: { status: string } | null | undefined): boolean {
  return score?.status === "final";
}

export function methodLabel(method: string): string {
  return METHOD_LABEL[method] ?? method;
}

/** "Now 2 of 4 · auto" — the dialog's line naming what is being replaced. */
export function nowLine(score: {
  points: number;
  max_points: number;
  method: string;
}): string {
  return `Now ${score.points} of ${score.max_points} · ${methodLabel(score.method)}`;
}

/** The queue's step rule: whole points once an item is worth more than one. */
export function pointsStep(max: number): number {
  return max > 1 ? 1 : 0.5;
}

/**
 * Validate the points field: an empty field is "no value", never 0 (the queue
 * learned that the hard way — Number("") === 0). Returns the number or an
 * error sentence.
 */
export function parsePoints(
  raw: string,
  max: number,
): { ok: true; points: number } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: false, error: "Enter a points value." };
  const points = Number(trimmed);
  if (!Number.isFinite(points) || points < 0 || points > max) {
    return { ok: false, error: `Points must be between 0 and ${max}.` };
  }
  return { ok: true, points };
}

/** Plain sentences for the route's refusals. */
export function changeScoreErrorMessage(code: string): string {
  switch (code) {
    case "no_final":
      return "This answer has no final score to change — score it from the queue instead.";
    case "max_points_mismatch":
    case "rubric_bounds":
      return "That score is outside the item's range.";
    case "not_found":
    case "forbidden":
      return "You cannot change this score.";
    case "network":
      return "Couldn't reach the server. Check your connection and try again.";
    default:
      return `That didn't work. Try again, or tell IT this code: ${code}`;
  }
}

/**
 * One "Earlier scores" row's cause: "set aside by pass back", or "changed by
 * teacher to 3 — rubric misread" (the note only when present).
 */
export function causeLine(score: {
  cause: "pass_back" | "changed";
  replaced_by?: { points: number; note?: string };
}): string {
  if (score.cause === "changed" && score.replaced_by) {
    const note = score.replaced_by.note;
    return `changed by teacher to ${score.replaced_by.points}${note ? ` — ${note}` : ""}`;
  }
  return "set aside by pass back";
}

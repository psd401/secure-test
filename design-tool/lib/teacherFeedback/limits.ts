/**
 * Teacher feedback (docs/feedback-release-design.md, D-4 / D-12): the pieces
 * the routes and the comment box share. Pure and import-free on purpose — the
 * box is a client component, so nothing here may pull in `db/` or the write
 * module.
 */

/** The longest comment, in characters. The DB CHECK on both feedback tables
 * says the same; the routes refuse longer text first so the CHECK never fires
 * (a DB error would carry the text in its message — D-14). */
export const TEACHER_FEEDBACK_MAX = 4000;

/** Under every box: feedback is entry-only until the release slices land. */
export const TEACHER_FEEDBACK_HINT = "Not shown to students yet.";

export type FeedbackRequest =
  | { method: "PUT"; body: { text: string } }
  | { method: "DELETE" };

/**
 * What a Save sends. An empty box (or only whitespace) clears the comment
 * rather than saving a blank one — the tables hold no empty rows.
 */
export function feedbackRequest(text: string): FeedbackRequest {
  const trimmed = text.trim();
  return trimmed === "" ? { method: "DELETE" } : { method: "PUT", body: { text: trimmed } };
}

/** The box differs from what was last saved (whitespace at the ends aside). */
export function feedbackIsDirty(text: string, saved: string): boolean {
  return text.trim() !== saved.trim();
}

/** The failure line under the box, by HTTP status and the route's `error`
 * code. The textarea's maxLength makes `invalid_body` rare from the UI; the
 * likely 400 is `attempt_not_submitted` (passed back while the box was open),
 * where retrying cannot help until the student hands it in again. */
export function feedbackFailureMessage(status: number, error?: string): string {
  if (status === 400 && error === "attempt_not_submitted")
    return "Couldn't save — this test was passed back to the student. Save again once it's handed in.";
  if (status === 400) return "Couldn't save that — the comment may be too long. Try again.";
  if (status === 404) return "Couldn't save that — you may not have edit access to this test.";
  return "Couldn't save that. Try again.";
}

export const FEEDBACK_OFFLINE_MESSAGE =
  "Couldn't reach the server. Check your connection and try again.";

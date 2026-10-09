/**
 * "Rescore with current key" wording (docs/rescore-after-key-change-design.md,
 * E11, slice 2). Pure — the control and test/rescore-dialog.test.ts both read
 * it; the repo has no DOM harness, so the words are asserted here.
 */

export interface RescoreQuestionCount {
  position: number;
  changed: number;
  kept: number;
}

export interface RescoreDryRun {
  students_changed: number;
  kept: number;
  questions: RescoreQuestionCount[];
}

export interface RescoreDone {
  written: number;
  students_changed: number;
  sections_sent_before: string[];
  at: string;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The toolbar button: "Rescore with current key (12)". */
export function rescoreButtonLabel(studentsChanged: number): string {
  return `Rescore with current key (${studentsChanged})`;
}

/** Shown on hover over the disabled button. */
export const RESCORE_NOTHING_TITLE = "Every handed-in answer matches the current keys";

/** The dialog's question list: "Q3 — 12 students change". */
export function questionLine(q: RescoreQuestionCount): string {
  const changes = q.changed > 0 ? `${plural(q.changed, "answer changes", "answers change")}` : "";
  const kept =
    q.kept > 0 ? `${plural(q.kept, "score you set stays", "scores you set stay")}` : "";
  return `Q${q.position + 1} — ${[changes, kept].filter(Boolean).join(" · ")}`;
}

/** The dialog's lead sentence. */
export function dryRunSummary(dry: RescoreDryRun): string {
  if (dry.students_changed === 0) return RESCORE_NOTHING_TITLE + ".";
  const lead = `Rescoring changes ${plural(dry.students_changed, "student's score", "students' scores")} with the current answer keys.`;
  const kept =
    dry.kept > 0
      ? ` ${plural(dry.kept, "score you set yourself stays", "scores you set yourself stay")} as ${dry.kept === 1 ? "it is" : "they are"}.`
      : "";
  return lead + kept + " The earlier scores are kept on each student's page.";
}

const TIME = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles",
  hour: "numeric",
  minute: "2-digit",
});

/** The line after a rescore, shown once after the page reloads. */
export function doneLine(done: RescoreDone): string {
  const when = Number.isNaN(Date.parse(done.at)) ? "" : ` · ${TIME.format(new Date(done.at))}`;
  return `Rescored ${plural(done.students_changed, "student", "students")}${when}.`;
}

/** D-3: sections already in the gradebook that now hold a stale score, or null. */
export function sentBeforeLine(sections: readonly string[]): string | null {
  if (sections.length === 0) return null;
  const names =
    sections.length === 1
      ? sections[0]
      : `${sections.slice(0, -1).join(", ")} and ${sections[sections.length - 1]}`;
  return `${names} ${sections.length === 1 ? "was" : "were"} already sent to PowerSchool — send ${sections.length === 1 ? "it" : "them"} again to update.`;
}

/** Route error codes to teacher words. */
export function rescoreErrorMessage(code: string): string {
  if (code === "nothing_to_rescore") return "Nothing to rescore — every answer already matches the current keys. Reload the page.";
  if (code === "not_found") return "This test is no longer available to you.";
  if (code === "network") return "Couldn't reach the server. Check your connection and try again.";
  return "Couldn't rescore. Try again.";
}

/** sessionStorage key carrying the result across the reload. */
export function rescoreDoneKey(assessmentId: string): string {
  return `rescore-done:${assessmentId}`;
}

/**
 * The editor's pointer (D-4): true when a save on a Published item changed
 * its answer key — not when it changed only standards tags, which also save
 * while Published. Compares the key fields of the item types the editor saves
 * while locked; `blanks` is compared whole, because a key-only save leaves
 * everything else in it unchanged.
 */
const KEY_FIELDS = ["correct_choice_ids", "correct_answer", "correct_region_ids", "cell_keys", "blanks"] as const;

export function answerKeyChanged(
  before: Record<string, unknown> | null,
  after: Record<string, unknown>,
): boolean {
  if (!before) return false;
  return KEY_FIELDS.some(
    (k) => JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null),
  );
}

/** The editor line after a key fix on a Published test. */
export const KEY_FIXED_POINTER =
  "If students already handed this in, their scores used the old key.";

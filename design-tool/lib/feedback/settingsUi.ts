// Instant feedback at hand-in (docs/instant-feedback-design.md, slice 2):
// the teacher-facing wording and small rules behind the Settings-tab control
// and the "Release answers" button. Pure and client-safe (no DB / drizzle
// import) so a static-markup test can reach every line.

import { formatDateTime } from "@/lib/ui/format";

export type FeedbackLevelSetting = "off" | "score" | "right_wrong" | "answers";
export type AnswersReleaseSetting = "on_release" | "at_hand_in";

export const FEEDBACK_LEVEL_OPTIONS: readonly {
  value: FeedbackLevelSetting;
  label: string;
  /** The one line shown for the level (D-1). */
  line: string;
}[] = [
  { value: "off", label: "Off", line: "Students see nothing when they hand in." },
  {
    value: "score",
    label: "Score only",
    line: "“You scored 14 of 18 on the questions scored right away. Your teacher will score 2 more.”",
  },
  {
    value: "right_wrong",
    label: "Right / wrong",
    line: "The score plus a ✓ / ✗ / “scored by your teacher” list, with the student’s own answer.",
  },
  {
    value: "answers",
    label: "Correct answers",
    line: "Right / wrong plus the correct answer for each question they missed.",
  },
];

export const ANSWERS_RELEASE_OPTIONS: readonly {
  value: AnswersReleaseSetting;
  label: string;
}[] = [
  { value: "on_release", label: "After I release them" },
  { value: "at_hand_in", label: "At hand-in" },
];

export const FEEDBACK_WHEN_NOTE =
  "Students see this only when they hand in themselves — not when you hand in for them, " +
  "use Hand in everyone, or their time runs out — and not after a pass back.";

export const FEEDBACK_ON_RELEASE_NOTE =
  "Until you press Release answers, students who hand in see right / wrong and are told " +
  "their teacher will go over the correct answers.";

export const RELEASE_CONFIRM_TITLE = "Release answers?";
export const RELEASE_CONFIRM_BODY =
  "Students who hand in from now on will see the correct answers for the questions they missed. " +
  "Students who already handed in will not see them in the app — go over them in class.";

/** The one-line explanation under a level; empty string for an unknown value. */
export function feedbackLevelLine(level: string): string {
  return FEEDBACK_LEVEL_OPTIONS.find((o) => o.value === level)?.line ?? "";
}

/** Is the "Show correct answers" choice relevant? Only at the answers level. */
export function showsAnswersReleaseChoice(level: string): boolean {
  return level === "answers";
}

/**
 * Does the Release answers button belong on screen? Only when the key is held
 * back for a release (answers level + on_release) and has not been released.
 */
export function canReleaseAnswers(
  level: string,
  release: string,
  releasedAt: string | null,
): boolean {
  return level === "answers" && release === "on_release" && releasedAt === null;
}

/** "Answers released Oct 3, 10:40 AM" — the line that replaces the button. */
export function releasedLine(releasedAt: string | Date): string {
  return `Answers released ${formatDateTime(releasedAt)}`;
}

/**
 * Whether to show the released line: once stamped, at the answers level.
 * (A teacher who lowers the level keeps the stamp server-side but has no
 * reason to be told about it.)
 */
export function showsReleasedLine(level: string, releasedAt: string | null): boolean {
  return level === "answers" && releasedAt !== null;
}

/** Plain-language line for a failed Release answers POST. */
export function releaseErrorMessage(code: string): string {
  switch (code) {
    case "not_answers_level":
      return "Set instant feedback to Correct answers first.";
    case "not_found":
    case "forbidden":
      return "You can't release answers for this assessment.";
    case "network":
      return "Couldn't reach the server. Check your connection and try again.";
    default:
      return `That didn't work. Try again, or tell IT this code: ${code}`;
  }
}

/**
 * The body of the settings PATCH. Only the two feedback keys: a Published
 * assessment's lock (`isFeedbackSettingsOnlyPatch`) admits a PATCH whose only
 * changed fields are these, and sending nothing else means nothing else can
 * differ from the stored row.
 */
export function feedbackSettingsBody(
  level: FeedbackLevelSetting,
  release: AnswersReleaseSetting,
): { student_feedback: FeedbackLevelSetting; answers_release: AnswersReleaseSetting } {
  return { student_feedback: level, answers_release: release };
}

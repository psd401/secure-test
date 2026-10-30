// Row GD slice 4 (docs/google-docs-release-design.md): the "Send to Google
// Docs" dialog's pure logic — copy, the summary, and the state saved across
// the Google authorization redirect. Kept out of the component so it is
// tested without a DOM (the repo has no DOM harness).

import type { ReleaseContents } from "@/lib/googleDocs/content";

export interface SendOutcome {
  attempt_id: string;
  name: string;
  status: "sent" | "skipped" | "failed";
  reason?: string;
  url?: string;
  ownership?: "transferred" | "not_transferred";
  ownership_error?: string;
}

export interface DialogState {
  section: string;
  contents: ReleaseContents;
  mode: "skip" | "new";
  includeDrafts: boolean;
  /** Slice 5. */
  transferOwnership: boolean;
  /** RT D-10 (docs/rich-text-essay-design.md): default off. */
  doubleSpace: boolean;
}

/** FR R-2: every box off, the rubric table included. */
export const DEFAULT_CONTENTS: ReleaseContents = {
  prompt: false,
  sources: false,
  teacher_score: false,
  ai_score: false,
  teacher_feedback: false,
  ai_feedback: false,
  rubric_table: false,
};

/** D-2 (and FR D-2 / R-2): the checkbox menu, in the order the dialog shows it. */
export const CONTENT_OPTIONS: Array<{ key: keyof ReleaseContents; label: string }> = [
  { key: "prompt", label: "Prompt" },
  { key: "sources", label: "Sources" },
  { key: "teacher_score", label: "Teacher score" },
  { key: "ai_score", label: "AI score" },
  { key: "teacher_feedback", label: "Teacher feedback" },
  { key: "ai_feedback", label: "AI feedback" },
  { key: "rubric_table", label: "Rubric table" },
];

/**
 * Any saved set of boxes — a `google_doc_releases.contents` row, a remembered
 * choice (FR R-4), a state saved across the Google redirect, an older
 * dialog's post — as today's boxes. A missing or non-boolean key is off.
 * Before FR slice 3 there was one `score` box; where a row has it and not
 * the new keys, it reads as `teacher_score || ai_score` — both ticked.
 */
export function readReleaseContents(raw: unknown): ReleaseContents {
  const contents = { ...DEFAULT_CONTENTS };
  if (!raw || typeof raw !== "object") return contents;
  const v = raw as Record<string, unknown>;
  for (const { key } of CONTENT_OPTIONS) {
    if (typeof v[key] === "boolean") contents[key] = v[key] as boolean;
  }
  if (typeof v.score === "boolean") {
    if (typeof v.teacher_score !== "boolean") contents.teacher_score = v.score;
    if (typeof v.ai_score !== "boolean") contents.ai_score = v.score;
  }
  return contents;
}

const REASONS: Record<string, string> = {
  not_handed_in: "not handed in",
  already_released: "already has a Doc from you",
  safeguarding_alert: "held back — an open safeguarding alert needs your review first",
  no_email: "no school email on the roster",
  // FR D-5: the code keeps its name; short answers count too.
  no_essay: "no essay or short answer written",
  drive_auth_expired: "not sent — Google access expired",
};

export function outcomeReason(o: SendOutcome): string {
  if (!o.reason) return "";
  if (o.status === "failed") return `Google Drive refused (${o.reason})`;
  return REASONS[o.reason] ?? o.reason;
}

/** Slice 5: the line after a sent name when a transfer was asked for. */
export function ownershipNote(o: SendOutcome): string | null {
  if (o.ownership === "transferred") return "owned by the student";
  if (o.ownership === "not_transferred") {
    return `shared, but ownership not transferred (${o.ownership_error ?? "unknown"})`;
  }
  return null;
}

export function summaryLine(outcomes: SendOutcome[]): string {
  const sent = outcomes.filter((o) => o.status === "sent").length;
  const skipped = outcomes.filter((o) => o.status === "skipped").length;
  const failed = outcomes.filter((o) => o.status === "failed").length;
  if (outcomes.length === 0) return "No students in this section have work here yet.";
  const parts = [`${sent} Doc${sent === 1 ? "" : "s"} created and shared`];
  if (skipped > 0) parts.push(`${skipped} skipped`);
  if (failed > 0) parts.push(`${failed} failed`);
  return `${parts.join(" · ")}.`;
}

/** The `?gdrive=` outcome from the authorization callback, in plain words. */
export function authOutcomeCopy(outcome: string): { ok: boolean; text: string } {
  switch (outcome) {
    case "ok":
      return { ok: true, text: "Google Drive is connected. Press Send to continue." };
    case "denied":
      return { ok: false, text: "Google Drive access was not allowed, so nothing was sent." };
    case "wrong_account":
      return {
        ok: false,
        text: "Google signed in with a different account. Send again and choose your district account.",
      };
    default:
      return { ok: false, text: "Connecting to Google Drive did not finish. Press Send to try again." };
  }
}

export function sendErrorCopy(code: string): string {
  switch (code) {
    case "no_essays":
      return "This assessment has no essay or short-answer questions.";
    case "attempt_not_found":
      return "This student's attempt is no longer here.";
    case "not_while_acting_as":
      return "Sending to Google Docs is not available while acting as a teacher.";
    case "network":
      return "Could not reach the server. Check your connection and try again.";
    default:
      return `Something went wrong (${code}). Nothing more was sent.`;
  }
}

export function storageKey(assessmentId: string, attemptId: string | null): string {
  return `gd-send:${assessmentId}:${attemptId ?? "section"}`;
}

/**
 * The state to restore after the authorization redirect. A send that lost
 * its token partway through already made some Docs; restoring it as "skip"
 * keeps the next press from duplicating them.
 */
export function stateToSave(state: DialogState, outcomes: SendOutcome[] | null): DialogState {
  const anySent = (outcomes ?? []).some((o) => o.status === "sent");
  return anySent ? { ...state, mode: "skip" } : state;
}

export function parseSavedState(raw: string | null): DialogState | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<DialogState>;
    if (typeof v.section !== "string") return null;
    if (v.mode !== "skip" && v.mode !== "new") return null;
    if (typeof v.includeDrafts !== "boolean") return null;
    return {
      section: v.section,
      // FR slice 3: a state saved before it carries `score`; read it as both.
      contents: readReleaseContents(v.contents),
      mode: v.mode,
      includeDrafts: v.includeDrafts,
      transferOwnership: v.transferOwnership === true,
      // RT D-10: absent from a state saved before it — off, the default.
      doubleSpace: v.doubleSpace === true,
    };
  } catch {
    return null;
  }
}

/** Where the authorization run sends the teacher back to. */
export function authStartHref(returnPath: string): string {
  return `/api/google/drive/start?next=${encodeURIComponent(returnPath)}`;
}

/** GD D-8 as widened by FR D-5: the item types that go in the Doc. */
export const DOC_ITEM_TYPES = ["essay", "short_text"] as const;

/**
 * Whether a page shows the button: edit level (D-9), never while acting as a
 * teacher (the Drive would be the admin's), and only when the assessment has
 * an essay or a short answer (D-8, widened by FR D-5). The route enforces the
 * first two on its own.
 */
export function canSendToGoogleDocs(input: {
  editLevel: boolean;
  actingAs: boolean;
  itemTypes: string[];
}): boolean {
  return (
    input.editLevel &&
    !input.actingAs &&
    input.itemTypes.some((t) => (DOC_ITEM_TYPES as readonly string[]).includes(t))
  );
}

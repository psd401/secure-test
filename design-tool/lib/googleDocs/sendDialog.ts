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

export const DEFAULT_CONTENTS: ReleaseContents = {
  prompt: false,
  sources: false,
  score: false,
  teacher_feedback: false,
  ai_feedback: false,
};

/** D-2: the checkbox menu, in the order the dialog shows it. */
export const CONTENT_OPTIONS: Array<{ key: keyof ReleaseContents; label: string }> = [
  { key: "prompt", label: "Prompt" },
  { key: "sources", label: "Sources" },
  { key: "score", label: "Score" },
  { key: "teacher_feedback", label: "Teacher feedback" },
  { key: "ai_feedback", label: "AI feedback" },
];

const REASONS: Record<string, string> = {
  not_handed_in: "not handed in",
  already_released: "already has a Doc from you",
  safeguarding_alert: "held back — an open safeguarding alert needs your review first",
  no_email: "no school email on the roster",
  no_essay: "no essay written",
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
      return "This assessment has no essay questions.";
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
    const contents = { ...DEFAULT_CONTENTS };
    for (const { key } of CONTENT_OPTIONS) {
      const flag = (v.contents as Record<string, unknown> | undefined)?.[key];
      if (typeof flag === "boolean") contents[key] = flag;
    }
    return {
      section: v.section,
      contents,
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

/**
 * Whether a page shows the button: edit level (D-9), never while acting as a
 * teacher (the Drive would be the admin's), and only when the assessment has
 * an essay (D-8). The route enforces the first two on its own.
 */
export function canSendToGoogleDocs(input: {
  editLevel: boolean;
  actingAs: boolean;
  itemTypes: string[];
}): boolean {
  return input.editLevel && !input.actingAs && input.itemTypes.includes("essay");
}

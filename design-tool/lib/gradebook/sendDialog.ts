// Send-to-gradebook dialog logic (docs/gradebook-push-design.md, "### UI",
// slice 4). Pure: no React, no DB, no fetch — the dialog component and the
// page both call these, and test/gradebook-send-dialog.test.ts asserts them.
//
// PowerSchool only (slice 3, Schoology, is held). EXTENSION POINT: a
// destination picker would go where `SEND_TARGET` is read; nothing else here
// names a target.
import { levelSatisfies, type AccessLevel } from "@/lib/api/accessLevels";
import { ASSIGNMENT_NAME_MAX, truncateAssignmentName } from "./powerschoolPayloads";
import { HELD_BACK_REASONS, type HeldBackReason, type SendSummary } from "./types";

/** The one destination this slice sends to. */
export const SEND_TARGET = "powerschool" as const;

/** One selectable section in the dialog. Built server-side by the page. */
export interface SendDialogSection {
  ps_id: string;
  label: string;
  /** Submitted attempts with every response scored. */
  scored: number;
  /** Submitted attempts with at least one response awaiting scoring. */
  awaiting: number;
  /** ISO instant of the last send of THIS assessment to THIS section, or null. */
  last_sent_at: string | null;
}

/** Edit level (owner, edit-level co-teacher, admin) — 8.4 confirmed. */
export function canSendToGradebook(level: AccessLevel): boolean {
  return levelSatisfies(level, "edit");
}

/**
 * The button shows only when `GRADEBOOK_PROVIDER` is set explicitly. Unset
 * falls back to the in-memory mock (`getPowerSchoolClient`), which on the
 * origin would report "Sent to PowerSchool" while nothing reached it — so the
 * origin hides the button until it is configured `live`; local dev sets
 * `mock` to hand-run the dialog.
 */
export function gradebookSendConfigured(provider: string | undefined): boolean {
  return provider === "live" || provider === "mock";
}

/** "n scored · m awaiting scoring". */
export function sectionOptionLabel(s: Pick<SendDialogSection, "label" | "scored" | "awaiting">): string {
  return `${s.label} — ${s.scored} scored · ${s.awaiting} awaiting scoring`;
}

const DAY = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles",
  month: "short",
  day: "numeric",
  year: "numeric",
});

/** "Sent to PowerSchool · Sep 28, 2026" once a push exists, else "Send to gradebook". */
export function sendButtonLabel(lastSentAt: string | null): string {
  if (!lastSentAt || Number.isNaN(Date.parse(lastSentAt))) return "Send to gradebook";
  return `Sent to PowerSchool · ${DAY.format(new Date(lastSentAt))}`;
}

/** The secondary line in the dialog once a push exists for the chosen section. */
export function sendAgainNote(lastSentAt: string | null): string | null {
  if (!lastSentAt || Number.isNaN(Date.parse(lastSentAt))) return null;
  return `Already sent on ${DAY.format(new Date(lastSentAt))}. Sending again updates changed scores and skips unchanged ones; the name and due date stay as they are in PowerSchool.`;
}

export interface CategoryOption {
  id: string;
  name: string;
}

/**
 * D-6 / D-5: preselect the remembered category when it is still active, else
 * the route's default (the active district "Test" copy), else NOTHING — the
 * teacher must pick. Never a first-active fallback.
 */
export function chooseCategory(
  categories: readonly CategoryOption[],
  defaultCategoryId: string | null,
  rememberedCategoryId: string | null,
): { selected: string | null; mustPick: boolean } {
  const has = (id: string | null): id is string => id !== null && categories.some((c) => c.id === id);
  if (has(rememberedCategoryId)) return { selected: rememberedCategoryId, mustPick: false };
  if (has(defaultCategoryId)) return { selected: defaultCategoryId, mustPick: false };
  return { selected: null, mustPick: true };
}

/** Send is disabled while loading, without a category, or with a blank name / date. */
export function canSubmitSend(state: {
  loading: boolean;
  busy: boolean;
  sectionPsId: string | null;
  categoryId: string | null;
  name: string;
  dueDate: string;
}): boolean {
  return (
    !state.loading &&
    !state.busy &&
    !!state.sectionPsId &&
    !!state.categoryId &&
    state.name.trim().length > 0 &&
    /^\d{4}-\d{2}-\d{2}$/.test(state.dueDate)
  );
}

/** The default assignment name: the assessment's title, cut to the payload limit. */
export function defaultAssignmentName(title: string): string {
  return truncateAssignmentName(title);
}

export { ASSIGNMENT_NAME_MAX };

/** 8.1: today's LOCAL date as `YYYY-MM-DD` (the browser's clock). */
export function todayLocal(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

const HELD_BACK_COPY: Record<HeldBackReason, (n: number) => string> = {
  unscored: (n) => `${n} awaiting scoring`,
  not_on_roster: (n) => `${n} not linked to the roster`,
  no_dcid: (n) => `${n} without a PowerSchool id yet`,
};

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * The lines shown after a send: one totals line, the held-back reasons (D-3),
 * then the route's own notes (8.3: passed-back and awaiting-scoring students
 * are named separately by the server). Failures are listed separately by the
 * dialog from `summary.failed`.
 */
export function formatSendSummary(
  summary: Pick<SendSummary, "sent" | "updated" | "skipped_unchanged" | "held_back" | "failed" | "notes">,
): string[] {
  const parts: string[] = [];
  if (summary.sent > 0) parts.push(`${summary.sent} sent`);
  if (summary.updated > 0) parts.push(`${summary.updated} updated`);
  if (summary.skipped_unchanged > 0) parts.push(`${summary.skipped_unchanged} unchanged`);
  if (summary.held_back.count > 0) parts.push(`${summary.held_back.count} held back`);
  if (summary.failed.length > 0) parts.push(`${summary.failed.length} failed`);
  const lines: string[] = [
    parts.length > 0 ? `${parts.join(" · ")}.` : "Nothing to send: no fully scored work in this section.",
  ];
  if (summary.held_back.count > 0) {
    const reasons = HELD_BACK_REASONS.filter((r) => summary.held_back.reasons[r] > 0).map((r) =>
      HELD_BACK_COPY[r](summary.held_back.reasons[r]),
    );
    lines.push(`Held back, not sent: ${reasons.join("; ")}. A later send picks them up.`);
  }
  for (const note of summary.notes) lines.push(note);
  return lines;
}

/** One failure row: "<student number>: <reason>", the reason in teacher words where known. */
export function formatFailure(f: { student_number: string; reason: string }): string {
  const reason =
    f.reason === "assignment_missing"
      ? "the assignment is missing in PowerSchool"
      : f.reason === "not_in_powerschool_section"
        ? "not on this class in PowerSchool (left the class?)"
        : f.reason === "network_error"
          ? "could not reach PowerSchool"
          : /^http_\d+$/.test(f.reason)
            ? `PowerSchool refused it (${f.reason.replace("http_", "HTTP ")})`
            : f.reason;
  return `${f.student_number}: ${reason}`;
}

/** Route error code (+ optional 409 detail) -> a plain teacher-facing sentence. */
export function sendErrorCopy(code: string, detail?: unknown): string {
  switch (code) {
    case "gradebook_not_configured":
      return "The gradebook connection is not set up on this server yet. Tell IT.";
    case "missing_dcid": {
      const missing =
        detail && typeof detail === "object" && Array.isArray((detail as { missing?: unknown }).missing)
          ? ((detail as { missing: unknown[] }).missing as string[])
          : [];
      const teacherSide = missing.includes("users_dcid");
      return teacherSide
        ? "PowerSchool does not have an id on file for you yet, so nothing can be sent. The roster brings it in overnight; if it stays missing, tell IT."
        : "This section has no PowerSchool ids yet. The roster brings them in overnight; if they stay missing, tell IT.";
    }
    case "send_in_progress":
      return "A send for this section is already running. Wait a minute, then try again.";
    case "create_response_unreadable":
      return "PowerSchool may have created the assignment but did not say so. Check the gradebook for a duplicate before sending again.";
    case "create_failed":
      return "PowerSchool refused to create the assignment.";
    case "gradebook_unavailable":
      return "PowerSchool could not be reached. Try again in a few minutes.";
    case "unknown_category":
      return "That category is not available. Pick another one.";
    case "no_points":
      return "This assessment has no points to send.";
    case "not_found":
    case "forbidden":
      return "You cannot send this section to the gradebook.";
    case "invalid_body":
    case "invalid_query":
      return "That send was not valid. Check the fields and try again.";
    case "unsupported_target":
      return "That gradebook is not available yet.";
    case "network":
      return "Couldn't reach the server. Check your connection and try again.";
    default:
      return `That didn't work. Try again, or tell IT this code: ${code}`;
  }
}

// R1 (docs/reporting-design.md): the integrity timeline — `attempt_events`
// turned into the plain words a teacher reads on the per-student page.
//
// Pure: rows in, lines out. No DB, no React, no request context, so the
// print view (R2) can render the same sentences from the same rows.
//
// Two rules the monitor does not have to care about and this does:
//   - a focus_loss and the focus_regained that follows it are ONE line, with
//     the gap spelled out. A teacher reading a column of "Left the test
//     window" / "Back in the test" pairs has to do that arithmetic by hand.
//   - a focus_loss with no regain after it says so explicitly rather than
//     trailing off — "did not return before handing in" is the finding.
//
// Times are the district's (America/Los_Angeles, via lib/ui/format), the
// same clock every other teacher-facing date on this app is rendered in.

import { eventLabel } from "@/app/dashboard/[id]/attendanceView";
import { formatTime, formatWhen } from "@/lib/ui/format";

export interface TimelineEvent {
  at: string;
  kind: string;
  detail?: Record<string, unknown> | null;
}

export interface TimelineLine {
  /** The instant the line is anchored at (the FIRST event of a pair). */
  at: string;
  /** The kind that opened the line — for a paired focus gap, `focus_loss`. */
  kind: string;
  text: string;
}

/** "45 sec" / "1 min" / "12 min". Rounds to the nearest minute above 60 s. */
export function durationLabel(ms: number): string {
  const secs = Math.max(0, Math.round(ms / 1000));
  if (secs < 60) return `${secs} sec`;
  return `${Math.round(secs / 60)} min`;
}

function clientErrorText(detail: Record<string, unknown> | null | undefined): string {
  // The write route normalises client_error detail to { kind, message }; the
  // kind is the machine-shaped half and the only part short enough for a
  // timeline line. The message stays in the row for whoever reads the table.
  const kind = typeof detail?.kind === "string" && detail.kind ? detail.kind : "unknown";
  return `The app hit a problem: ${kind}`;
}

/**
 * Speech-to-text (docs/speech-tools-design.md §Progress, 2026-10-01): the
 * pre-flight's outcome in a teacher's words. The events route stores only
 * `{ outcome, step? }` from closed lists; anything unreadable says
 * "unavailable" plainly rather than guessing a cause.
 */
export function speechPreflightText(detail: Record<string, unknown> | null | undefined): string {
  const outcome = detail?.outcome;
  const step = detail?.step;
  if (outcome === "ready") return "Speech-to-text ready";
  const prefix = "Speech-to-text unavailable";
  if (outcome === "denied") {
    if (step === "microphone") return `${prefix} — microphone permission denied`;
    if (step === "recognition") return `${prefix} — speech recognition permission denied`;
    return `${prefix} — permission denied`;
  }
  if (outcome === "timed_out") return `${prefix} — timed out while preparing`;
  if (outcome === "unavailable" && step === "assets")
    return `${prefix} — could not finish setting up on this Mac`;
  if (outcome === "unavailable") return `${prefix} — not supported on this Mac`;
  return prefix;
}

/** The one-event sentences. Unknown kinds fall back to the monitor's label. */
function lineText(event: TimelineEvent): string {
  switch (event.kind) {
    case "lockdown_begin":
      return "Secure session started";
    case "lockdown_end":
      return "Secure session ended";
    case "emergency_exit":
      return "Secure session ended by the student";
    case "quit":
      return "Quit the app";
    case "focus_regained":
      // Only reached for a regain with no loss before it (an event the client
      // sent after a loss we never received, or the first event of the row).
      return "Back in the test";
    case "client_error":
      return clientErrorText(event.detail);
    case "speech_preflight":
      return speechPreflightText(event.detail);
    case "deadline_extended":
      // Remove time limit (2026-09-24): the same event kind carries the
      // teacher's "No time limit" as `detail.no_limit`. It has no `ends_at`,
      // so `lineSuffix` adds nothing and the line is the fact alone.
      return event.detail?.no_limit === true
        ? "Time limit removed by teacher"
        : eventLabel(event.kind);
    case "gradebook_sent":
      // Gradebook push slice 4: PowerSchool is the only destination so far;
      // the points ride on `lineSuffix`.
      return event.detail?.target === "schoology" ? "Sent to Schoology" : "Sent to PowerSchool";
    case "score_changed":
      // E11 (docs/rescore-after-key-change-design.md): the same kind carries
      // "Rescore with current key" as `detail.source = "rescore"`.
      return event.detail?.source === "rescore"
        ? "Rescored with the updated key"
        : eventLabel(event.kind);
    case "lockdown_failed":
    case "lockdown_interrupted":
      // The monitor's words, deliberately shared rather than re-typed.
      return eventLabel(event.kind);
    default:
      return eventLabel(event.kind);
  }
}

/**
 * What follows the event's own time on the line, or "".
 *
 * Only `deadline_extended` and `passed_back` have any: "Time adjusted by teacher
 * 2:14 PM · new deadline 3:00 PM". The instant matters more than the fact here —
 * a teacher reading this months later wants to know what the student was given,
 * and a line that said only "extended" would send them to the events table for
 * it. A pass back on an UNLIMITED assessment writes `ends_at: null`, so it gets
 * the bare sentence; so does a row written without the detail (or with a
 * nonsense value), rather than printing "Invalid Date". A deadline on a
 * different day from the event carries its date (E-1, 2026-09-22): "new
 * deadline Sep 23, 11:59 PM", not a bare "11:59 PM" that reads as tonight.
 */
const KINDS_WITH_DEADLINE: ReadonlySet<string> = new Set([
  "deadline_extended",
  "passed_back",
]);

/** A finite number, or null — for detail fields written by our own routes. */
function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function lineSuffix(event: TimelineEvent): string {
  if (event.kind === "score_changed") {
    // Change a final score (docs/change-score-design.md): "· 2 → 3 of 4". The
    // timeline's inputs carry no item numbering (events only), so the question
    // is not named here; the per-student page lists the scores beside it. A row
    // without usable numbers gets the bare sentence.
    const from = finiteNumber(event.detail?.from);
    const to = finiteNumber(event.detail?.to);
    const max = finiteNumber(event.detail?.max);
    // A rescore that scored a never-scored answer has no `from`.
    if (from === null && to !== null && event.detail?.source === "rescore") {
      return ` · scored ${to}${max === null ? "" : ` of ${max}`}`;
    }
    if (from === null || to === null) return "";
    return ` · ${from} → ${to}${max === null ? "" : ` of ${max}`}`;
  }
  if (event.kind === "feedback_shown") {
    // Instant feedback (docs/instant-feedback-design.md, D-5): what the
    // student was shown — "· 14 of 18 (answers shown)". A row without usable
    // numbers gets the bare sentence.
    const earned = finiteNumber(event.detail?.earned);
    const max = finiteNumber(event.detail?.max_auto);
    if (earned === null || max === null) return "";
    return ` · ${earned} of ${max}${event.detail?.answers_shown === true ? " (answers shown)" : ""}`;
  }
  if (event.kind === "gradebook_sent") {
    const points = event.detail?.points;
    if (typeof points !== "number" || !Number.isFinite(points)) return "";
    return ` · ${points} ${points === 1 ? "point" : "points"}`;
  }
  if (!KINDS_WITH_DEADLINE.has(event.kind)) return "";
  const endsAt = event.detail?.ends_at;
  if (typeof endsAt !== "string" || Number.isNaN(Date.parse(endsAt))) return "";
  return ` · new deadline ${formatWhen(endsAt, new Date(event.at))}`;
}

/**
 * Order-independent: events are sorted by `at` before pairing, so a caller
 * that hands over rows in any order still gets a chronological timeline.
 */
export function buildTimeline(events: TimelineEvent[]): TimelineLine[] {
  const sorted = [...events].sort(
    (a, b) => new Date(a.at).getTime() - new Date(b.at).getTime(),
  );
  const lines: TimelineLine[] = [];
  const consumed = new Set<number>();

  for (let i = 0; i < sorted.length; i++) {
    if (consumed.has(i)) continue;
    const event = sorted[i]!;
    if (event.kind !== "focus_loss") {
      lines.push({
        at: event.at,
        kind: event.kind,
        text: `${lineText(event)} ${formatTime(event.at)}${lineSuffix(event)}`,
      });
      continue;
    }
    // Pair with the NEXT focus_regained, and only that one — a second loss
    // before it would have claimed its own regain on an earlier pass, so the
    // first unconsumed regain after this loss is the right partner.
    let regainAt: string | null = null;
    for (let j = i + 1; j < sorted.length; j++) {
      if (consumed.has(j)) continue;
      if (sorted[j]!.kind !== "focus_regained") continue;
      regainAt = sorted[j]!.at;
      consumed.add(j);
      break;
    }
    if (regainAt === null) {
      lines.push({
        at: event.at,
        kind: event.kind,
        text: `Left the test window ${formatTime(event.at)} · did not return before handing in`,
      });
      continue;
    }
    const gap = new Date(regainAt).getTime() - new Date(event.at).getTime();
    lines.push({
      at: event.at,
      kind: event.kind,
      text:
        `Left the test window ${formatTime(event.at)} · back ${formatTime(regainAt)}` +
        ` (${durationLabel(gap)})`,
    });
  }

  return lines;
}

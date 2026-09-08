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
import { formatTime } from "@/lib/ui/format";

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
    case "lockdown_failed":
    case "lockdown_interrupted":
      // The monitor's words, deliberately shared rather than re-typed.
      return eventLabel(event.kind);
    default:
      return eventLabel(event.kind);
  }
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
      lines.push({ at: event.at, kind: event.kind, text: `${lineText(event)} ${formatTime(event.at)}` });
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

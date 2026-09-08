/**
 * R2 print report (docs/reporting-design.md): the integrity line on a
 * student's page — the attempt's `attempt_events` counted by kind and said in
 * plain words, because a teacher handing this to a family cannot be asked to
 * read `lockdown_interrupted`.
 *
 * Deliberately a PURE formatter over `{ kind }` records: no db import, no
 * route, no dependency on R1's `timeline.ts` (which is a per-event, timestamped
 * view for the teacher's own screen — a different thing that happens to read
 * the same table). The page does the owner-scoped query and hands the kinds in.
 *
 * P5-2 (docs/design-tool-manual-checks.md, row R2-P3): the wording here used
 * to contradict `timeline.ts` — `lockdown_end` read "ended by the student"
 * (that is `emergency_exit`'s line) and `quit` said "Quit the test" instead
 * of "Quit the app". Brought into agreement; `lockdown_failed` /
 * `lockdown_interrupted` import the monitor's own words (`eventLabel`) the
 * same way `timeline.ts` does, rather than keeping a second copy of them.
 */

import { eventLabel } from "@/app/dashboard/[id]/attendanceView";

/** Singular phrasing; a count > 1 gets " N times" appended. */
const PHRASES: Record<string, string> = {
  quit: "Quit the app",
  emergency_exit: "Secure session ended by the student",
  focus_loss: "Left the test window",
  lockdown_begin: "Secure session started",
  lockdown_end: "Secure session ended",
  lockdown_failed: eventLabel("lockdown_failed"),
  lockdown_interrupted: eventLabel("lockdown_interrupted"),
  client_error: "The app hit a problem",
};

/**
 * Fixed reading order, so two students' lines are comparable at a glance.
 * `focus_regained` is deliberately absent: it only duplicates the
 * `focus_loss` count (P5-2), but a caller may still hand one in (a schema
 * value this formatter tolerates in input, per `integrityPhrases` below).
 * A kind not listed here (a future schema value on an old build) still shows,
 * after these, under its raw name rather than being silently dropped.
 */
const KIND_ORDER = [
  "lockdown_begin",
  "lockdown_failed",
  "lockdown_interrupted",
  "focus_loss",
  "emergency_exit",
  "quit",
  "lockdown_end",
  "client_error",
];

export const NO_EVENTS = "No integrity events";

export function countByKind(
  events: ReadonlyArray<{ kind: string }>,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const e of events) counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1);
  return counts;
}

/** One phrase per kind present, e.g. `Left the test window 2 times`. */
export function integrityPhrases(
  events: ReadonlyArray<{ kind: string }>,
): string[] {
  const counts = countByKind(events);
  // P5-2: focus_regained is tolerated (counted, never throws) but never
  // printed — it only duplicates the paired focus_loss count.
  const kinds = [...counts.keys()]
    .filter((kind) => kind !== "focus_regained")
    .sort((a, b) => {
      const ia = KIND_ORDER.indexOf(a);
      const ib = KIND_ORDER.indexOf(b);
      // Unknown kinds (-1) sort last, then alphabetically among themselves.
      if (ia === -1 && ib === -1) return a < b ? -1 : a > b ? 1 : 0;
      if (ia === -1) return 1;
      if (ib === -1) return -1;
      return ia - ib;
    });
  return kinds.map((kind) => {
    const count = counts.get(kind)!;
    const phrase = PHRASES[kind] ?? kind;
    return count === 1 ? phrase : `${phrase} ${count} times`;
  });
}

/** The whole line, `NO_EVENTS` when the attempt recorded nothing. */
export function formatIntegrityLine(
  events: ReadonlyArray<{ kind: string }>,
): string {
  const phrases = integrityPhrases(events);
  return phrases.length === 0 ? NO_EVENTS : phrases.join(" · ");
}

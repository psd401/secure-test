/**
 * The district's time zone, in one place.
 *
 * Every date and time a teacher reads (lib/ui/format, the gradebook and
 * Google Docs stamps, the rescore and attendance lines) and every one a
 * teacher types (the deadline and due-date pickers) is in this zone — not the
 * device's. A teacher whose computer is set elsewhere (travel, a
 * misconfigured Mac) would otherwise type "2:30" and see a different hour
 * shown back. A deployment in another zone changes this one constant.
 *
 * Client-safe: no server imports.
 */
export const DISPLAY_TIME_ZONE = "America/Los_Angeles";

const PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: DISPLAY_TIME_ZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

type Wall = { y: number; mo: number; d: number; h: number; mi: number; s: number };

function wallAt(instant: Date): Wall {
  const p: Record<string, string> = {};
  for (const part of PARTS.formatToParts(instant)) p[part.type] = part.value;
  return { y: +p.year!, mo: +p.month!, d: +p.day!, h: +p.hour! % 24, mi: +p.minute!, s: +p.second! };
}

/** The zone's offset from UTC at `ms`, in ms (Pacific: −7 h or −8 h). */
function offsetAt(ms: number): number {
  const w = wallAt(new Date(ms));
  return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s) - Math.floor(ms / 1000) * 1000;
}

const pad = (n: number) => String(n).padStart(2, "0");
const WALL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

/**
 * A wall time typed in a `datetime-local` shape ("YYYY-MM-DDTHH:mm", seconds
 * optional), read in DISPLAY_TIME_ZONE, as an ISO instant. `null` when empty,
 * malformed, or not a real calendar day (2026-02-31) — the caller treats that
 * as "nothing to submit".
 *
 * Two passes because the offset can differ either side of a DST change. A
 * time that does not exist (the spring-forward gap) lands an hour later, as
 * a browser reading local time does. A time that occurs twice (the
 * fall-back hour) resolves to the earlier one, still on daylight time.
 */
export function zonedWallTimeToIso(value: string): string | null {
  const m = WALL.exec(value.trim());
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map((v) => (v === undefined ? 0 : Number(v))) as number[];
  if (mo! < 1 || mo! > 12 || d! < 1 || d! > 31 || h! > 23 || mi! > 59 || s! > 59) return null;
  const asUtc = Date.UTC(y!, mo! - 1, d!, h!, mi!, s!);
  // Date.UTC rolls an impossible day forward (Feb 31 → Mar 3); refuse it.
  if (new Date(asUtc).getUTCDate() !== d) return null;
  const first = asUtc - offsetAt(asUtc);
  const second = asUtc - offsetAt(first);
  const w = wallAt(new Date(second));
  // In the gap neither pass shows the typed time; the later one is the
  // typed time plus the hour that was skipped.
  const ms = w.h === h && w.mi === mi ? second : Math.max(first, second);
  return new Date(ms).toISOString();
}

/** Today's date in DISPLAY_TIME_ZONE, `YYYY-MM-DD`. */
export function todayInZone(now: Date = new Date()): string {
  const w = wallAt(now);
  return `${w.y}-${pad(w.mo)}-${pad(w.d)}`;
}

/** `YYYY-MM-DD` plus `n` calendar days (no zone involved). */
export function addDays(day: string, n: number): string {
  const [y, mo, d] = day.split("-").map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, mo - 1, d + n));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

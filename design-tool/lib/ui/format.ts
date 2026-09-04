/**
 * UX pass 1 (docs/ux-pass-1-proposal.md §2.3): the few date/time shapes a
 * teacher reads, formatted once, in the district's time zone. Nothing here
 * shows seconds; nothing shows a date when "today" is enough.
 */

const TZ = "America/Los_Angeles";

const DATE = new Intl.DateTimeFormat("en-US", { timeZone: TZ, dateStyle: "medium" });
const TIME = new Intl.DateTimeFormat("en-US", { timeZone: TZ, timeStyle: "short" });
const DATE_TIME = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ,
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});
const DAY_KEY = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, dateStyle: "short" });

function toDate(value: string | Date): Date {
  return value instanceof Date ? value : new Date(value);
}

/** "Aug 29, 2026" */
export function formatDate(value: string | Date): string {
  return DATE.format(toDate(value));
}

/** "10:40 AM" */
export function formatTime(value: string | Date): string {
  return TIME.format(toDate(value));
}

/**
 * "10:40 AM" when the instant falls on today's calendar date (Pacific),
 * otherwise "Sep 2, 10:40 AM". `now` is injectable for tests.
 */
export function formatWhen(value: string | Date, now: Date = new Date()): string {
  const d = toDate(value);
  return DAY_KEY.format(d) === DAY_KEY.format(now) ? TIME.format(d) : DATE_TIME.format(d);
}

/** "Closes at 10:40 AM" / "Closes Sep 2, 10:40 AM" */
export function closesAt(value: string | Date, now: Date = new Date()): string {
  const d = toDate(value);
  const today = DAY_KEY.format(d) === DAY_KEY.format(now);
  return today ? `Closes at ${TIME.format(d)}` : `Closes ${DATE_TIME.format(d)}`;
}

/** "3 questions" / "1 question" */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** One rule for what to call a student on screen: name, else SSID, else student number. */
export function studentHeading(s: {
  name: string | null;
  ssid: string | null;
  roster_ps_id?: string | null;
}): string {
  if (s.name && s.name.trim()) return s.name.trim();
  if (s.ssid) return `SSID ${s.ssid}`;
  if (s.roster_ps_id) return `Student ${s.roster_ps_id}`;
  return "Unnamed student";
}

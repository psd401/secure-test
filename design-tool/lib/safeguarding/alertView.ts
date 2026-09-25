// Safeguarding alerts slice 2 (docs/safeguarding-alerts-design.md): the pure
// half of the teacher and admin surfaces — wording, counts and the open / all
// filter. No DB and no React here, so the client leaves (the scoring queue,
// the Monitor) and the server pages read the same rules, and the tests can
// assert them without a DOM.

/** What every alert surface needs to know about one alert. */
export interface AlertLike {
  kind: string;
  category: string;
  acknowledged_at: string | Date | null;
}

const HEADINGS: Record<string, string> = {
  suicidal_ideation: "Possible suicidal thoughts",
  self_harm: "Possible self-harm",
  abuse: "Possible abuse",
  prompt_injection: "Possible attempt to instruct the AI scorer",
};

/**
 * The card heading for a category. Worded as a possibility on purpose: the
 * check is automated and a teacher reads it before anything else on the card.
 * An unknown category (a value added later without this map) still gets a
 * heading rather than a blank.
 */
export function alertHeading(category: string): string {
  return HEADINGS[category] ?? "Possible safeguarding concern";
}

/** Open = nobody has acknowledged it yet. The badge counts only these. */
export function isOpenAlert(alert: Pick<AlertLike, "acknowledged_at">): boolean {
  return alert.acknowledged_at === null;
}

/**
 * The badge's number: open alerts of EITHER kind. A wellbeing disclosure and a
 * prompt-injection attempt both need a teacher to read the answer, so the
 * badge does not rank them; the panel's headings tell them apart.
 */
export function openAlertCount(alerts: ReadonlyArray<Pick<AlertLike, "acknowledged_at">>): number {
  return alerts.filter(isOpenAlert).length;
}

/**
 * The badge's text: "Needs attention", with the count only when there is more
 * than one — "Needs attention (1)" says nothing the badge's presence does not.
 * Null when there is nothing to show, so a caller renders nothing.
 */
export function badgeLabel(count: number): string | null {
  if (count <= 0) return null;
  return count > 1 ? `Needs attention (${count})` : "Needs attention";
}

/** `?open=1` (and only that) means unacknowledged only; anything else is all. */
export function parseOpenOnly(raw: string | string[] | null | undefined): boolean {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value === "1";
}

/** The open / all filter both lists and both routes apply. */
export function filterAlerts<T extends Pick<AlertLike, "acknowledged_at">>(
  alerts: readonly T[],
  openOnly: boolean,
): T[] {
  return openOnly ? alerts.filter(isOpenAlert) : [...alerts];
}

/**
 * The one sentence shown under every alert panel. Plain on purpose: no
 * hotline numbers or policy names in code — those are the district's to keep
 * current, not a deploy's.
 */
export const ALERT_DISCLAIMER =
  "This check is automated and can miss things or flag things by mistake. It does not replace reading the student's work. Follow the district's procedures for student safety concerns.";

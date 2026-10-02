// Pure helpers for standards tags on items (docs/batch-item-generation-design.md,
// BG slice 2, D-1). Safe to import from a client component: it never touches the
// catalog JSON — lookups go through /api/standards (lib/standards/search.ts).
import type { StandardScheme } from "./types";

export const MAX_STANDARDS = 10;
export const MAX_STANDARD_LENGTH = 80;

/** Mirrors SCHEMES in ./catalog.ts without importing the catalog. */
const KNOWN_SCHEMES: readonly StandardScheme[] = ["wa2026", "ccss2010", "ngss"];

/** Trim, drop empties, dedupe keeping the first occurrence. Limits are the caller's. */
export function normalizeStandards(tags: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of tags) {
    const tag = raw.trim();
    if (tag && !out.includes(tag)) out.push(tag);
  }
  return out;
}

/** The catalog scheme a stored tag names, or null for a teacher's own designation. */
export function tagScheme(tag: string): StandardScheme | null {
  const i = tag.indexOf(":");
  if (i <= 0) return null;
  const scheme = tag.slice(0, i) as StandardScheme;
  return KNOWN_SCHEMES.includes(scheme) ? scheme : null;
}

/** How a scheme reads to a teacher: the counterpart line says "2011: 7.RP.A.2". */
export function schemeLabel(scheme: StandardScheme): string {
  return scheme === "wa2026" ? "2026" : scheme === "ccss2010" ? "2011" : "NGSS";
}

export function shortText(text: string, max = 60): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

export type ChipLabel = { code: string; text: string | null; title: string };

/**
 * What a chip shows. A tag the catalog knows reads as its code (no scheme
 * prefix) plus a short text, with the full text as the tooltip. Anything else
 * — a custom designation, an unknown scheme, a code this catalog version does
 * not have — shows exactly as stored.
 */
export function chipLabel(
  tag: string,
  entry: { code: string; text: string } | null | undefined,
): ChipLabel {
  if (!entry) return { code: tag, text: null, title: tag };
  return { code: entry.code, text: shortText(entry.text), title: `${entry.code} — ${entry.text}` };
}

/** The second line of a picker result: "2011: 7.RP.A.2" (several links joined). */
export function counterpartLine(
  counterparts: readonly { code: string; scheme: StandardScheme }[],
): string | null {
  if (counterparts.length === 0) return null;
  return `${schemeLabel(counterparts[0]!.scheme)}: ${counterparts.map((c) => c.code).join(", ")}`;
}

export type AddTagResult = { ok: true; next: string[] } | { ok: false; error: string };

/** Add one tag under the server's rules, so the editor never sends a body that 400s. */
export function addTag(current: readonly string[], raw: string): AddTagResult {
  const tag = raw.trim();
  if (!tag) return { ok: false, error: "Type a standard or pick one from the list." };
  if (current.includes(tag)) return { ok: true, next: [...current] };
  if (current.length >= MAX_STANDARDS) {
    return { ok: false, error: `An item can carry at most ${MAX_STANDARDS} standards.` };
  }
  if (tag.length > MAX_STANDARD_LENGTH) {
    return { ok: false, error: `A standard can be at most ${MAX_STANDARD_LENGTH} characters.` };
  }
  return { ok: true, next: [...current, tag] };
}

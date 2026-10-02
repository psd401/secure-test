// Server-only shaping for /api/standards and /api/standards/lookup (BG slice 2,
// docs/batch-item-generation-design.md §Standards tags, §Crosswalk). Imports the
// catalog (~990 KB of JSON), so it must never reach a client component —
// test/standards-api.test.ts greps for that.
import {
  counterparts,
  courses,
  findByBareCode,
  gradeBands,
  lookup,
  search,
  tagFor,
  type StandardEntry,
  type StandardScheme,
  type StandardSubject,
} from "./catalog";

export const SEARCH_LIMIT_DEFAULT = 20;
export const SEARCH_LIMIT_MAX = 50;
export const LOOKUP_MAX_TAGS = 20;

export const SUBJECTS: readonly StandardSubject[] = ["math", "ela", "science"];
export const SCHEMES: readonly StandardScheme[] = ["wa2026", "ccss2010", "ngss"];

export type StandardResult = {
  tag: string;
  scheme: StandardScheme;
  code: string;
  subject: StandardSubject;
  grade_band: string;
  domain: string;
  text: string;
  counterparts: { tag: string; code: string; scheme: StandardScheme }[];
};

export type SearchParams = {
  q: string;
  subject?: StandardSubject;
  gradeBand?: string;
  /** Filter: only this scheme. */
  scheme?: StandardScheme;
  /** Order: this scheme first (D-1c's 2011 / 2026 preference). */
  prefer?: StandardScheme;
  course?: string;
  limit?: number;
};

function toResult(e: StandardEntry): StandardResult {
  return {
    tag: tagFor(e),
    scheme: e.scheme,
    code: e.code,
    subject: e.subject,
    grade_band: e.grade_band,
    domain: e.domain,
    text: e.text,
    counterparts: counterparts(tagFor(e)).map((c) => ({
      tag: tagFor(c),
      code: c.code,
      scheme: c.scheme,
    })),
  };
}

/** Same tiers as catalog.search: exact code, code prefix, code substring, text. */
function tier(e: StandardEntry, q: string): number {
  if (!q) return 3;
  const code = e.code.toLowerCase();
  if (code === q) return 0;
  if (code.startsWith(q)) return 1;
  if (code.includes(q)) return 2;
  return 3;
}

/**
 * catalog.search plus the scheme preference: a hit in the other scheme brings
 * its linked entries in the preferred scheme along at the same rank (typing
 * `7.RP.A.2` with 2026 preferred lists M.7.R.RP.2 first), and within a rank the
 * preferred scheme (and NGSS, which has no counterpart) comes first.
 */
export function searchStandards(p: SearchParams): StandardResult[] {
  const q = p.q.trim().toLowerCase();
  const limit = Math.min(Math.max(1, p.limit ?? SEARCH_LIMIT_DEFAULT), SEARCH_LIMIT_MAX);
  const hits = search(p.q, {
    subject: p.subject,
    gradeBand: p.gradeBand,
    scheme: p.scheme,
    course: p.course,
    limit: Number.MAX_SAFE_INTEGER,
  });
  const passes = (e: StandardEntry) =>
    (!p.subject || e.subject === p.subject) &&
    (!p.gradeBand || e.grade_band === p.gradeBand) &&
    (!p.scheme || e.scheme === p.scheme) &&
    (!p.course || e.courses?.some((c) => c.course === p.course) === true);

  const seen = new Map<string, { entry: StandardEntry; rank: number; order: number }>();
  let order = 0;
  const add = (entry: StandardEntry, rank: number) => {
    const key = tagFor(entry);
    const prior = seen.get(key);
    if (!prior) seen.set(key, { entry, rank, order: order++ });
    else if (rank < prior.rank) prior.rank = rank;
  };
  for (const e of hits) {
    const rank = tier(e, q);
    if (p.prefer && e.scheme !== p.prefer && e.scheme !== "ngss") {
      for (const c of counterparts(tagFor(e))) if (passes(c)) add(c, rank);
    }
    add(e, rank);
  }
  const group = (e: StandardEntry) =>
    !p.prefer || e.scheme === p.prefer || e.scheme === "ngss" ? 0 : 1;
  return [...seen.values()]
    .sort((a, b) => a.rank - b.rank || group(a.entry) - group(b.entry) || a.order - b.order)
    .slice(0, limit)
    .map((r) => toResult(r.entry));
}

/**
 * A custom entry that exactly matches a catalog code is treated as that code
 * (D-1, "Custom designation"): the tag when the code exists in exactly one
 * scheme, else null (no match, or ambiguous across schemes — kept as typed).
 */
export function resolveBareCode(text: string): string | null {
  const matches = findByBareCode(text);
  return matches.length === 1 ? tagFor(matches[0]!) : null;
}

export type LookupEntry = { code: string; scheme: StandardScheme; text: string } | null;

/** Chip data for stored tags; null for anything the catalog does not know. */
export function lookupTags(tags: readonly string[]): Record<string, LookupEntry> {
  const out: Record<string, LookupEntry> = {};
  for (const tag of tags) {
    const e = lookup(tag);
    out[tag] = e ? { code: e.code, scheme: e.scheme, text: e.text } : null;
  }
  return out;
}

/** The picker's filter options, read from the catalog so they never drift. */
export const FACETS = {
  grade_bands: Object.fromEntries(SUBJECTS.map((s) => [s, gradeBands(s)])) as Record<
    StandardSubject,
    string[]
  >,
  courses: courses(),
};

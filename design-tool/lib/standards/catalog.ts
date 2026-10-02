// Lookup over the shipped standards catalog (docs/batch-item-generation-design.md
// §Standards tags, §Crosswalk). The JSON is built by scripts/build-standards.ts
// from OSPI's workbooks; this module never reads a file at runtime.
import catalogJson from "./catalog.json";
import crosswalkJson from "./crosswalk.json";
import type {
  CrosswalkPair,
  StandardEntry,
  StandardScheme,
  StandardSubject,
} from "./types";

export type { CrosswalkPair, StandardCourse, StandardEntry, StandardScheme, StandardSubject } from "./types";

const CATALOG = catalogJson as StandardEntry[];
const CROSSWALK = crosswalkJson as CrosswalkPair[];

const SCHEMES: readonly StandardScheme[] = ["wa2026", "ccss2010", "ngss"];

export type ParsedTag = { scheme: StandardScheme; code: string } | { custom: string };

const byTag = new Map<string, StandardEntry>();
const byCode = new Map<string, StandardEntry[]>();
for (const e of CATALOG) {
  byTag.set(tagFor(e), e);
  const list = byCode.get(e.code);
  if (list) list.push(e);
  else byCode.set(e.code, [e]);
}

const toWa = new Map<string, string[]>(); // ccss2010 code -> wa2026 codes
const toCcss = new Map<string, string[]>(); // wa2026 code -> ccss2010 codes
for (const p of CROSSWALK) {
  const a = toWa.get(p.ccss2010);
  if (a) a.push(p.wa2026);
  else toWa.set(p.ccss2010, [p.wa2026]);
  const b = toCcss.get(p.wa2026);
  if (b) b.push(p.ccss2010);
  else toCcss.set(p.wa2026, [p.ccss2010]);
}

/** The stored form of a picked entry: "wa2026:M.7.R.RP.2". */
export function tagFor(entry: Pick<StandardEntry, "scheme" | "code">): string {
  return `${entry.scheme}:${entry.code}`;
}

/** A string without a known scheme prefix is a teacher's own designation. */
export function parseTag(tag: string): ParsedTag {
  const i = tag.indexOf(":");
  if (i > 0) {
    const scheme = tag.slice(0, i) as StandardScheme;
    if (SCHEMES.includes(scheme)) return { scheme, code: tag.slice(i + 1) };
  }
  return { custom: tag };
}

export function lookup(tag: string): StandardEntry | undefined {
  return byTag.get(tag);
}

/**
 * Catalog entries whose code is exactly `code`, across schemes. A bare code
 * typed as a custom designation is NOT converted here — the editor decides.
 */
export function findByBareCode(code: string): StandardEntry[] {
  return [...(byCode.get(code.trim()) ?? [])];
}

export function gradeBands(subject: StandardSubject): string[] {
  const out: string[] = [];
  for (const e of CATALOG) {
    if (e.subject === subject && !out.includes(e.grade_band)) out.push(e.grade_band);
  }
  return out;
}

/** HS math courses, in the workbook's order. */
export function courses(): string[] {
  const out: string[] = [];
  for (const e of CATALOG) {
    for (const c of e.courses ?? []) if (!out.includes(c.course)) out.push(c.course);
  }
  return out;
}

export type SearchOptions = {
  subject?: StandardSubject;
  gradeBand?: string;
  scheme?: StandardScheme;
  /** HS math: only standards taught in this course. */
  course?: string;
  limit?: number;
};

const norm = (s: string) => s.toLowerCase();

/** Case-insensitive match on code and text; code matches rank first (exact, prefix, substring). */
export function search(query: string, options: SearchOptions = {}): StandardEntry[] {
  const q = norm(query.trim());
  const limit = options.limit ?? 50;
  const ranked: { entry: StandardEntry; rank: number; order: number }[] = [];
  CATALOG.forEach((entry, order) => {
    if (options.subject && entry.subject !== options.subject) return;
    if (options.gradeBand && entry.grade_band !== options.gradeBand) return;
    if (options.scheme && entry.scheme !== options.scheme) return;
    if (options.course && !entry.courses?.some((c) => c.course === options.course)) return;
    let rank = 3;
    if (q) {
      const code = norm(entry.code);
      if (code === q) rank = 0;
      else if (code.startsWith(q)) rank = 1;
      else if (code.includes(q)) rank = 2;
      else if (norm(entry.text).includes(q)) rank = 3;
      else return;
    }
    ranked.push({ entry, rank, order });
  });
  ranked.sort((a, b) => a.rank - b.rank || a.order - b.order);
  return ranked.slice(0, limit).map((r) => r.entry);
}

/** The linked entries in the other scheme (2011 for a 2026 tag and the reverse). */
export function counterparts(tag: string): StandardEntry[] {
  const parsed = parseTag(tag);
  if ("custom" in parsed) return [];
  const [links, other] =
    parsed.scheme === "wa2026"
      ? [toCcss.get(parsed.code), "ccss2010" as const]
      : parsed.scheme === "ccss2010"
        ? [toWa.get(parsed.code), "wa2026" as const]
        : [undefined, "wa2026" as const];
  const out: StandardEntry[] = [];
  for (const code of links ?? []) {
    const e = byTag.get(`${other}:${code}`);
    if (e) out.push(e);
  }
  return out;
}

/**
 * Where a stored tag is counted by class insights and reports: a wa2026 tag is
 * itself; a ccss2010 tag with exactly one linked 2026 standard resolves to it;
 * anything else (several links, none, ngss) stays under its own entry. No guessing.
 */
export function resolveForReporting(tag: string): StandardEntry | undefined {
  const own = lookup(tag);
  if (!own || own.scheme !== "ccss2010") return own;
  const linked = counterparts(tag);
  return linked.length === 1 ? linked[0] : own;
}

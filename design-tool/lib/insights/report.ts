// Class insights slice 2 (docs/class-insights-design.md, D-3): the report's
// shape, the parse of the model's reply, and the citation / number fill.
//
// The model writes four sections of claims. It never writes a number of its
// own: it names a figure by key — `{item.Q3.p_value}`, a key from
// `pack.figures` — and `fillReport` replaces every key with the pack's value.
// A claim that cannot be checked is DROPPED (and counted), never repaired:
//
//   - not a claim object (Zod), or text over MAX_CLAIM_TEXT;
//   - a `{key}` that is not in `pack.figures`, or a stray `{` / `}`;
//   - a `Q<n>` / `S<n>` label (in the text or the citations) the pack does
//     not have, or a cited tag the pack does not carry;
//   - a cited figure key (`figures: [...]`) the pack does not have;
//   - THE DIGIT RULE: with the `{key}` references, the Q / S labels and the
//     ALLOWED STRINGS removed, the text must contain no digit at all. The
//     allowed strings are pack text that names a thing rather than counts it
//     — every tag as stored and its code (`wa2026:7.RP.A.2`, `7.RP.A.2`),
//     every rubric criterion name and level label — and only those of them
//     that contain a letter (a level labelled "3" would otherwise let any
//     "3" through). They are matched verbatim and case-sensitively;
//   - a celebration that cites no student, or that has neither a figure nor
//     an item behind it (the design's "never a student with no evidence").
//
// What the fill stores: numbers in, and every label wrapped as `[[S4]]` /
// `[[Q3]]`. The markers make the render's name swap exact — a bare "S1"
// inside a tag code is never mistaken for a student — and keep the stored
// row free of names (D-1). `plainText` drops the markers for the guardrail.

import { z } from "zod";
import { repairModelJson } from "@/lib/pdfImport/extractCore";
import type { EvidencePack } from "./evidencePack";

export const REPORT_SECTIONS = ["strengths", "growth", "celebrations", "next_steps"] as const;
export type ReportSection = (typeof REPORT_SECTIONS)[number];

/** Teacher-facing headings (slice 3 renders them). */
export const REPORT_SECTION_TITLES: Record<ReportSection, string> = {
  strengths: "Strengths",
  growth: "Areas for growth",
  celebrations: "Celebrations",
  next_steps: "Next steps for whole-class instruction",
};

export const MAX_CLAIMS_PER_SECTION = 6;
export const MIN_NEXT_STEPS = 2;
export const MAX_NEXT_STEPS = 4;
export const MAX_CLAIM_TEXT = 400;
const MAX_CITATIONS = 12;

/** The model's reply, section by section; claims are checked one at a time. */
const RawReportSchema = z.object({
  strengths: z.array(z.unknown()).max(MAX_CLAIMS_PER_SECTION),
  growth: z.array(z.unknown()).max(MAX_CLAIMS_PER_SECTION),
  celebrations: z.array(z.unknown()).max(MAX_CLAIMS_PER_SECTION),
  next_steps: z.array(z.unknown()).min(MIN_NEXT_STEPS).max(MAX_NEXT_STEPS),
});

const CitationList = z.array(z.string().trim().min(1)).max(MAX_CITATIONS).optional();

export const ClaimSchema = z.object({
  text: z.string().trim().min(1).max(MAX_CLAIM_TEXT),
  citations: z
    .object({ items: CitationList, tags: CitationList, students: CitationList })
    .optional(),
  figures: z.array(z.string().trim().min(1)).max(MAX_CITATIONS).optional(),
});
export type RawClaim = z.infer<typeof ClaimSchema>;

/** A claim after the fill: numbers in, labels as `[[S4]]` / `[[Q3]]`. */
export interface FilledClaim {
  text: string;
  citations: { items: string[]; tags: string[]; students: string[] };
  /** Every figure key the claim used, inline or cited. */
  figures: string[];
}

export type ClassInsightsReport = Record<ReportSection, FilledClaim[]>;

export interface FillResult {
  report: ClassInsightsReport;
  dropped: number;
}

/** What the model sees: the pack without its hash (names were never in it). */
export type ClassInsightsPackInput = Omit<EvidencePack, "hash">;

// ---------------------------------------------------------------------------
// Parse

/**
 * The model's reply text → a plain object. Tolerates code fences, prose
 * around the JSON and the unescaped-backslash / stray-quote repairs the PDF
 * importer needs. Throws `<prefix>_returned_invalid_json` otherwise.
 */
export function parseReportObject(
  text: string,
  errPrefix: string,
  opts: { truncated?: boolean } = {},
): unknown {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  const attempts = [cleaned, repairModelJson(cleaned)];
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start !== -1 && end > start) {
    const inner = cleaned.slice(start, end + 1);
    attempts.push(inner, repairModelJson(inner));
  }
  for (const candidate of attempts) {
    try {
      const raw = JSON.parse(candidate);
      if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw;
    } catch {
      // next candidate
    }
  }
  throw new Error(
    `${errPrefix}_returned_invalid_json` + (opts.truncated ? " (output hit the token cap)" : ""),
  );
}

// ---------------------------------------------------------------------------
// Fill

/** `{item.Q3.p_value}` → "62%"; means and counts as stored. */
export function formatFigure(key: string, value: number): string {
  return /(?:p_value|percent)$/.test(key) ? `${value}%` : String(value);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The pack strings a claim may quote although they carry digits (see top). */
export function allowedStrings(pack: Pick<EvidencePack, "assessment" | "tags" | "item_analytics">): string[] {
  const out = new Set<string>();
  for (const t of pack.tags) {
    out.add(t.tag);
    out.add(t.code);
  }
  for (const item of pack.assessment.items) {
    for (const t of item.tags) {
      out.add(t.tag);
      out.add(t.code);
    }
  }
  for (const a of pack.item_analytics) {
    for (const c of a.criteria ?? []) {
      out.add(c.criterion);
      for (const l of c.levels) out.add(l.level);
    }
  }
  return [...out].filter((s) => s.trim().length > 0 && /[A-Za-z]/.test(s));
}

interface FillContext {
  figures: Record<string, number>;
  itemLabels: Set<string>;
  students: Set<string>;
  /** Stored tag and its code → the stored tag. */
  tagOf: Map<string, string>;
  /** One regex: `{key}` | an allowed string | a Q / S label. */
  token: RegExp;
}

function fillContext(pack: ClassInsightsPackInput): FillContext {
  const tagOf = new Map<string, string>();
  const addTag = (tag: string, code: string) => {
    tagOf.set(tag, tag);
    if (!tagOf.has(code)) tagOf.set(code, tag);
  };
  for (const t of pack.tags) addTag(t.tag, t.code);
  for (const item of pack.assessment.items) for (const t of item.tags) addTag(t.tag, t.code);

  const allowed = allowedStrings(pack)
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp);
  const parts = ["\\{[^{}]*\\}", ...allowed, "\\b[QS]\\d+\\b"];
  return {
    figures: pack.figures,
    itemLabels: new Set(pack.assessment.items.map((i) => i.label)),
    students: new Set(pack.students.map((s) => s.id)),
    tagOf,
    token: new RegExp(parts.join("|"), "g"),
  };
}

/** One claim through the rules above; null = dropped. */
function fillClaim(raw: unknown, ctx: FillContext): FilledClaim | null {
  const parsed = ClaimSchema.safeParse(raw);
  if (!parsed.success) return null;
  const claim = parsed.data;
  // The markers are ours; a model that writes them cannot be told apart.
  if (claim.text.includes("[[") || claim.text.includes("]]")) return null;

  const usedFigures = new Set<string>();
  const items = new Set<string>();
  const students = new Set<string>();
  let ok = true;
  let residue = "";
  let last = 0;

  const text = claim.text.replace(ctx.token, (match, offset: number) => {
    residue += claim.text.slice(last, offset);
    last = offset + match.length;
    if (match.startsWith("{")) {
      const key = match.slice(1, -1).trim();
      const value = ctx.figures[key];
      if (value === undefined) {
        ok = false;
        return match;
      }
      usedFigures.add(key);
      return formatFigure(key, value);
    }
    if (/^[QS]\d+$/.test(match)) {
      const known = match.startsWith("Q") ? ctx.itemLabels : ctx.students;
      if (!known.has(match)) {
        ok = false;
        return match;
      }
      (match.startsWith("Q") ? items : students).add(match);
      return `[[${match}]]`;
    }
    return match; // an allowed string, kept verbatim
  });
  residue += claim.text.slice(last);
  if (!ok) return null;
  // A stray brace (`{unclosed`, `{{x}}`) or a digit outside every allowed
  // token is an invented number.
  if (/[{}\d]/.test(residue)) return null;

  for (const label of claim.citations?.items ?? []) {
    if (!ctx.itemLabels.has(label)) return null;
    items.add(label);
  }
  for (const id of claim.citations?.students ?? []) {
    if (!ctx.students.has(id)) return null;
    students.add(id);
  }
  const tags = new Set<string>();
  for (const t of claim.citations?.tags ?? []) {
    const stored = ctx.tagOf.get(t);
    if (!stored) return null;
    tags.add(stored);
  }
  for (const key of claim.figures ?? []) {
    if (ctx.figures[key] === undefined) return null;
    usedFigures.add(key);
  }

  return {
    text,
    citations: { items: [...items], tags: [...tags], students: [...students] },
    figures: [...usedFigures],
  };
}

/**
 * The model's parsed reply → the stored report. Throws `report_invalid: …`
 * when the reply is not the four-section object (or next steps fall outside
 * 2–4) — the route answers 502. Individual claims that fail drop and count.
 */
export function fillReport(raw: unknown, pack: ClassInsightsPackInput): FillResult {
  const parsed = RawReportSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join(".") || "reply"}: ${i.message}`)
      .join("; ");
    throw new Error(`report_invalid: ${detail}`);
  }
  const ctx = fillContext(pack);
  let dropped = 0;
  const report = {} as ClassInsightsReport;
  for (const section of REPORT_SECTIONS) {
    report[section] = [];
    for (const rawClaim of parsed.data[section]) {
      const claim = fillClaim(rawClaim, ctx);
      const evidenced =
        claim !== null &&
        (section !== "celebrations" ||
          (claim.citations.students.length > 0 &&
            (claim.figures.length > 0 || claim.citations.items.length > 0)));
      if (claim && evidenced) report[section].push(claim);
      else dropped++;
    }
  }
  return { report, dropped };
}

/** `[[S4]]` → `S4`: the text a guardrail (or a test) reads. */
export function plainText(text: string): string {
  return text.replace(/\[\[([QS]\d+)\]\]/g, "$1");
}

/** Every claim's text, one per line — the guardrail's output check. */
export function reportText(report: ClassInsightsReport): string {
  return REPORT_SECTIONS.flatMap((s) => report[s].map((c) => plainText(c.text))).join("\n");
}

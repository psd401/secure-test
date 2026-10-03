// Class insights slice 2 (docs/class-insights-design.md, D-1 / D-3 / D-8):
// turning a STORED report into what a teacher reads. Names come in here and
// only here, at render, through the row's own pseudonym map → the CURRENT
// results' attempt → name; question labels through the row's item-id map →
// the item's CURRENT position. Nothing rendered is ever written back.

import { CLASS_INSIGHT_SECTION_ALL } from "@/db/schema";
import { chipLabel } from "@/lib/standards/tags";
import { NO_SECTION_FILTER } from "./evidencePack";
import { REPORT_SECTIONS, type ClassInsightsReport, type ReportSection } from "./report";

/** What a pseudonym renders as once its attempt is gone (D-4). */
export const GONE_STUDENT = "a student no longer in these results";

/** The `section` argument of the evidence pack → the stored `section_key`. */
export function sectionKey(section: string | null): string {
  return section === null ? CLASS_INSIGHT_SECTION_ALL : section;
}

export interface RenderedClaim {
  text: string;
  citations: {
    /** `item_id` null = the item has been deleted; the link drops, the text stays. */
    items: Array<{ label: string; item_id: string | null }>;
    tags: Array<{ tag: string; code: string; text: string | null }>;
    /** `attempt_id` null = no longer in the results; no link. */
    students: Array<{ pseudonym: string; attempt_id: string | null; name: string }>;
  };
  figures: string[];
}

export type RenderedReport = Record<ReportSection, RenderedClaim[]>;

export interface RenderContext {
  /** The row's `pseudonyms`: S-number → attempt id at generation. */
  pseudonyms: Record<string, string>;
  /** The row's `item_ids`: Q label → item id at generation. */
  itemIds: Record<string, string>;
  /** CURRENT results: attempt id → display name. */
  nameByAttempt: ReadonlyMap<string, string>;
  /** CURRENT items: item id → position. */
  positionByItem: ReadonlyMap<string, number>;
  tagLookup?: Record<string, { code: string; text: string } | null>;
}

export function renderReport(report: ClassInsightsReport, ctx: RenderContext): RenderedReport {
  const student = (pseudonym: string) => {
    const attemptId = ctx.pseudonyms[pseudonym] ?? null;
    const name = attemptId ? ctx.nameByAttempt.get(attemptId) : undefined;
    return name === undefined
      ? { pseudonym, attempt_id: null, name: GONE_STUDENT }
      : { pseudonym, attempt_id: attemptId, name };
  };
  const item = (label: string) => {
    const itemId = ctx.itemIds[label] ?? null;
    const position = itemId ? ctx.positionByItem.get(itemId) : undefined;
    return position === undefined
      ? { label, item_id: null }
      : { label: `Q${position + 1}`, item_id: itemId };
  };

  const out = {} as RenderedReport;
  for (const section of REPORT_SECTIONS) {
    out[section] = (report[section] ?? []).map((claim) => ({
      text: claim.text.replace(/\[\[([QS]\d+)\]\]/g, (_, label: string) =>
        label.startsWith("S") ? student(label).name : item(label).label,
      ),
      citations: {
        items: claim.citations.items.map(item),
        tags: claim.citations.tags.map((tag) => {
          const chip = chipLabel(tag, ctx.tagLookup?.[tag] ?? null);
          return { tag, code: chip.code, text: chip.text };
        }),
        students: claim.citations.students.map(student),
      },
      figures: claim.figures,
    }));
  }
  return out;
}

/**
 * `?section=` / the POST body's `section` → the pack's argument: absent,
 * empty or `__all__` = all sections; `__none__` = no section; else a label.
 */
export function normalizeSection(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const v = value.trim();
  if (v === "" || v === CLASS_INSIGHT_SECTION_ALL) return null;
  return v === NO_SECTION_FILTER ? NO_SECTION_FILTER : v;
}

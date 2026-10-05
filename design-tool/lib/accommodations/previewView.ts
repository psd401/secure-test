// U-16 slice 2: the words the "Who gets what" preview shows, kept pure so
// `bun test` covers them (the repo has no DOM harness).
import { ACCOMMODATION_CATALOG, isVisibleAccommodation } from "@/lib/accommodations/catalog";
import type { AccommodationsPreview, PreviewStudent } from "@/lib/accommodations/preview";
import type { ToolSetting } from "@/lib/accommodations/effective";

const LABEL = new Map(ACCOMMODATION_CATALOG.map((e) => [e.id, e.label]));

export function toolName(toolId: string): string {
  return LABEL.get(toolId) ?? toolId;
}

/** "Color Contrast: Black on Rose"; a plain On reads as the name alone. */
export function toolSetting(toolId: string, value: string): string {
  return value.trim().toLowerCase() === "on" ? toolName(toolId) : `${toolName(toolId)}: ${value.trim()}`;
}

export interface PreviewRowView {
  studentId: string;
  heading: string;
  tools: Array<{ text: string; exception: boolean; constructAltering: boolean; fromRecordOf: string | null }>;
  /** "Switched off for this test: Zoom" — an exception removed it. */
  removedLine: string | null;
  /** "On their record, not allowed here: Spell Check" */
  notAllowedLine: string | null;
}

/**
 * Rows in the server's (name) order. "Not allowed here" names only tools a
 * teacher can tick (the visible catalog): a hidden tool on a TIDE record
 * would read as a fixable gap that the Allowed tab cannot fix. A student left
 * with nothing to show is dropped.
 */
export function previewRows(preview: AccommodationsPreview): PreviewRowView[] {
  const rows: PreviewRowView[] = [];
  for (const s of preview.students) {
    const notAllowed = s.not_allowed.filter((t) => isVisibleAccommodation(t.tool_id));
    if (s.tools.length === 0 && s.removed_by_exception.length === 0 && notAllowed.length === 0) continue;
    rows.push({
      studentId: s.student_id,
      heading: heading(s),
      tools: s.tools.map((t) => ({
        text: toolSetting(t.tool_id, t.value),
        exception: t.exception,
        constructAltering: t.construct_altering,
        fromRecordOf: t.from_record_of ? recordOwnerName(t.from_record_of) : null,
      })),
      removedLine:
        s.removed_by_exception.length > 0
          ? `Switched off for this test: ${s.removed_by_exception.map(toolName).join(", ")}`
          : null,
      notAllowedLine:
        notAllowed.length > 0
          ? `On their record, not allowed here: ${notAllowed.map((t) => toolSetting(t.tool_id, t.value)).join(", ")}`
          : null,
    });
  }
  return rows;
}

/** The line under the list. */
export function othersLine(preview: AccommodationsPreview): string {
  if (preview.others_count === null) return "Everyone else gets none.";
  const n = preview.others_count;
  return n === 1
    ? "1 other student on your class lists gets none."
    : `${n} other students on your class lists get none.`;
}

function heading(s: PreviewStudent): string {
  if (s.name.trim()) return s.name.trim();
  if (s.ssid) return `SSID ${s.ssid}`;
  if (s.roster_ps_id) return `Student ${s.roster_ps_id}`;
  return "Unnamed student";
}

/**
 * U-17: how a co-teacher is named beside a tool or a record — the local part
 * of their address ("teacher.one"); the app has no staff names.
 */
export function recordOwnerName(email: string): string {
  return email.split("@")[0] || email;
}

/** "Also on teacher.one's record: Spell Check, Zoom (in-app)" (D-3). */
export function alsoOnRecordLine(other: { email: string; tools: readonly ToolSetting[] }): string {
  return `Also on ${recordOwnerName(other.email)}'s record: ${other.tools
    .map((t) => toolSetting(t.tool_id, t.value))
    .join(", ")}`;
}

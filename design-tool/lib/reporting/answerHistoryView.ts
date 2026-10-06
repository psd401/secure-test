// Answer history (docs/answer-history-design.md): the words of the
// per-student page's "Earlier versions" list. Pure, so the copy text and the
// labels are tested without rendering the page.

import type { ResponseRevisionReason } from "@/db/schema";

interface TableShape {
  columns?: Array<{ id: string; label: string }>;
  rows?: Array<{ id: string; label: string }>;
}

/**
 * The text a teacher reads and copies. Essay / short text: the text itself.
 * Table: one line per row, cells separated by tabs (pastes into a sheet or a
 * Doc table), a header line of column labels, and the row label first when
 * the table has row labels.
 */
export function revisionText(response: unknown, table?: TableShape | null): string {
  if (!response || typeof response !== "object") return "";
  const r = response as { text?: unknown; cells?: unknown };
  if (typeof r.text === "string") return r.text;
  if (!r.cells || typeof r.cells !== "object") return "";
  const cells = r.cells as Record<string, Record<string, string> | undefined>;
  const columns = table?.columns ?? [];
  const rows = table?.rows ?? [];
  const showLabels = rows.some((row) => row.label.trim().length > 0);
  const lines: string[] = [];
  lines.push([...(showLabels ? [""] : []), ...columns.map((c) => c.label)].join("\t"));
  for (const row of rows) {
    const values = columns.map((c) => cells[row.id]?.[c.id] ?? "");
    lines.push([...(showLabels ? [row.label] : []), ...values].join("\t"));
  }
  return lines.join("\n");
}

/** "212 words" for text answers, "5 cells filled" for a table. */
export function revisionMeasure(response: unknown): string {
  if (!response || typeof response !== "object") return "";
  const r = response as { text?: unknown; cells?: unknown };
  if (typeof r.text === "string") {
    const words = r.text.trim().split(/\s+/).filter(Boolean).length;
    return `${words} word${words === 1 ? "" : "s"}`;
  }
  let filled = 0;
  if (r.cells && typeof r.cells === "object") {
    for (const row of Object.values(r.cells as Record<string, unknown>)) {
      if (!row || typeof row !== "object") continue;
      for (const cell of Object.values(row as Record<string, unknown>)) {
        if (typeof cell === "string" && cell.trim() !== "") filled++;
      }
    }
  }
  return `${filled} cell${filled === 1 ? "" : "s"} filled`;
}

/** Why a version was kept, when that is worth saying; null for the routine copy. */
export function revisionReasonNote(reason: ResponseRevisionReason): string | null {
  switch (reason) {
    case "shrink":
      return "kept before a large deletion";
    case "withdrawn":
      return "kept before the answer was cleared";
    case "restored":
      return "kept before a restore";
    default:
      return null;
  }
}

// TIDE xlsx import — the merge engine that preserves teacher edits.
//
// Re-import semantics (locked with the user during slice 23a planning):
//   - `source = tide_import` rows → overwrite value, refresh last_imported_at.
//   - `source = tide_then_edited` rows → preserve the kept value,
//     record a diff for the dedicated review screen.
//   - `source = manual` rows → untouched.
//   - Baseline rows (tide_import or tide_then_edited) ABSENT from the
//     new import → soft-remove via `removed_at`. Hard delete is never
//     used; the audit trail is the point.
//   - Manual rows are never soft-removed by import.
//   - Unknown TIDE triples → drop with a count (catalog drift).
//
// The xlsx parse uses ExcelJS (server-only, streaming-capable). The
// import is transactional; partial writes can't strand rows.

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import ExcelJS from "exceljs";
import { getDb } from "@/db/client";
import { students, student_accommodations } from "@/db/schema";
import {
  mapTideToCatalogId,
  tideToolNameToCatalogId,
} from "@/lib/accommodations/tideCatalog";
import type { ImportTideResult, ImportTideDiff } from "./students";

// Expected sheet name. TIDE's own export uses "Accommodations".
const SHEET_NAME = "Accommodations";

// Column header → index map produced from the first non-empty row.
// We don't pin column order because TIDE rearranges columns across
// product versions; instead we resolve by lower-cased header text.
const HEADER_ALIASES: Record<string, string[]> = {
  ssid: ["ssid", "student id"],
  subject: ["subject"],
  tool: ["tool name", "tool"],
  value: ["value"],
};

interface ParsedRow {
  ssid: string;
  subject: string;
  tool: string;
  value: string;
}

export class TideImportError extends Error {
  constructor(public readonly code: string, message?: string) {
    super(message ?? code);
  }
}

export async function parseTideXlsx(buf: Buffer): Promise<ParsedRow[]> {
  const wb = new ExcelJS.Workbook();
  try {
    // exceljs's typings ask for a Node Buffer alias that doesn't quite
    // line up with @types/node's Buffer<ArrayBufferLike>. The runtime
    // accepts an ArrayBuffer view; cast to satisfy the .d.ts.
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
  } catch (err) {
    throw new TideImportError(
      "xlsx_parse_failed",
      err instanceof Error ? err.message : "unknown",
    );
  }
  const ws = wb.getWorksheet(SHEET_NAME);
  if (!ws) {
    throw new TideImportError(
      "sheet_not_found",
      `expected a sheet named "${SHEET_NAME}"`,
    );
  }

  // Build header → column-index. ExcelJS rows are 1-based and the
  // header row is the first row whose first cell isn't empty.
  let headerRowIdx = -1;
  ws.eachRow({ includeEmpty: false }, (row, idx) => {
    if (headerRowIdx !== -1) return;
    const firstCell = String(row.getCell(1).value ?? "").trim();
    if (firstCell.length > 0) headerRowIdx = idx;
  });
  if (headerRowIdx === -1) {
    throw new TideImportError("empty_sheet");
  }

  const headerRow = ws.getRow(headerRowIdx);
  const colIndex: Partial<Record<keyof typeof HEADER_ALIASES, number>> = {};
  headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    const txt = String(cell.value ?? "").trim().toLowerCase();
    for (const [key, aliases] of Object.entries(HEADER_ALIASES) as [
      keyof typeof HEADER_ALIASES,
      string[],
    ][]) {
      if (aliases.includes(txt)) {
        colIndex[key] = colNumber;
      }
    }
  });
  for (const k of Object.keys(HEADER_ALIASES) as (keyof typeof HEADER_ALIASES)[]) {
    if (!colIndex[k]) {
      throw new TideImportError(
        "missing_column",
        `expected a "${HEADER_ALIASES[k]![0]}" column in the "${SHEET_NAME}" sheet`,
      );
    }
  }

  const ssidCol = colIndex.ssid!;
  const subjectCol = colIndex.subject!;
  const toolCol = colIndex.tool!;
  const valueCol = colIndex.value!;

  const out: ParsedRow[] = [];
  for (let r = headerRowIdx + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const ssid = stringify(row.getCell(ssidCol).value);
    const subject = stringify(row.getCell(subjectCol).value);
    const tool = stringify(row.getCell(toolCol).value);
    const value = stringify(row.getCell(valueCol).value);
    if (!ssid && !subject && !tool && !value) continue; // blank line
    if (!ssid || !subject || !tool || !value) {
      // Partial row — skip but don't fail the whole import. The caller
      // surfaces rows_dropped to the UI.
      continue;
    }
    out.push({ ssid, subject, tool, value });
  }
  return out;
}

function stringify(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" || typeof v === "boolean") return String(v).trim();
  if (v instanceof Date) return v.toISOString();
  // Rich text / formula / hyperlink — extract a sensible text fallback.
  if (typeof v === "object") {
    const o = v as unknown as Record<string, unknown>;
    if (typeof o.text === "string") return (o.text as string).trim();
    if (typeof o.result === "string") return (o.result as string).trim();
    if (Array.isArray(o.richText)) {
      return (o.richText as { text?: string }[])
        .map((p) => p.text ?? "")
        .join("")
        .trim();
    }
  }
  return String(v).trim();
}

/**
 * Postgres caps a single statement at 65535 bind parameters. The batched
 * writes below are sized by district-scale imports (~1,500 students × ~10
 * accommodations), so an unchunked bulk insert of 15,000 rows × 7 columns
 * would be ~105,000 parameters and fail — at exactly the scale the batching
 * exists to serve. 1,000 keeps every statement an order of magnitude clear of
 * the cap regardless of column count.
 */
const PG_BATCH_SIZE = 1000;

function chunk<T>(items: readonly T[], size = PG_BATCH_SIZE): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

interface MergeState {
  diffs: ImportTideDiff[];
  rows_inserted: number;
  rows_overwritten: number;
  rows_preserved_with_diff: number;
  rows_soft_removed: number;
  rows_dropped: number;
  // D12 visibility: a dropped row no longer silently revokes the matching live
  // accommodation. These two say how often that guard fired, so catalog drift
  // shows up as a number the teacher can act on instead of as missing tools.
  rows_removal_suppressed: number;
  students_sweep_skipped: number;
  students_added: number;
  students_updated: number;
}

/**
 * Apply parsed rows to the DB under the given owner. Returns counters
 * + diffs for the dedicated review screen.
 */
export async function applyTideImport(
  rows: readonly ParsedRow[],
  owner_sub: string,
): Promise<ImportTideResult> {
  const state: MergeState = {
    diffs: [],
    rows_inserted: 0,
    rows_overwritten: 0,
    rows_preserved_with_diff: 0,
    rows_soft_removed: 0,
    rows_dropped: 0,
    rows_removal_suppressed: 0,
    students_sweep_skipped: 0,
    students_added: 0,
    students_updated: 0,
  };

  const db = getDb();

  // Map ssid → resolved student_id. Built up across the transaction so
  // we don't requery for every row.
  const studentIdByImportKey = new Map<string, string>(); // key: ssid

  await db.transaction(async (tx) => {
    // Group incoming rows by ssid so we upsert each student once.
    const bySsid = new Map<string, ParsedRow[]>();
    for (const row of rows) {
      const list = bySsid.get(row.ssid) ?? [];
      list.push(row);
      bySsid.set(row.ssid, list);
    }

    // Resolve every ssid to a students row in THREE queries rather than the
    // two-per-student this used to run (select, then update-or-insert). At
    // district scale — ~1,500 students — that was ~3,000 sequential round
    // trips inside one transaction before any accommodation was touched.
    // Reverse map is kept so the diff builder below never has to re-query an
    // ssid it already resolved here.
    const ssidByStudentId = new Map<string, string>();
    const ssids = [...bySsid.keys()];

    if (ssids.length > 0) {
      const existing = await tx
        .select({ id: students.id, ssid: students.ssid })
        .from(students)
        .where(
          and(eq(students.owner_sub, owner_sub), inArray(students.ssid, ssids)),
        );
      for (const s of existing) {
        if (s.ssid === null) continue; // matched by ssid, so never null
        studentIdByImportKey.set(s.ssid, s.id);
        ssidByStudentId.set(s.id, s.ssid);
      }
      state.students_updated = existing.length;

      if (existing.length > 0) {
        for (const ids of chunk(existing.map((s) => s.id))) {
          await tx
            .update(students)
            .set({ updated_at: new Date() })
            .where(inArray(students.id, ids));
        }
      }

      const missing = ssids.filter((s) => !studentIdByImportKey.has(s));
      if (missing.length > 0) {
        for (const batch of chunk(missing)) {
          const inserted = await tx
            .insert(students)
            .values(batch.map((ssid) => ({ owner_sub, ssid, name: "" })))
            .returning({ id: students.id, ssid: students.ssid });
          for (const s of inserted) {
            // ssid is nullable since slice 78, but every row inserted here
            // was given one.
            if (s.ssid === null) continue;
            studentIdByImportKey.set(s.ssid, s.id);
            ssidByStudentId.set(s.id, s.ssid);
          }
          state.students_added += inserted.length;
        }
      }
    }

    // Index incoming rows by (student_id, subject, tool_id) for the
    // soft-remove sweep. Build the resolved-mapping at the same time so
    // we don't re-do the catalog lookup.
    const incomingIndex = new Map<
      string,
      { value: string; tide_code: string }
    >();
    interface ResolvedRow {
      student_id: string;
      subject: string;
      tool_id: string;
      value: string;
      tide_code: string;
    }
    // D12 — DATA LOSS GUARD. The soft-remove sweep below revokes any live row
    // whose key is absent from the import. A row that TIDE DID send but whose
    // (subject, tool, value) triple failed catalog lookup used to be simply
    // dropped, so the sweep could not tell "TIDE stopped asserting this tool"
    // from "we failed to parse the row asserting it" — and silently set
    // removed_at on a legally-entitled student's existing accommodation.
    //
    // Two tiers of protection:
    //   1. `seenToolKeys` — the row's VALUE didn't map but its TOOL did, so we
    //      know exactly which existing row it corresponds to. Exclude that key
    //      from the sweep; the stored value stays as-is.
    //   2. `unsweepableStudents` — not even the tool NAME mapped (a TIDE tool
    //      rename, or a Phase-2 composite tool), so nothing about that row can
    //      be correlated. Removal for that student is suppressed wholesale: an
    //      import we cannot fully read is not evidence that a tool was
    //      withdrawn.
    const seenToolKeys = new Set<string>();
    const unsweepableStudents = new Set<string>();

    const resolved: ResolvedRow[] = [];
    for (const row of rows) {
      const mapped = mapTideToCatalogId(row.subject, row.tool, row.value);
      if (!mapped) {
        state.rows_dropped += 1;
        const student_id = studentIdByImportKey.get(row.ssid)!;
        const toolId = tideToolNameToCatalogId(row.tool);
        if (toolId) {
          seenToolKeys.add(`${student_id}::${row.subject}::${toolId}`);
        } else {
          unsweepableStudents.add(student_id);
        }
        continue;
      }
      const student_id = studentIdByImportKey.get(row.ssid)!;
      resolved.push({
        student_id,
        subject: row.subject,
        tool_id: mapped.tool_id,
        value: mapped.value,
        tide_code: mapped.tide_code,
      });
      incomingIndex.set(
        `${student_id}::${row.subject}::${mapped.tool_id}`,
        { value: mapped.value, tide_code: mapped.tide_code },
      );
    }

    // Collapse duplicate (student, subject, tool) triples, last one winning —
    // the same rule `incomingIndex` already applies, now applied to `resolved`
    // too so the two agree. A well-formed TIDE export has one row per triple;
    // a malformed one used to be absorbed by the row-at-a-time merge
    // (insert, then overwrite on the second sighting). Batched inserts have no
    // such luck: two rows with the same key would violate
    // student_accommodations_live_triple_unq and abort the whole import. Final
    // DB state is identical to the old path; only the counter split changes
    // (1 insert, rather than 1 insert + 1 overwrite) — and only on input that
    // was malformed to begin with.
    const dedupedResolved = [
      ...new Map(
        resolved.map((r) => [
          `${r.student_id}::${r.subject}::${r.tool_id}`,
          r,
        ]),
      ).values(),
    ];

    // Fetch every live accommodation for the students in this import ONCE,
    // instead of a SELECT per incoming row (~15,000 round trips at district
    // scale) plus another SELECT per student in the sweep below. The partial
    // unique index `student_accommodations_live_triple_unq` on
    // (student_id, subject, tool_id) WHERE removed_at IS NULL guarantees at
    // most one live row per key, so this Map is exactly equivalent to the
    // per-row `.limit(1)` lookup it replaces — not an approximation of it.
    const studentIds = [...studentIdByImportKey.values()];
    const liveRows =
      studentIds.length > 0
        ? await tx
            .select()
            .from(student_accommodations)
            .where(
              and(
                inArray(student_accommodations.student_id, studentIds),
                isNull(student_accommodations.removed_at),
              ),
            )
        : [];
    const liveByKey = new Map<string, (typeof liveRows)[number]>();
    for (const row of liveRows) {
      liveByKey.set(`${row.student_id}::${row.subject}::${row.tool_id}`, row);
    }

    // Apply per-row merge against existing live rows.
    const now = new Date();
    const pendingInserts: (typeof student_accommodations.$inferInsert)[] = [];
    for (const r of dedupedResolved) {
      const existing = liveByKey.get(
        `${r.student_id}::${r.subject}::${r.tool_id}`,
      );

      if (!existing) {
        pendingInserts.push({
          student_id: r.student_id,
          subject: r.subject,
          tool_id: r.tool_id,
          value: r.value,
          source: "tide_import",
          tide_code: r.tide_code,
          last_imported_at: now,
        });
        state.rows_inserted += 1;
        continue;
      }
      if (existing.source === "manual") {
        // Untouched — manual rows are independent of TIDE.
        continue;
      }
      if (existing.source === "tide_then_edited") {
        // Preserve the kept value; record a diff if TIDE's value drifted.
        //
        // D14: `tide_code` used to be left untouched here, so it went stale —
        // it still pointed at whatever TIDE said the last time this row was a
        // plain tide_import row. Refresh it to what TIDE asserts NOW. On a
        // tide_then_edited row `value` (the teacher's kept value) and
        // `tide_code` (TIDE's current value) deliberately disagree: together
        // they ARE the diff record, and that is what lets the review screen
        // tell a real divergence from a re-import of an identical value.
        const ssid = ssidByStudentId.get(r.student_id) ?? "";
        await tx
          .update(student_accommodations)
          .set({ last_imported_at: now, tide_code: r.tide_code })
          .where(eq(student_accommodations.id, existing.id));
        // UX pass 2 slice 5 (P2-5): a diff the teacher already decided via
        // "Keep mine" (kept_against_tide_code still matches what TIDE says
        // now) is not re-raised — and not re-counted on the result card.
        if (existing.value !== r.value && existing.kept_against_tide_code !== r.tide_code) {
          state.rows_preserved_with_diff += 1;
          state.diffs.push({
            accommodation_id: existing.id,
            ssid,
            subject: r.subject,
            tool_id: r.tool_id,
            kept_value: existing.value,
            tide_value: r.value,
          });
        }
        continue;
      }
      // existing.source === "tide_import" → overwrite.
      const changed = existing.value !== r.value || existing.tide_code !== r.tide_code;
      await tx
        .update(student_accommodations)
        .set({
          value: r.value,
          tide_code: r.tide_code,
          last_imported_at: now,
        })
        .where(eq(student_accommodations.id, existing.id));
      if (changed) state.rows_overwritten += 1;
    }

    for (const batch of chunk(pendingInserts)) {
      await tx.insert(student_accommodations).values(batch);
    }

    // Soft-remove pass: any LIVE row owned by these incoming students
    // whose (subject, tool_id) is not in the import → set removed_at.
    // Only tide-origin rows are subject to this; manual rows survive.
    // Rows TIDE sent but we couldn't fully map are NOT absent — see D12 above.
    //
    // Reuses the `liveRows` snapshot taken before the merge instead of
    // re-selecting per student. Safe because the merge cannot change what this
    // loop reads: rows it INSERTED are absent from the snapshot but are all in
    // `incomingIndex`, so they would be skipped anyway; rows it UPDATED are in
    // the snapshot and the merge never touches `source`, `subject`, or
    // `tool_id`, which are the only fields consulted here.
    // Grouped by student first — scanning all of liveRows per student would be
    // quadratic, which at district scale is the exact cost we came here to
    // remove.
    const liveByStudent = new Map<string, (typeof liveRows)[number][]>();
    for (const row of liveRows) {
      const list = liveByStudent.get(row.student_id);
      if (list) list.push(row);
      else liveByStudent.set(row.student_id, [row]);
    }

    const sweepIds: string[] = [];
    for (const student_id of studentIdByImportKey.values()) {
      if (unsweepableStudents.has(student_id)) {
        state.students_sweep_skipped += 1;
        continue;
      }
      for (const row of liveByStudent.get(student_id) ?? []) {
        if (row.source === "manual") continue;
        const key = `${student_id}::${row.subject}::${row.tool_id}`;
        if (incomingIndex.has(key)) continue;
        if (seenToolKeys.has(key)) {
          // TIDE asserted this tool; only its value failed catalog lookup.
          state.rows_removal_suppressed += 1;
          continue;
        }
        sweepIds.push(row.id);
        state.rows_soft_removed += 1;
      }
    }

    for (const ids of chunk(sweepIds)) {
      await tx
        .update(student_accommodations)
        .set({ removed_at: now })
        .where(inArray(student_accommodations.id, ids));
    }
  });

  return state;
}

// Convenience: alias for ImportTideResult-compatible aggregate counter
// view. `state` already matches the shape; this exists so the route
// returning JSON doesn't depend on internal types.
export type TideMergeResult = ImportTideResult;
export type { ParsedRow };
export { sql };

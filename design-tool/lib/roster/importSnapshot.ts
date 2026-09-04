// Slice 75 (ADR 0017): imports a validated warehouse extract into the
// `roster_*` mirror tables.
//
// Invariants, in the order they are enforced:
//
//   1. Nothing is written until the whole extract validates (lib/roster/
//      extract.ts). A refused extract leaves every roster table exactly as it
//      was — last-known-good — and records WHY in `roster_sync_runs`.
//   2. Each table is upserted and then absence-deactivated inside ONE
//      transaction per table, in foreign-key order. A failure in table N
//      leaves tables < N committed at the new snapshot and tables >= N at the
//      previous one; the run row says which. (AI Studio's sync makes the same
//      trade; a single transaction across four district-scale tables was
//      judged not worth the lock footprint for a nightly job.)
//   3. Nothing is deleted. Absence flips `is_active`; reappearance flips it
//      back through the same upsert.
//   4. The run log carries counts only. No row, no email, no name ever reaches
//      `roster_sync_runs.reason` or a log line from here.
//
// Idempotent: importing the same snapshot twice upserts identical rows and
// deactivates nothing on the second pass, because every row already carries
// that snapshot id.

import { and, eq, ne, sql } from "drizzle-orm";
import {
  roster_enrollments,
  roster_section_teachers,
  roster_sections,
  roster_students,
  roster_sync_runs,
} from "@/db/schema";
import type { getDb } from "@/db/client";
import {
  ROSTER_TABLES,
  validateExtract,
  type ParsedSnapshot,
  type ReadExtractFile,
  type RefusalReason,
  type RosterTable,
} from "./extract";

type Db = ReturnType<typeof getDb>;

export interface TableCounts {
  received: number;
  upserted: number;
  deactivated: number;
}

export type ImportCounts = Record<RosterTable, TableCounts>;

export type ImportResult =
  | { ok: true; run_id: string; snapshot_id: string; counts: ImportCounts }
  | { ok: false; run_id: string; snapshot_id: string | null; reason: RefusalReason }
  ;

export interface ImportSnapshotInput {
  /** The parsed JSON of manifest.json — shape is validated here, not trusted. */
  manifest: unknown;
  readFile: ReadExtractFile;
}

/** Postgres caps a statement at 65535 bind parameters; 500 rows × ≤13
 * columns stays an order of magnitude clear of it (same reasoning as the
 * TIDE importer's batching). */
const BATCH = 500;

function chunk<T>(items: readonly T[], size = BATCH): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export async function importSnapshot(
  db: Db,
  input: ImportSnapshotInput,
): Promise<ImportResult> {
  const validated = await validateExtract(input.manifest, input.readFile);

  if (!validated.ok) {
    // The manifest may itself be the invalid part, so the snapshot id is
    // whatever could be read from it — or nothing.
    const snapshotId = readSnapshotIdLoosely(input.manifest);
    const [run] = await db
      .insert(roster_sync_runs)
      .values({
        snapshot_id: snapshotId ?? "(unreadable)",
        status: "refused",
        reason: validated.reason,
        finished_at: new Date(),
      })
      .returning({ id: roster_sync_runs.id });
    return { ok: false, run_id: run!.id, snapshot_id: snapshotId, reason: validated.reason };
  }

  const { snapshot } = validated;
  const snapshotId = snapshot.manifest.snapshot_id;

  const [run] = await db
    .insert(roster_sync_runs)
    .values({ snapshot_id: snapshotId, status: "running" })
    .returning({ id: roster_sync_runs.id });
  const runId = run!.id;

  const counts = {} as ImportCounts;
  for (const table of ROSTER_TABLES) {
    try {
      counts[table] = await importTable(db, table, snapshot);
    } catch (err) {
      await db
        .update(roster_sync_runs)
        .set({
          status: "failed",
          // SQLSTATE only — a Postgres message can quote the offending row.
          reason: `write_failed:${table}:${sqlState(err)}`,
          counts,
          finished_at: new Date(),
        })
        .where(eq(roster_sync_runs.id, runId));
      throw err;
    }
  }

  await db
    .update(roster_sync_runs)
    .set({ status: "succeeded", counts, finished_at: new Date() })
    .where(eq(roster_sync_runs.id, runId));

  return { ok: true, run_id: runId, snapshot_id: snapshotId, counts };
}

// --- per-table write ---

async function importTable(
  db: Db,
  table: RosterTable,
  snapshot: ParsedSnapshot,
): Promise<TableCounts> {
  const snapshotId = snapshot.manifest.snapshot_id;
  const now = new Date();
  const stamp = { is_active: true, last_seen_snapshot_id: snapshotId, last_seen_at: now, deactivated_at: null };

  return db.transaction(async (tx) => {
    let upserted = 0;

    switch (table) {
      case "students": {
        for (const batch of chunk(snapshot.students)) {
          const rows = await tx
            .insert(roster_students)
            .values(batch.map((r) => ({ ...r, ...stamp })))
            .onConflictDoUpdate({
              target: roster_students.ps_id,
              set: {
                ssid: sql`excluded.ssid`,
                email: sql`excluded.email`,
                first_name: sql`excluded.first_name`,
                last_name: sql`excluded.last_name`,
                grade: sql`excluded.grade`,
                school_id: sql`excluded.school_id`,
                enroll_status: sql`excluded.enroll_status`,
                ...stamp,
              },
            })
            .returning({ ps_id: roster_students.ps_id });
          upserted += rows.length;
        }
        break;
      }
      case "sections": {
        for (const batch of chunk(snapshot.sections)) {
          const rows = await tx
            .insert(roster_sections)
            .values(batch.map((r) => ({ ...r, ...stamp })))
            .onConflictDoUpdate({
              target: roster_sections.ps_id,
              set: {
                school_id: sql`excluded.school_id`,
                course_code: sql`excluded.course_code`,
                course_name: sql`excluded.course_name`,
                term_id: sql`excluded.term_id`,
                period_expression: sql`excluded.period_expression`,
                ...stamp,
              },
            })
            .returning({ ps_id: roster_sections.ps_id });
          upserted += rows.length;
        }
        break;
      }
      case "section_teachers": {
        for (const batch of chunk(snapshot.section_teachers)) {
          const rows = await tx
            .insert(roster_section_teachers)
            .values(batch.map((r) => ({ ...r, ...stamp })))
            .onConflictDoUpdate({
              target: [
                roster_section_teachers.section_ps_id,
                roster_section_teachers.teacher_ps_id,
                roster_section_teachers.start_date,
              ],
              set: {
                teacher_email: sql`excluded.teacher_email`,
                role_name: sql`excluded.role_name`,
                priority_order: sql`excluded.priority_order`,
                end_date: sql`excluded.end_date`,
                ...stamp,
              },
            })
            .returning({ ps_id: roster_section_teachers.section_ps_id });
          upserted += rows.length;
        }
        break;
      }
      case "enrollments": {
        for (const batch of chunk(snapshot.enrollments)) {
          const rows = await tx
            .insert(roster_enrollments)
            .values(batch.map((r) => ({ ...r, ...stamp })))
            .onConflictDoUpdate({
              target: roster_enrollments.ps_id,
              set: {
                student_ps_id: sql`excluded.student_ps_id`,
                section_ps_id: sql`excluded.section_ps_id`,
                dateenrolled: sql`excluded.dateenrolled`,
                dateleft: sql`excluded.dateleft`,
                ...stamp,
              },
            })
            .returning({ ps_id: roster_enrollments.ps_id });
          upserted += rows.length;
        }
        break;
      }
    }

    // Absence: still active, but not stamped by this snapshot.
    const t = TABLE_FOR[table];
    const deactivated = await tx
      .update(t)
      .set({ is_active: false, deactivated_at: now })
      .where(and(eq(t.is_active, true), ne(t.last_seen_snapshot_id, snapshotId)))
      .returning({ x: t.last_seen_snapshot_id });

    return {
      received: snapshot[table].length,
      upserted,
      deactivated: deactivated.length,
    };
  });
}

const TABLE_FOR = {
  students: roster_students,
  sections: roster_sections,
  section_teachers: roster_section_teachers,
  enrollments: roster_enrollments,
} as const;

function sqlState(err: unknown): string {
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return "unknown";
}

function readSnapshotIdLoosely(manifest: unknown): string | null {
  if (typeof manifest !== "object" || manifest === null) return null;
  const id = (manifest as { snapshot_id?: unknown }).snapshot_id;
  if (typeof id !== "string") return null;
  // Same character class the schema allows, so an unparseable manifest cannot
  // smuggle arbitrary text into the run log through this field either.
  return /^[A-Za-z0-9._:-]{1,64}$/.test(id) ? id : null;
}

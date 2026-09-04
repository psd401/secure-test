// Slice 75: the importer against the test database.
//
// What these prove: a complete extract lands; the same extract twice is a
// no-op on the second pass; a later extract missing a row deactivates it and a
// still-later one carrying it again reactivates it; a refused extract leaves
// the tables untouched and is recorded with its reason; the run log carries
// counts and codes only.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { asc, eq, sql } from "drizzle-orm";
import { closeDb, getDb } from "../db/client";
import {
  roster_enrollments,
  roster_section_teachers,
  roster_sections,
  roster_students,
  roster_sync_runs,
} from "../db/schema";
import { importSnapshot } from "../lib/roster/importSnapshot";
import {
  dropFile,
  loadExtract,
  replaceFile,
  withSnapshotId,
} from "./fixtures/roster/load";

const expectTestDb = () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("secure_test_design_tool_test")) {
    throw new Error(`roster-import tests require the test DB; got: ${url}`);
  }
};

beforeAll(() => expectTestDb());

afterEach(async () => {
  const db = getDb();
  await db.execute(sql`truncate table roster_enrollments, roster_section_teachers, roster_sections, roster_students, roster_sync_runs`);
});

afterAll(async () => await closeDb());

async function importFixture(snapshotId?: string) {
  const ex = await loadExtract();
  if (snapshotId) withSnapshotId(ex, snapshotId);
  return importSnapshot(getDb(), { manifest: ex.manifest, readFile: ex.readFile });
}

async function activeStudentIds(): Promise<string[]> {
  const rows = await getDb()
    .select({ ps_id: roster_students.ps_id })
    .from(roster_students)
    .where(eq(roster_students.is_active, true))
    .orderBy(asc(roster_students.ps_id));
  return rows.map((r) => r.ps_id);
}

describe("importSnapshot — a complete extract", () => {
  test("lands every table and records a succeeded run with counts", async () => {
    const result = await importFixture();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.counts).toEqual({
      students: { received: 7, upserted: 7, deactivated: 0 },
      sections: { received: 4, upserted: 4, deactivated: 0 },
      section_teachers: { received: 5, upserted: 5, deactivated: 0 },
      enrollments: { received: 8, upserted: 8, deactivated: 0 },
    });

    const [run] = await getDb().select().from(roster_sync_runs);
    expect(run?.status).toBe("succeeded");
    expect(run?.snapshot_id).toBe("fixture-2026-08-26");
    expect(run?.reason).toBeNull();
    expect(run?.finished_at).not.toBeNull();
    expect(run?.counts).toEqual(result.counts);
  });

  test("stores emails lowercased and stamps every row with the snapshot id", async () => {
    await importFixture();
    const [ada] = await getDb()
      .select()
      .from(roster_students)
      .where(eq(roster_students.ps_id, "1001"));
    expect(ada?.email).toBe("ada.fixture@edtools.psd401.net");
    expect(ada?.ssid).toBe("WA-FIX-1001");
    expect(ada?.is_active).toBe(true);
    expect(ada?.last_seen_snapshot_id).toBe("fixture-2026-08-26");

    const [t1] = await getDb()
      .select()
      .from(roster_section_teachers)
      .where(eq(roster_section_teachers.teacher_ps_id, "301"));
    expect(t1?.teacher_email).toBe("teacher.one@psd401.net");
  });

  test("re-importing the same snapshot is idempotent", async () => {
    await importFixture();
    const again = await importFixture();
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    for (const table of Object.values(again.counts)) {
      expect(table.deactivated).toBe(0);
    }
    expect((await activeStudentIds()).length).toBe(7);
    const runs = await getDb().select().from(roster_sync_runs);
    expect(runs.length).toBe(2);
    expect(runs.every((r) => r.status === "succeeded")).toBe(true);
  });
});

describe("importSnapshot — absence deactivates, presence reactivates", () => {
  test("a later snapshot without a student deactivates that student only", async () => {
    await importFixture("night-1");

    const ex = await loadExtract();
    withSnapshotId(ex, "night-2");
    // Drop student 1003 and the one enrollment that references them.
    replaceFile(
      ex,
      "students",
      [
        "ps_id,ssid,email,first_name,last_name,grade,school_id,enroll_status",
        "1001,WA-FIX-1001,Ada.Fixture@edtools.psd401.net,Ada,Fixture,9,200,0",
        "1002,WA-FIX-1002,ben.sample@edtools.psd401.net,Ben,Sample,9,200,0",
        "1004,WA-FIX-1004,dee.placeholder@edtools.psd401.net,Dee,Placeholder,9,200,0",
        "1005,,eli.noemail@edtools.psd401.net,Eli,Nossid,5,100,0",
        "1006,WA-FIX-1006,,Fay,Noemail,5,100,0",
        "1007,WA-FIX-1007,gus.transferred@edtools.psd401.net,Gus,Transferred,9,200,2",
        "",
      ].join("\n"),
    );
    replaceFile(
      ex,
      "enrollments",
      [
        "ps_id,student_ps_id,section_ps_id,dateenrolled,dateleft",
        "9001,1001,5001,2020-09-01,2099-06-30",
        "9002,1002,5001,2020-09-01,2099-06-30",
        "9004,1004,5001,2020-09-01,2021-10-01",
        "9005,1001,5003,2020-09-01,2099-06-30",
        "9006,1005,5004,2020-09-01,2099-06-30",
        "9007,1006,5004,2020-09-01,2099-06-30",
        "9008,1007,5001,2020-09-01,2021-01-15",
        "",
      ].join("\n"),
    );
    const result = await importSnapshot(getDb(), { manifest: ex.manifest, readFile: ex.readFile });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.counts.students).toEqual({ received: 6, upserted: 6, deactivated: 1 });
    expect(result.counts.enrollments).toEqual({ received: 7, upserted: 7, deactivated: 1 });
    expect(result.counts.sections.deactivated).toBe(0);

    expect(await activeStudentIds()).toEqual(["1001", "1002", "1004", "1005", "1006", "1007"]);

    // Deactivated, not deleted.
    const [gone] = await getDb()
      .select()
      .from(roster_students)
      .where(eq(roster_students.ps_id, "1003"));
    expect(gone?.is_active).toBe(false);
    expect(gone?.deactivated_at).not.toBeNull();
    expect(gone?.last_seen_snapshot_id).toBe("night-1");

    const [goneEnrollment] = await getDb()
      .select()
      .from(roster_enrollments)
      .where(eq(roster_enrollments.ps_id, "9003"));
    expect(goneEnrollment?.is_active).toBe(false);

    // Night 3 carries the full roster again: the student comes back.
    const back = await importFixture("night-3");
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.counts.students.deactivated).toBe(0);
    const [returned] = await getDb()
      .select()
      .from(roster_students)
      .where(eq(roster_students.ps_id, "1003"));
    expect(returned?.is_active).toBe(true);
    expect(returned?.deactivated_at).toBeNull();
    expect(returned?.last_seen_snapshot_id).toBe("night-3");
  });

  test("changed attributes overwrite; the warehouse is the source of truth", async () => {
    await importFixture("night-1");
    const ex = await loadExtract();
    withSnapshotId(ex, "night-2");
    replaceFile(
      ex,
      "sections",
      [
        "ps_id,school_id,course_code,course_name,term_id,period_expression",
        "5001,200,MAT101,Algebra 1 Honors,3100,3(A)",
        "5002,200,SCI201,Biology,3100,4(A)",
        "5003,200,ENG101,English 9,3100,1(A)",
        "5004,100,ELE500,Grade 5 Homeroom,3000,HR",
        "",
      ].join("\n"),
    );
    const result = await importSnapshot(getDb(), { manifest: ex.manifest, readFile: ex.readFile });
    expect(result.ok).toBe(true);
    const [s] = await getDb()
      .select()
      .from(roster_sections)
      .where(eq(roster_sections.ps_id, "5001"));
    expect(s?.course_name).toBe("Algebra 1 Honors");
  });
});

describe("importSnapshot — refusals preserve last-known-good", () => {
  test("a partial extract is refused, changes nothing, and is logged with its reason", async () => {
    await importFixture("night-1");
    const before = await activeStudentIds();

    const ex = dropFile(withSnapshotId(await loadExtract(), "night-2"), "enrollments");
    const result = await importSnapshot(getDb(), { manifest: ex.manifest, readFile: ex.readFile });
    expect(result).toMatchObject({ ok: false, snapshot_id: "night-2", reason: "file_missing:enrollments" });

    expect(await activeStudentIds()).toEqual(before);
    const [ada] = await getDb()
      .select()
      .from(roster_students)
      .where(eq(roster_students.ps_id, "1001"));
    expect(ada?.last_seen_snapshot_id).toBe("night-1");

    const runs = await getDb().select().from(roster_sync_runs).orderBy(asc(roster_sync_runs.started_at));
    expect(runs.map((r) => r.status)).toEqual(["succeeded", "refused"]);
    expect(runs[1]?.reason).toBe("file_missing:enrollments");
    expect(runs[1]?.snapshot_id).toBe("night-2");
    expect(runs[1]?.finished_at).not.toBeNull();
  });

  test("an empty table is refused rather than deactivating everything", async () => {
    await importFixture("night-1");
    const ex = replaceFile(
      withSnapshotId(await loadExtract(), "night-2"),
      "students",
      "ps_id,ssid,email,first_name,last_name,grade,school_id,enroll_status\n",
    );
    const result = await importSnapshot(getDb(), { manifest: ex.manifest, readFile: ex.readFile });
    expect(result).toMatchObject({ ok: false, reason: "empty_table:students" });
    expect((await activeStudentIds()).length).toBe(7);
  });

  test("a checksum mismatch is refused and the run row never carries row content", async () => {
    await importFixture("night-1");
    const ex = await loadExtract();
    withSnapshotId(ex, "night-2");
    const entry = ex.manifest.files.students!;
    ex.files.set(
      entry.path,
      new TextEncoder().encode(
        "ps_id,ssid,email,first_name,last_name,grade,school_id,enroll_status\n1001,WA-FIX-1001,tampered@edtools.psd401.net,Ada,Fixture,9,200,0\n",
      ),
    );
    const result = await importSnapshot(getDb(), { manifest: ex.manifest, readFile: ex.readFile });
    expect(result).toMatchObject({ ok: false, reason: "checksum_mismatch:students" });

    const [ada] = await getDb()
      .select()
      .from(roster_students)
      .where(eq(roster_students.ps_id, "1001"));
    expect(ada?.email).toBe("ada.fixture@edtools.psd401.net");

    const runs = await getDb().select().from(roster_sync_runs);
    for (const run of runs) {
      expect(JSON.stringify(run)).not.toContain("tampered");
      expect(JSON.stringify(run)).not.toContain("Fixture");
    }
  });

  test("an unreadable manifest is still logged, with a placeholder snapshot id", async () => {
    const result = await importSnapshot(getDb(), {
      manifest: { snapshot_id: "bad<script>", files: {} },
      readFile: async () => null,
    });
    expect(result).toMatchObject({ ok: false, reason: "manifest_invalid", snapshot_id: null });
    const [run] = await getDb().select().from(roster_sync_runs);
    expect(run?.status).toBe("refused");
    expect(run?.snapshot_id).toBe("(unreadable)");
  });
});

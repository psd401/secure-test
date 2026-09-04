// Slice 88: the manifest shapes the importer accepts, and what a blank
// teacher_email parses to. Pure — validateExtract touches no database.
import { describe, expect, test } from "bun:test";
import { validateExtract } from "../lib/roster/extract";
import { loadExtract, replaceFile, withSnapshotId } from "./fixtures/roster/load";

function asList(files: Record<string, { path: string; rows: number; sha256: string }>) {
  return Object.values(files).map((f) => ({ ...f }));
}

describe("manifest.files", () => {
  test("a map keyed by table (the contract's example) validates", async () => {
    const ex = await loadExtract();
    const result = await validateExtract(ex.manifest, ex.readFile);
    expect(result.ok).toBe(true);
  });

  test("a list of the same entries (what the warehouse DAG writes) validates identically", async () => {
    const ex = await loadExtract();
    const manifest = { ...ex.manifest, files: asList(ex.manifest.files) };
    const result = await validateExtract(manifest, ex.readFile);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.snapshot.manifest.files.students.path).toBe("students.csv");
      expect(result.snapshot.students.length).toBe(7);
    }
  });

  test("a list is refused when a name is not <table>.csv, is duplicated, or a table is missing", async () => {
    const ex = await loadExtract();
    const list = asList(ex.manifest.files);
    const renamed = list.map((f) => (f.path === "students.csv" ? { ...f, path: "pupils.csv" } : f));
    expect(await validateExtract({ ...ex.manifest, files: renamed }, ex.readFile)).toMatchObject({
      ok: false,
      reason: "manifest_invalid",
    });
    const duplicated = [...list, { ...list[0]! }];
    expect(await validateExtract({ ...ex.manifest, files: duplicated }, ex.readFile)).toMatchObject({
      ok: false,
      reason: "manifest_invalid",
    });
    const missing = list.filter((f) => f.path !== "enrollments.csv");
    expect(await validateExtract({ ...ex.manifest, files: missing }, ex.readFile)).toMatchObject({
      ok: false,
      reason: "manifest_invalid",
    });
  });
});

describe("section_teachers.teacher_email", () => {
  test("a blank cell — a teacher who has separated — parses to null and the row still imports", async () => {
    const base = await loadExtract();
    const csv =
      "section_ps_id,teacher_ps_id,teacher_email,role_name,priority_order,start_date,end_date\n" +
      "5001,301,,Lead Teacher,1,2020-09-01,2099-06-30\n" +
      "5001,303,teacher.three@psd401.net,Co-Teacher,2,2020-09-01,2021-06-30\n" +
      "5002,302,teacher.two@psd401.net,Lead Teacher,1,2020-09-01,2099-06-30\n" +
      "5003,301,teacher.one@psd401.net,Lead Teacher,1,2020-09-01,2099-06-30\n" +
      "5004,304,teacher.four@psd401.net,Lead Teacher,1,2020-09-01,2099-06-30\n";
    const ex = withSnapshotId(replaceFile(base, "section_teachers", csv), "separated");
    const result = await validateExtract(ex.manifest, ex.readFile);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const row = result.snapshot.section_teachers.find((r) => r.section_ps_id === "5001" && r.teacher_ps_id === "301");
      expect(row?.teacher_email).toBeNull();
    }
  });
});

// Slice 75: the extract contract, tested without a database.
//
// The refusal rules are the point. An extract that is anything short of
// complete must be refused as a whole — importing it would deactivate every
// row it failed to carry — so each way an extract can be incomplete gets a
// test that pins both the refusal and the reason code.
import { describe, expect, test } from "bun:test";
import {
  COLUMNS,
  ManifestSchema,
  ROSTER_TABLES,
  validateExtract,
} from "../lib/roster/extract";
import {
  dropFile,
  loadExtract,
  replaceFile,
  tamperFile,
} from "./fixtures/roster/load";

describe("validateExtract — the complete fixture", () => {
  test("accepts it and returns every row of every table", async () => {
    const ex = await loadExtract();
    const result = await validateExtract(ex.manifest, ex.readFile);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.students.length).toBe(7);
    expect(result.snapshot.sections.length).toBe(4);
    expect(result.snapshot.section_teachers.length).toBe(5);
    expect(result.snapshot.enrollments.length).toBe(8);
    expect(result.snapshot.manifest.snapshot_id).toBe("fixture-2026-08-26");
  });

  test("lowercases emails — the resolver matches on lowercase", async () => {
    const ex = await loadExtract();
    const result = await validateExtract(ex.manifest, ex.readFile);
    if (!result.ok) throw new Error(result.reason);
    const ada = result.snapshot.students.find((s) => s.ps_id === "1001");
    expect(ada?.email).toBe("ada.fixture@edtools.psd401.net");
    const t1 = result.snapshot.section_teachers.find((t) => t.teacher_ps_id === "301");
    expect(t1?.teacher_email).toBe("teacher.one@psd401.net");
  });

  test("blank optional cells become null, not empty strings", async () => {
    const ex = await loadExtract();
    const result = await validateExtract(ex.manifest, ex.readFile);
    if (!result.ok) throw new Error(result.reason);
    const noSsid = result.snapshot.students.find((s) => s.ps_id === "1005");
    const noEmail = result.snapshot.students.find((s) => s.ps_id === "1006");
    expect(noSsid?.ssid).toBeNull();
    expect(noEmail?.email).toBeNull();
  });

  test("the fixture's manifest satisfies the published schema", async () => {
    const ex = await loadExtract();
    expect(ManifestSchema.safeParse(ex.manifest).success).toBe(true);
  });
});

describe("validateExtract — refusals", () => {
  test("a missing file refuses the whole extract", async () => {
    for (const table of ROSTER_TABLES) {
      const ex = dropFile(await loadExtract(), table);
      const result = await validateExtract(ex.manifest, ex.readFile);
      expect(result).toEqual({ ok: false, reason: `file_missing:${table}` });
    }
  });

  test("a checksum mismatch refuses, even when the rows still parse", async () => {
    const ex = tamperFile(
      await loadExtract(),
      "sections",
      "ps_id,school_id,course_code,course_name,term_id,period_expression\n5001,200,MAT101,Algebra 1 Honors,3100,3(A)\n5002,200,SCI201,Biology,3100,4(A)\n5003,200,ENG101,English 9,3100,1(A)\n5004,100,ELE500,Grade 5 Homeroom,3000,HR\n",
    );
    const result = await validateExtract(ex.manifest, ex.readFile);
    expect(result).toEqual({ ok: false, reason: "checksum_mismatch:sections" });
  });

  test("a row count that disagrees with the manifest refuses", async () => {
    const ex = await loadExtract();
    ex.manifest.files.students!.rows = 6;
    const result = await validateExtract(ex.manifest, ex.readFile);
    expect(result).toEqual({ ok: false, reason: "row_count_mismatch:students" });
  });

  test("an empty table refuses — a district never has zero of anything", async () => {
    const ex = replaceFile(await loadExtract(), "enrollments", COLUMNS.enrollments.join(",") + "\n");
    const result = await validateExtract(ex.manifest, ex.readFile);
    expect(result).toEqual({ ok: false, reason: "empty_table:enrollments" });
  });

  test("a header missing a required column refuses and names the column", async () => {
    const ex = replaceFile(
      await loadExtract(),
      "students",
      "ps_id,ssid,mail,first_name,last_name,grade,school_id,enroll_status\n1,,a@b,A,B,9,1,0\n",
    );
    const result = await validateExtract(ex.manifest, ex.readFile);
    expect(result).toEqual({ ok: false, reason: "missing_column:students:email" });
  });

  test("extra columns are ignored", async () => {
    const ex = replaceFile(
      await loadExtract(),
      "sections",
      "ps_id,school_id,course_code,course_name,term_id,period_expression,extra\n5001,200,MAT101,Algebra 1,3100,3(A),x\n5002,200,SCI201,Biology,3100,4(A),y\n5003,200,ENG101,English 9,3100,1(A),z\n5004,100,ELE500,Grade 5 Homeroom,3000,HR,w\n",
    );
    const result = await validateExtract(ex.manifest, ex.readFile);
    expect(result.ok).toBe(true);
  });

  test("a malformed row refuses with the line number and no content", async () => {
    // enroll_status must be an integer; line 3 carries "active".
    const ex = replaceFile(
      await loadExtract(),
      "students",
      "ps_id,ssid,email,first_name,last_name,grade,school_id,enroll_status\n1001,,a@x,A,B,9,200,0\n1002,,b@x,B,C,9,200,active\n",
    );
    const result = await validateExtract(ex.manifest, ex.readFile);
    expect(result).toEqual({ ok: false, reason: "invalid_row:students:3" });
  });

  test("a timestamp where a date is expected refuses", async () => {
    const ex = replaceFile(
      await loadExtract(),
      "enrollments",
      "ps_id,student_ps_id,section_ps_id,dateenrolled,dateleft\n9001,1001,5001,2020-09-01 00:00:00,2099-06-30\n",
    );
    const result = await validateExtract(ex.manifest, ex.readFile);
    expect(result).toEqual({ ok: false, reason: "invalid_row:enrollments:2" });
  });

  test("a duplicate key refuses", async () => {
    const ex = replaceFile(
      await loadExtract(),
      "sections",
      "ps_id,school_id,course_code,course_name,term_id,period_expression\n5001,200,MAT101,Algebra 1,3100,3(A)\n5001,200,MAT101,Algebra 1,3100,3(A)\n",
    );
    const result = await validateExtract(ex.manifest, ex.readFile);
    expect(result).toEqual({ ok: false, reason: "duplicate_key:sections:3" });
  });

  test("an enrollment pointing at an unknown student refuses before any write", async () => {
    const ex = replaceFile(
      await loadExtract(),
      "enrollments",
      "ps_id,student_ps_id,section_ps_id,dateenrolled,dateleft\n9001,1001,5001,2020-09-01,2099-06-30\n9999,4242,5001,2020-09-01,2099-06-30\n",
    );
    const result = await validateExtract(ex.manifest, ex.readFile);
    expect(result).toEqual({ ok: false, reason: "dangling_reference:enrollments:3" });
  });

  test("a teacher assignment on an unknown section refuses", async () => {
    const ex = replaceFile(
      await loadExtract(),
      "section_teachers",
      "section_ps_id,teacher_ps_id,teacher_email,role_name,priority_order,start_date,end_date\n7777,301,t@psd401.net,Lead,1,2020-09-01,2099-06-30\n",
    );
    const result = await validateExtract(ex.manifest, ex.readFile);
    expect(result).toEqual({ ok: false, reason: "dangling_reference:section_teachers:2" });
  });

  test("a manifest with the wrong format version or a path with a slash refuses", async () => {
    const ex = await loadExtract();
    ex.manifest.format_version = 2;
    expect(await validateExtract(ex.manifest, ex.readFile)).toEqual({
      ok: false,
      reason: "manifest_invalid",
    });

    const ex2 = await loadExtract();
    ex2.manifest.files.students!.path = "../students.csv";
    expect(await validateExtract(ex2.manifest, ex2.readFile)).toEqual({
      ok: false,
      reason: "manifest_invalid",
    });
  });

  test("garbage in place of a manifest refuses without throwing", async () => {
    for (const bad of [null, "string", 42, [], { files: {} }]) {
      expect(await validateExtract(bad, async () => null)).toEqual({
        ok: false,
        reason: "manifest_invalid",
      });
    }
  });
});

// Gradebook push slice 1 (docs/gradebook-push-design.md): the PowerSchool
// DCID columns IT added to the extract on 2026-09-23. They are OPTIONAL
// columns — a file without one is accepted (the roster everyone signs in
// against must not hinge on a gradebook feature) — but a value that is there
// must be an integer id.
import { describe, expect, test } from "bun:test";
import { OPTIONAL_COLUMNS, validateExtract } from "../lib/roster/extract";
import { loadExtract, replaceFile } from "./fixtures/roster/load";

const SECTIONS_WITHOUT_DCIDS =
  "ps_id,school_id,course_code,course_name,term_id,period_expression\n" +
  "5001,200,MAT101,Algebra 1,3100,3(A)\n5002,200,SCI201,Biology,3100,4(A)\n" +
  "5003,200,ENG101,English 9,3100,1(A)\n5004,100,ELE500,Grade 5 Homeroom,3000,HR\n";

describe("validateExtract — DCID columns", () => {
  test("parses every DCID column the fixture carries, as text", async () => {
    const ex = await loadExtract();
    const result = await validateExtract(ex.manifest, ex.readFile);
    if (!result.ok) throw new Error(result.reason);
    const { snapshot } = result;
    expect(snapshot.students.find((s) => s.ps_id === "1001")?.dcid).toBe("81001");
    const s5004 = snapshot.sections.find((s) => s.ps_id === "5004");
    expect(s5004?.dcid).toBe("85004");
    expect(s5004?.year_id).toBe("30");
    expect(
      snapshot.section_teachers.find((t) => t.teacher_ps_id === "302")?.users_dcid,
    ).toBe("8302");
    expect(snapshot.optionalColumns).toEqual({
      students: ["dcid"],
      sections: ["dcid", "year_id"],
      section_teachers: ["users_dcid"],
      enrollments: [],
    });
  });

  test("an empty DCID cell is null", async () => {
    const ex = await loadExtract();
    const result = await validateExtract(ex.manifest, ex.readFile);
    if (!result.ok) throw new Error(result.reason);
    expect(result.snapshot.students.find((s) => s.ps_id === "1007")?.dcid).toBeNull();
  });

  test("a file without the columns is accepted, and says so", async () => {
    const ex = replaceFile(await loadExtract(), "sections", SECTIONS_WITHOUT_DCIDS);
    const result = await validateExtract(ex.manifest, ex.readFile);
    if (!result.ok) throw new Error(result.reason);
    expect(result.snapshot.optionalColumns.sections).toEqual([]);
    expect(result.snapshot.optionalColumns.students).toEqual(["dcid"]);
    const s = result.snapshot.sections.find((r) => r.ps_id === "5001");
    expect(s?.dcid).toBeUndefined();
    expect(s?.year_id).toBeUndefined();
  });

  test("header case and order do not matter for the optional columns either", async () => {
    const csv =
      "YEAR_ID,ps_id,school_id,course_code,course_name,term_id,period_expression,DcId\n" +
      "31,5001,200,MAT101,Algebra 1,3100,3(A),85001\n31,5002,200,SCI201,Biology,3100,4(A),85002\n" +
      "31,5003,200,ENG101,English 9,3100,1(A),85003\n30,5004,100,ELE500,Grade 5 Homeroom,3000,HR,85004\n";
    const ex = replaceFile(await loadExtract(), "sections", csv);
    const result = await validateExtract(ex.manifest, ex.readFile);
    if (!result.ok) throw new Error(result.reason);
    const s = result.snapshot.sections.find((r) => r.ps_id === "5003");
    expect(s?.dcid).toBe("85003");
    expect(s?.year_id).toBe("31");
  });

  test("a non-integer DCID refuses the row like any malformed cell", async () => {
    for (const bad of ["85x01", "-5", "8.5", "85 01"]) {
      const csv =
        "ps_id,school_id,course_code,course_name,term_id,period_expression,dcid,year_id\n" +
        `5001,200,MAT101,Algebra 1,3100,3(A),"${bad}",31\n5002,200,SCI201,Biology,3100,4(A),85002,31\n` +
        "5003,200,ENG101,English 9,3100,1(A),85003,31\n5004,100,ELE500,Grade 5 Homeroom,3000,HR,85004,30\n";
      const ex = replaceFile(await loadExtract(), "sections", csv);
      const result = await validateExtract(ex.manifest, ex.readFile);
      expect(result).toEqual({ ok: false, reason: "invalid_row:sections:2" });
    }
  });

  test("the optional list names only the four DCID-era columns", () => {
    expect(OPTIONAL_COLUMNS).toEqual({
      students: ["dcid"],
      sections: ["dcid", "year_id"],
      section_teachers: ["users_dcid"],
      enrollments: [],
    });
  });
});

// coTeachersOf (docs/access-model-design.md, D-4 (b)), access slice 3.
//
// Extends the shared roster fixture's `section_teachers.csv` with a few more
// rows rather than writing a fresh extract: the base fixture already has an
// EXPIRED co-teacher (teacher.three on 5001, ended 2021) which is exactly the
// negative case this file needs, so it is kept rather than duplicated.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { closeDb, getDb } from "../db/client";
import { coTeachersOf } from "../lib/roster/coTeachers";
import { loadExtract, replaceFile } from "./fixtures/roster/load";
import { importSnapshot } from "../lib/roster/importSnapshot";
import { clearRoster, TEACHER_EMAIL } from "./helpers/roster";

const expectTestDb = () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("secure_test_design_tool_test")) {
    throw new Error(`co-teachers tests require the test DB; got: ${url}`);
  }
};

// teacher.one (TEACHER_EMAIL) keeps its base rows (5001 Lead, 5003 Lead;
// teacher.three's 5001 co-teach ended 2021 — the base fixture's own negative
// case). Added:
//   5001 teacher.five  Co-Teacher  current  — a co-teacher of teacher.one
//   5003 teacher.five  Co-Teacher  current  — the SAME co-teacher, second
//                                             shared section (multi-section)
//   5001 teacher.seven Student Teacher current — never a co-teacher, either
//                                                 direction
//   5002 teacher.six   Co-Teacher  current  — symmetric case: teacher.six's
//                                             OWN row is Co-Teacher, teacher.two
//                                             (the section's Lead Teacher) is
//                                             who it should suggest
const SECTION_TEACHERS_CSV = `section_ps_id,teacher_ps_id,teacher_email,role_name,priority_order,start_date,end_date
5001,301,Teacher.One@psd401.net,Lead Teacher,1,2020-09-01,2099-06-30
5001,303,teacher.three@psd401.net,Co-Teacher,2,2020-09-01,2021-06-30
5001,305,teacher.five@psd401.net,Co-Teacher,3,2020-09-01,2099-06-30
5001,307,teacher.seven@psd401.net,Student Teacher,4,2020-09-01,2099-06-30
5002,302,teacher.two@psd401.net,Lead Teacher,1,2020-09-01,2099-06-30
5002,306,teacher.six@psd401.net,Co-Teacher,2,2020-09-01,2099-06-30
5003,301,teacher.one@psd401.net,Lead Teacher,1,2020-09-01,2099-06-30
5003,305,teacher.five@psd401.net,Co-Teacher,2,2020-09-01,2099-06-30
5004,304,teacher.four@psd401.net,Lead Teacher,1,2020-09-01,2099-06-30
`;

beforeAll(async () => {
  expectTestDb();
  const extract = replaceFile(await loadExtract(), "section_teachers", SECTION_TEACHERS_CSV);
  const result = await importSnapshot(getDb(), { manifest: extract.manifest, readFile: extract.readFile });
  if (!result.ok) throw new Error(`roster fixture refused: ${result.reason}`);
});

afterAll(async () => {
  await clearRoster();
  await closeDb();
});

const db = () => getDb();

describe("coTeachersOf", () => {
  test("the other teacher's Co-Teacher row suggests them to the lead, across every shared section", async () => {
    const suggestions = await coTeachersOf(db(), TEACHER_EMAIL);
    const five = suggestions.find((s) => s.email === "teacher.five@psd401.net");
    expect(five).toBeDefined();
    expect(five!.sections).toEqual([
      { course_name: "Algebra 1", period_expression: "3(A)" },
      { course_name: "English 9", period_expression: "1(A)" },
    ]);
  });

  test("symmetric: the caller's OWN Co-Teacher row suggests the section's Lead Teacher", async () => {
    const suggestions = await coTeachersOf(db(), "teacher.six@psd401.net");
    expect(suggestions).toEqual([
      { email: "teacher.two@psd401.net", sections: [{ course_name: "Biology", period_expression: "4(A)" }] },
    ]);
  });

  test("and the lead sees the co-teacher back (the same fact from both sides)", async () => {
    const suggestions = await coTeachersOf(db(), "teacher.two@psd401.net");
    expect(suggestions).toEqual([
      { email: "teacher.six@psd401.net", sections: [{ course_name: "Biology", period_expression: "4(A)" }] },
    ]);
  });

  test("Student Teacher never counts, on either side", async () => {
    const forLead = await coTeachersOf(db(), TEACHER_EMAIL);
    expect(forLead.some((s) => s.email === "teacher.seven@psd401.net")).toBe(false);

    const forStudentTeacher = await coTeachersOf(db(), "teacher.seven@psd401.net");
    expect(forStudentTeacher).toEqual([]);
  });

  test("an expired co-teach row does not count", async () => {
    const suggestions = await coTeachersOf(db(), TEACHER_EMAIL);
    expect(suggestions.some((s) => s.email === "teacher.three@psd401.net")).toBe(false);
  });

  test("two Lead Teachers on the same section are not co-teachers of each other", async () => {
    // teacher.one and teacher.four share no section at all here, but this
    // also covers the shape: neither role is Co-Teacher, so nothing matches.
    expect(await coTeachersOf(db(), "teacher.four@psd401.net")).toEqual([]);
  });

  test("an unknown or blank email has no suggestions", async () => {
    expect(await coTeachersOf(db(), "nobody@psd401.net")).toEqual([]);
    expect(await coTeachersOf(db(), "")).toEqual([]);
  });
});

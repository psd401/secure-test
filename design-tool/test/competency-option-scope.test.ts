// F-2 (hand-run 2026-11-02, docs/competency-assessment-design.md D-4): on a
// district assessment, a student's progress and results count only the option
// they were given (plus questions in no set). Two students on two options,
// and a stray answer on the other option (as a switch leaves behind), pin it.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { closeDb, getDb } from "../db/client";
import {
  assessments,
  attempts,
  competency_assignments,
  item_sets,
  items,
  responses,
  scores,
  students,
  test_sessions,
} from "../db/schema";
import { buildResults } from "../lib/scoring/results";
import { attendanceForSitting } from "../lib/api/sittingAttendance";
import { inStudentOption, optionByStudent } from "../lib/competency/studentItems";
import { OTHER_STUDENT, STUDENT, clearRoster, seedRoster } from "./helpers/roster";

const OWNER = "assessment-office-sub";

const expectTestDb = () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("secure_test_design_tool_test")) {
    throw new Error(`option-scope tests require the test DB; got: ${url}`);
  }
};

beforeAll(async () => {
  expectTestDb();
  await clearRoster();
  await seedRoster();
});

afterEach(async () => {
  const db = getDb();
  await db.execute(sql`truncate table assessments restart identity cascade`);
  await db.execute(sql`truncate table students restart identity cascade`);
});

afterAll(async () => {
  await clearRoster();
  await closeDb();
});

describe("inStudentOption", () => {
  test("no option known keeps every question; otherwise the option's and the shared ones", () => {
    expect(inStudentOption({ item_set_id: "b" }, undefined)).toBe(true);
    expect(inStudentOption({ item_set_id: null }, "a")).toBe(true);
    expect(inStudentOption({ item_set_id: "a" }, "a")).toBe(true);
    expect(inStudentOption({ item_set_id: "b" }, "a")).toBe(false);
  });
});

/**
 * Two options of two essays each plus one shared essay (worth 1 point each).
 * STUDENT takes option 1, OTHER_STUDENT option 2; each answers their own
 * questions and the shared one, all scored 1. STUDENT also has a stray answer
 * on option 2's first question.
 */
async function seed(scope: "district" | "teacher", attemptStatus: "submitted" | "in_progress" = "submitted") {
  const db = getDb();
  const [a] = await db
    .insert(assessments)
    .values({ owner_sub: OWNER, name: "CBA", assigned_scope: scope })
    .returning();
  const [s1, s2] = await db
    .insert(item_sets)
    .values([{ assessment_id: a!.id }, { assessment_id: a!.id }])
    .returning();
  const its = await db
    .insert(items)
    .values([
      { assessment_id: a!.id, item_set_id: s1!.id, position: 0, type: "essay", stem: "1a" },
      { assessment_id: a!.id, item_set_id: s1!.id, position: 1, type: "essay", stem: "1b" },
      { assessment_id: a!.id, item_set_id: s2!.id, position: 2, type: "essay", stem: "2a" },
      { assessment_id: a!.id, item_set_id: s2!.id, position: 3, type: "essay", stem: "2b" },
      { assessment_id: a!.id, position: 4, type: "essay", stem: "shared" },
    ])
    .returning();
  const [i1a, i1b, i2a, i2b, shared] = its as [typeof its[0], typeof its[0], typeof its[0], typeof its[0], typeof its[0]];
  const [sitting] = await db
    .insert(test_sessions)
    .values({
      assessment_id: a!.id,
      owner_sub: OWNER,
      code: "QWE234",
      expires_at: new Date(Date.now() + 3600e3),
      student_ps_ids: [STUDENT.ps_id, OTHER_STUDENT.ps_id],
    })
    .returning();
  const students_ = [
    { ps: STUDENT.ps_id, set: s1!.id, answers: [i1a!, i1b!, shared!, i2a!] },
    { ps: OTHER_STUDENT.ps_id, set: s2!.id, answers: [i2a!, i2b!, shared!] },
  ];
  const attemptByPs = new Map<string, string>();
  for (const st of students_) {
    await db.insert(competency_assignments).values({
      assessment_id: a!.id,
      student_ps_id: st.ps,
      item_set_id: st.set,
      proctor_email: "cba-proctor@psd401.net",
      assigned_by_sub: OWNER,
      assigned_by_email: "assessment-office@psd401.net",
    });
    const [stu] = await db.insert(students).values({ owner_sub: OWNER, roster_ps_id: st.ps, name: st.ps }).returning();
    const [att] = await db
      .insert(attempts)
      .values({
        assessment_id: a!.id,
        student_id: stu!.id,
        test_session_id: sitting!.id,
        status: attemptStatus,
        ...(attemptStatus === "submitted" ? { submitted_at: new Date() } : {}),
      })
      .returning();
    attemptByPs.set(st.ps, att!.id);
    for (const it of st.answers) {
      const [r] = await db
        .insert(responses)
        .values({ attempt_id: att!.id, item_id: it.id, response: { type: "essay", text: "x" } })
        .returning();
      await db.insert(scores).values({
        response_id: r!.id,
        method: "human",
        points: 1,
        max_points: 1,
        scorer: OWNER,
        status: "final",
      });
    }
  }
  return { a: a!, sitting: sitting!, attemptByPs };
}

describe("class results", () => {
  test("a district row counts its own option: other cells not_assigned, max and percent from the option", async () => {
    const { a, attemptByPs } = await seed("district");
    const res = await buildResults(a.id);
    const row = res.rows.find((r) => r.attempt_id === attemptByPs.get(STUDENT.ps_id))!;
    expect(row.cells.map((c) => c.status)).toEqual(["final", "final", "not_assigned", "not_assigned", "final"]);
    expect(row.max_points).toBe(3);
    expect(row.total_points).toBe(3);
    expect(row.percent).toBe(100);
    expect(row.answered_count).toBe(3);
    const other = res.rows.find((r) => r.attempt_id === attemptByPs.get(OTHER_STUDENT.ps_id))!;
    expect(other.cells.map((c) => c.status)).toEqual(["not_assigned", "not_assigned", "final", "final", "final"]);
    expect(other.max_points).toBe(3);
  });

  test("a classroom assessment is unchanged: every question counts", async () => {
    const { a, attemptByPs } = await seed("teacher");
    const res = await buildResults(a.id);
    const row = res.rows.find((r) => r.attempt_id === attemptByPs.get(STUDENT.ps_id))!;
    expect(row.cells.some((c) => c.status === "not_assigned")).toBe(false);
    expect(row.max_points).toBe(5);
    expect(row.total_points).toBe(4);
  });
});

describe("Monitor progress", () => {
  test("a district row's total and answered count its own option only", async () => {
    const { sitting } = await seed("district", "in_progress");
    const att = await attendanceForSitting(getDb(), sitting);
    const mine = att.rows.find((r) => r.ps_id === STUDENT.ps_id)!;
    expect([mine.answered, mine.total_items]).toEqual([3, 3]);
    const theirs = att.rows.find((r) => r.ps_id === OTHER_STUDENT.ps_id)!;
    expect([theirs.answered, theirs.total_items]).toEqual([3, 3]);
  });

  test("a classroom sitting is unchanged", async () => {
    const { sitting } = await seed("teacher", "in_progress");
    const att = await attendanceForSitting(getDb(), sitting);
    const mine = att.rows.find((r) => r.ps_id === STUDENT.ps_id)!;
    expect([mine.answered, mine.total_items]).toEqual([4, 5]);
  });
});

describe("optionByStudent", () => {
  test("the live assignment wins; a withdrawn-only student reads their last option", async () => {
    const { a } = await seed("district");
    const db = getDb();
    const before = await optionByStudent(db, a.id, [STUDENT.ps_id]);
    await db.execute(sql`update competency_assignments set status = 'withdrawn' where student_ps_id = ${STUDENT.ps_id}`);
    const after = await optionByStudent(db, a.id, [STUDENT.ps_id]);
    expect(after.get(STUDENT.ps_id)).toBe(before.get(STUDENT.ps_id));
    expect(after.has(STUDENT.ps_id)).toBe(true);
  });
});

// attemptStatsByAssessment (lib/api/teacherSummary.ts): the per-assessment
// counts behind the dashboard list. DB test — run with the test DATABASE_URL.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { closeDb, getDb } from "../db/client";
import { assessments, attempts, students } from "../db/schema";
import { attemptStatsByAssessment } from "../lib/api/teacherSummary";

beforeAll(() => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("secure_test_design_tool_test")) {
    throw new Error(`teacher-summary tests require the test DB; got: ${url}`);
  }
});

afterEach(async () => {
  const db = getDb();
  await db.execute(sql`truncate table assessments restart identity cascade`);
  await db.execute(sql`truncate table students restart identity cascade`);
});

afterAll(async () => {
  await closeDb();
});

async function student(owner: string, practiceFor?: string) {
  const [s] = await getDb()
    .insert(students)
    .values({ owner_sub: owner, name: "Fixture", practice_for_sub: practiceFor ?? null })
    .returning();
  return s!;
}

describe("attemptStatsByAssessment", () => {
  test("attemptStatsByAssessment: n counts every attempt, students/submitted skip practice", async () => {
    const db = getDb();
    const [a] = await db
      .insert(assessments)
      .values({ owner_sub: "t-a", owner_email: "a@example.org", name: "A1", status: "published" })
      .returning();
    const [other] = await db
      .insert(assessments)
      .values({ owner_sub: "t-b", owner_email: "b@example.org", name: "B1", status: "published" })
      .returning();
    const st1 = await student("t-a");
    const st2 = await student("t-a");
    const st3 = await student("t-a");
    const staff = await student("t-a", "t-a");
    // One attempt per (assessment, student) — attempts_assessment_student_unq.
    await db.insert(attempts).values([
      { assessment_id: a!.id, student_id: st1.id, status: "submitted", submitted_at: new Date() },
      { assessment_id: a!.id, student_id: st3.id, status: "in_progress" },
      { assessment_id: a!.id, student_id: st2.id, status: "submitted", submitted_at: new Date() },
      { assessment_id: a!.id, student_id: staff.id, status: "submitted", submitted_at: new Date() },
      { assessment_id: other!.id, student_id: st2.id, status: "in_progress" },
    ]);

    const all = await attemptStatsByAssessment(db, undefined);
    const forA = all.find((r) => r.assessment_id === a!.id)!;
    // 4 attempts in all (Delete's gate); 3 real students, 2 real submissions —
    // the staff practice attempt counts toward n only.
    expect(forA).toMatchObject({ n: 4, students: 3, submitted: 2 });
    expect(all).toHaveLength(2);

    // The scope narrows the rows, the same way the page passes visible.condition.
    const scoped = await attemptStatsByAssessment(db, eq(assessments.owner_sub, "t-b"));
    expect(scoped).toEqual([{ assessment_id: other!.id, n: 1, students: 1, submitted: 0 }]);
  });
});

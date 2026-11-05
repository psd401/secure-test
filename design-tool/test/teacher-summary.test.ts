// Admin "By teacher" summary (lib/api/teacherSummary.ts): one row per owner
// with assessment, sitting and student-participation counts. DB test — run
// with the test DATABASE_URL.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { closeDb, getDb } from "../db/client";
import { assessments, attempts, students, test_sessions } from "../db/schema";
import { teacherSummary } from "../lib/api/teacherSummary";

const HOUR = 3_600_000;

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

async function sitting(assessmentId: string, owner: string, kind: "class" | "practice" = "class") {
  const [s] = await getDb()
    .insert(test_sessions)
    .values({
      assessment_id: assessmentId,
      owner_sub: owner,
      code: `T${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
      expires_at: new Date(Date.now() + HOUR),
      kind,
      ...(kind === "practice" ? { practice_for_sub: owner } : {}),
    })
    .returning();
  return s!;
}

async function student(owner: string, practiceFor?: string) {
  const [s] = await getDb()
    .insert(students)
    .values({ owner_sub: owner, name: "Fixture", practice_for_sub: practiceFor ?? null })
    .returning();
  return s!;
}

describe("teacherSummary", () => {
  test("rolls up assessments, class sittings and distinct students per owner", async () => {
    const db = getDb();
    const [a1, a2, a3] = await db
      .insert(assessments)
      .values([
        { owner_sub: "t-a", owner_email: "a@example.org", name: "A1", status: "published" },
        { owner_sub: "t-a", owner_email: "a@example.org", name: "A2", status: "draft", archived_at: new Date() },
        { owner_sub: "t-b", owner_email: "b@example.org", name: "B1", status: "draft" },
      ])
      .returning();

    const s1 = await sitting(a1!.id, "t-a");
    await sitting(a1!.id, "t-a");
    const practice = await sitting(a1!.id, "t-a", "practice");

    // Two students; one sits A1 twice (distinct count stays 2), one in progress.
    const st1 = await student("t-a");
    const st2 = await student("t-a");
    const staff = await student("t-a", "t-a");
    await db.insert(attempts).values([
      { assessment_id: a1!.id, student_id: st1.id, test_session_id: s1.id, status: "submitted", submitted_at: new Date() },
      { assessment_id: a2!.id, student_id: st1.id, status: "submitted", submitted_at: new Date() },
      { assessment_id: a1!.id, student_id: st2.id, test_session_id: s1.id, status: "in_progress" },
      // A practice attempt by the teacher: not a student, not counted.
      { assessment_id: a1!.id, student_id: staff.id, test_session_id: practice.id, status: "submitted", submitted_at: new Date() },
    ]);

    const rows = await teacherSummary(db);
    const a = rows.find((r) => r.owner_sub === "t-a")!;
    const b = rows.find((r) => r.owner_sub === "t-b")!;

    expect(a).toMatchObject({
      owner_email: "a@example.org",
      assessments: 2,
      drafts: 1,
      published: 1,
      archived: 1,
      sittings: 2,
      students: 2,
      submitted: 2,
    });
    expect(a.last_activity).toBeInstanceOf(Date);

    expect(b).toMatchObject({ assessments: 1, drafts: 1, sittings: 0, students: 0, submitted: 0 });
    expect(rows).toHaveLength(2);
  });

  test("no assessments, no rows", async () => {
    expect(await teacherSummary(getDb())).toEqual([]);
  });
});

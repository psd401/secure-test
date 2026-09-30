// Student lookup (roadmap U-11's operator half, 2026-09-30): the verdict must
// match what the join routes decide, and the output must carry no name and
// no stored address.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { closeDb, getDb } from "../db/client";
import { assessments, roster_students, test_sessions } from "../db/schema";
import { lookupStudent } from "../lib/roster/lookup";
import { emailRef } from "../lib/api/resolutionLog";

process.env.DESIGN_TOOL_SESSION_SECRET ??= "student-lookup-test-secret";
import {
  LEFT_STUDENT,
  STUDENT,
  TEACHER_EMAIL,
  clearRoster,
  seedRoster,
} from "./helpers/roster";

const expectTestDb = () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("secure_test_design_tool_test")) {
    throw new Error(`student-lookup tests require the test DB; got: ${url}`);
  }
};

const TEACHER = "lookup-teacher-sub";
const db = () => getDb();

beforeAll(async () => {
  expectTestDb();
  await seedRoster();
});

afterEach(async () => {
  await db().execute(sql`truncate table assessments restart identity cascade`);
  await db().delete(roster_students).where(eq(roster_students.ps_id, "9999"));
});

afterAll(async () => {
  await clearRoster();
  await closeDb();
});

async function openSitting(code: string, owner_email: string | null, extra: Partial<typeof test_sessions.$inferInsert> = {}) {
  const [a] = await db()
    .insert(assessments)
    .values({ owner_sub: TEACHER, name: `Lookup ${code}`, status: "published" })
    .returning();
  await db().insert(test_sessions).values({
    assessment_id: a!.id,
    owner_sub: TEACHER,
    owner_email,
    code,
    status: "open",
    expires_at: new Date(Date.now() + 3_600_000),
    ...extra,
  });
}

describe("lookupStudent", () => {
  test("a rostered student by email: ok, current enrollment, admitted to the teacher's sitting", async () => {
    await openSitting("LKOPEN", TEACHER_EMAIL);
    await openSitting("LKOTHR", "someone.else@psd401.net");
    const r = await lookupStudent(db(), { email: STUDENT.email.toUpperCase() });
    expect(r.verdict).toBe("ok");
    expect(r.active_rows_with_email).toBe(1);
    // The same ref student_resolution_failed carries for this address.
    expect(r.email_ref).toBe(emailRef(STUDENT.email));
    expect(r.email_ref).toMatch(/^[0-9a-f]{16}$/);
    expect(r.students).toEqual([
      expect.objectContaining({ ps_id: STUDENT.ps_id, email_is_student_shape: true, email_matches_query: true }),
    ]);
    expect(r.enrollments.some((e) => e.enrollment_current)).toBe(true);
    expect(r.enrollments.flatMap((e) => e.teachers.map((t) => t.email))).toContain(TEACHER_EMAIL);
    // The unrelated teacher's sitting neither admits nor belongs to a teacher of hers.
    expect(r.sittings.map((s) => [s.code, s.admitted])).toEqual([["LKOPEN", true]]);
  });

  test("an address nobody carries: not_on_roster, nothing else", async () => {
    const r = await lookupStudent(db(), { email: "nobody@edtools.psd401.net" });
    expect(r).toMatchObject({ verdict: "not_on_roster", students: [], enrollments: [], sittings: [] });
  });

  test("by student number: the verdict is about the stored address", async () => {
    const r = await lookupStudent(db(), { psId: STUDENT.ps_id });
    expect(r.verdict).toBe("ok");
    expect(r.students[0]).not.toHaveProperty("email_matches_query");
    expect(r.students[0]!.email_domain).toBe("edtools.psd401.net");
  });

  test("a student whose enrollment ended: listed, not current, the teacher's sitting does not admit", async () => {
    await openSitting("LKLEFT", TEACHER_EMAIL);
    const r = await lookupStudent(db(), { psId: LEFT_STUDENT.ps_id });
    expect(r.enrollments.length).toBeGreaterThan(0);
    expect(r.enrollments.every((e) => !e.enrollment_current)).toBe(true);
    expect(r.sittings).toEqual([expect.objectContaining({ code: "LKLEFT", admitted: false })]);
  });

  test("two active rows sharing the address: identity_conflict", async () => {
    // A copy of the fixture row under another ps_id, same address.
    await db().execute(sql`
      insert into roster_students (ps_id, email, first_name, last_name, enroll_status, is_active, last_seen_snapshot_id)
      select '9999', email, 'Dup', 'Row', enroll_status, true, last_seen_snapshot_id
      from roster_students where ps_id = ${STUDENT.ps_id}
    `);
    const r = await lookupStudent(db(), { email: STUDENT.email });
    expect(r.verdict).toBe("identity_conflict");
    expect(r.active_rows_with_email).toBe(2);
    expect(r.enrollments).toEqual([]);
  });

  test("the result carries no student name and no stored address", async () => {
    await openSitting("LKPII1", TEACHER_EMAIL);
    const out = JSON.stringify(await lookupStudent(db(), { psId: STUDENT.ps_id }));
    expect(out).not.toContain(STUDENT.email);
    for (const part of STUDENT.name.split(" ")) expect(out).not.toContain(part);
  });
});

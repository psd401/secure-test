// Slice 83: the sittings a student may join right now, as the client lists them.
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { sql } from "drizzle-orm";
import { closeDb, getDb } from "../db/client";
import { assessments, attempts, students, test_sessions } from "../db/schema";
import { SESSION_COOKIE_NAME } from "../lib/auth/session";
import * as sessionMod from "../lib/auth/session";
import {
  BIOLOGY_STUDENT,
  OTHER_STUDENT,
  STUDENT,
  TEACHER_EMAIL,
  OTHER_TEACHER_EMAIL,
  clearRoster,
  seedRoster,
  staffPrincipal,
  studentPrincipal,
} from "./helpers/roster";

const expectTestDb = () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("secure_test_design_tool_test")) {
    throw new Error(`my-sittings tests require the test DB; got: ${url}`);
  }
};

const TEACHER = "mysittings-teacher";
const OTHER_TEACHER = "mysittings-other-teacher";

type Principal = { sub: string; role: string; email?: string } | null;
let principal: Principal = null;

mock.module("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({
    get: (name: string) =>
      principal && name === SESSION_COOKIE_NAME ? { value: "x" } : undefined,
  }),
}));

mock.module("../lib/auth/session", () => ({
  ...sessionMod,
  readSessionFromCookies: async () => principal,
}));

beforeAll(async () => {
  expectTestDb();
  await seedRoster();
});

afterEach(async () => {
  principal = null;
  const db = getDb();
  await db.execute(sql`truncate table assessments restart identity cascade`);
  await db.execute(sql`truncate table students restart identity cascade`);
});

afterAll(async () => {
  await clearRoster();
  await closeDb();
});

async function seedAssessment(owner: string, name: string) {
  const [row] = await getDb()
    .insert(assessments)
    .values({ owner_sub: owner, name, status: "published" })
    .returning();
  return row!;
}

async function createSitting(body: Record<string, unknown>) {
  const { POST } = await import("../app/api/test-sessions/route");
  const res = await POST(
    new Request("http://localhost/api/test-sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { test_session: { id: string } }).test_session;
}

async function mySittings() {
  const { GET } = await import("../app/api/me/sittings/route");
  return GET();
}

type Row = {
  test_session_id: string;
  code: string;
  assessment_name: string;
  scope: string;
  section_label: string | null;
  teacher_email: string | null;
  attempt: { id: string; status: string } | null;
};

async function listAs(email: string): Promise<{ sittings: Row[]; reason?: string }> {
  principal = studentPrincipal(email);
  const res = await mySittings();
  expect(res.status).toBe(200);
  return (await res.json()) as { sittings: Row[]; reason?: string };
}

describe("GET /api/me/sittings", () => {
  test("lists exactly the open sittings whose scope admits the student", async () => {
    principal = staffPrincipal(TEACHER);
    const algebra = await seedAssessment(TEACHER, "Algebra quiz");
    const all = await createSitting({ assessment_id: algebra.id });
    const english = await createSitting({ assessment_id: algebra.id, section_ps_id: "5003" });
    const benOnly = await createSitting({ assessment_id: algebra.id, student_ps_ids: [OTHER_STUDENT.ps_id] });
    const closed = await createSitting({ assessment_id: algebra.id });
    {
      const { POST } = await import("../app/api/test-sessions/[sessionId]/close/route");
      await POST(new Request("http://localhost/x", { method: "POST" }), {
        params: Promise.resolve({ sessionId: closed.id }),
      });
    }
    // Expired: inserted directly, since the route will not mint one.
    await getDb().insert(test_sessions).values({
      assessment_id: algebra.id,
      owner_sub: TEACHER,
      owner_email: TEACHER_EMAIL,
      code: "EXPIRD",
      status: "open",
      expires_at: new Date(Date.now() - 60_000),
    });
    principal = staffPrincipal(OTHER_TEACHER, OTHER_TEACHER_EMAIL);
    const biology = await seedAssessment(OTHER_TEACHER, "Biology lab");
    const bio = await createSitting({ assessment_id: biology.id });

    // Ada: in 5001 and 5003 → "all" and the English section; not Ben's list.
    const ada = await listAs(STUDENT.email);
    expect(ada.reason).toBeUndefined();
    expect(ada.sittings.map((s) => s.test_session_id).sort()).toEqual([all.id, english.id].sort());
    const englishRow = ada.sittings.find((s) => s.test_session_id === english.id)!;
    expect(englishRow).toMatchObject({
      assessment_name: "Algebra quiz",
      scope: "section",
      teacher_email: TEACHER_EMAIL,
      attempt: null,
    });
    expect(englishRow.section_label).toContain("English");
    expect(ada.sittings.find((s) => s.test_session_id === all.id)!.scope).toBe("sections");

    // Ben: in 5001 only → "all" and his explicit list; not the English section.
    const ben = await listAs(OTHER_STUDENT.email);
    expect(ben.sittings.map((s) => s.test_session_id).sort()).toEqual([all.id, benOnly.id].sort());
    expect(ben.sittings.find((s) => s.test_session_id === benOnly.id)!.scope).toBe("students");

    // Cy: teacher.two's only.
    const cy = await listAs(BIOLOGY_STUDENT.email);
    expect(cy.sittings.map((s) => s.test_session_id)).toEqual([bio.id]);
    expect(cy.sittings[0]!.assessment_name).toBe("Biology lab");
  });

  test("carries the student's existing attempt in a sitting", async () => {
    principal = staffPrincipal(TEACHER);
    const a = await seedAssessment(TEACHER, "Quiz");
    const sitting = await createSitting({ assessment_id: a.id });
    const db = getDb();
    const [overlay] = await db
      .insert(students)
      .values({ owner_sub: TEACHER, roster_ps_id: STUDENT.ps_id, name: "Ada" })
      .returning();
    const [attempt] = await db
      .insert(attempts)
      .values({ assessment_id: a.id, student_id: overlay!.id, test_session_id: sitting.id, status: "submitted", submitted_at: new Date() })
      .returning();

    const ada = await listAs(STUDENT.email);
    expect(ada.sittings[0]!.attempt).toMatchObject({ id: attempt!.id, status: "submitted" });
    const ben = await listAs(OTHER_STUDENT.email);
    expect(ben.sittings[0]!.attempt).toBeNull();
  });

  // Finding 8.2 (2026-08-28): an in-progress attempt follows the student to
  // the sitting they rejoined through, so the list shows it there — and only
  // there.
  test("finding 8.2: a rejoin through a new sitting carries the attempt to that sitting", async () => {
    principal = staffPrincipal(TEACHER);
    const a = await seedAssessment(TEACHER, "Quiz");
    const first = await createSitting({ assessment_id: a.id });
    const second = await createSitting({ assessment_id: a.id });
    const db = getDb();
    const [overlay] = await db
      .insert(students)
      .values({ owner_sub: TEACHER, roster_ps_id: STUDENT.ps_id, name: "Ada" })
      .returning();
    const [attempt] = await db
      .insert(attempts)
      .values({ assessment_id: a.id, student_id: overlay!.id, test_session_id: first.id, status: "in_progress" })
      .returning();

    principal = studentPrincipal(STUDENT.email);
    const { POST: join } = await import("../app/api/attempts/route");
    const joined = await join(
      new Request("http://localhost/api/attempts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ test_session_id: second.id }),
      }),
    );
    expect(joined.status).toBe(200);

    const ada = await listAs(STUDENT.email);
    const bySitting = new Map(ada.sittings.map((s) => [s.test_session_id, s]));
    expect(bySitting.get(second.id)!.attempt).toMatchObject({ id: attempt!.id, status: "in_progress" });
    expect(bySitting.get(first.id)!.attempt).toBeNull();
  });

  // Finding 10.2 (2026-08-29): a test handed in through a sitting that has since
  // closed must read as done on the teacher's next sitting for it — the join
  // would return that submitted attempt unmoved and refuse every save, so a
  // row that says "Join" is a lie the client acted on (finding 10.1).
  test("finding 10.2: a submitted attempt reads as done on every sitting of that assessment", async () => {
    principal = staffPrincipal(TEACHER);
    const a = await seedAssessment(TEACHER, "Quiz");
    const other = await seedAssessment(TEACHER, "Other quiz");
    const first = await createSitting({ assessment_id: a.id });
    const db = getDb();
    const [overlay] = await db
      .insert(students)
      .values({ owner_sub: TEACHER, roster_ps_id: STUDENT.ps_id, name: "Ada" })
      .returning();
    const [attempt] = await db
      .insert(attempts)
      .values({
        assessment_id: a.id,
        student_id: overlay!.id,
        test_session_id: first.id,
        status: "submitted",
        submitted_at: new Date(),
      })
      .returning();
    {
      const { POST } = await import("../app/api/test-sessions/[sessionId]/close/route");
      await POST(new Request("http://localhost/x", { method: "POST" }), {
        params: Promise.resolve({ sessionId: first.id }),
      });
    }
    const second = await createSitting({ assessment_id: a.id });
    const unrelated = await createSitting({ assessment_id: other.id });

    const ada = await listAs(STUDENT.email);
    const bySitting = new Map(ada.sittings.map((s) => [s.test_session_id, s]));
    expect(bySitting.has(first.id)).toBe(false);
    expect(bySitting.get(second.id)!.attempt).toMatchObject({ id: attempt!.id, status: "submitted" });
    expect(bySitting.get(unrelated.id)!.attempt).toBeNull();
    // Finding 10.5: the row carries the code the teacher reads out.
    expect(bySitting.get(second.id)!.code).toMatch(/^[A-Z0-9]{6}$/);
  });

  test("explains an account that cannot be listed, and refuses staff", async () => {
    const stranger = await listAs("nobody.here@edtools.psd401.net");
    expect(stranger).toEqual({ sittings: [], reason: "not_on_roster" });

    principal = { sub: "no-email-student", role: "student" };
    expect(await (await mySittings()).json()).toEqual({ sittings: [], reason: "no_email" });

    principal = staffPrincipal(TEACHER);
    expect((await mySittings()).status).toBe(403);
  });

  test("does not create an accommodations overlay row just by listing", async () => {
    principal = staffPrincipal(TEACHER);
    const a = await seedAssessment(TEACHER, "Quiz");
    await createSitting({ assessment_id: a.id });
    await listAs(STUDENT.email);
    const rows = await getDb().select().from(students);
    expect(rows).toHaveLength(0);
  });
});

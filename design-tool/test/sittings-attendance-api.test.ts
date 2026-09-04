// Slice 82: the roster picker behind sitting creation, and attendance — who a
// sitting expects versus who has joined or submitted.
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { sql } from "drizzle-orm";
import { closeDb, getDb } from "../db/client";
import { assessments, attempts, items, responses, students } from "../db/schema";
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
    throw new Error(`attendance tests require the test DB; got: ${url}`);
  }
};

const TEACHER = "attendance-teacher";
const OTHER_TEACHER = "attendance-other-teacher";

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

async function seedAssessment(owner = TEACHER) {
  const [row] = await getDb()
    .insert(assessments)
    .values({ owner_sub: owner, name: "Attendance", status: "published" })
    .returning();
  if (!row) throw new Error("seed failed");
  return row;
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

async function rosterStudents(query = "") {
  const { GET } = await import("../app/api/roster/students/route");
  return GET(new Request(`http://localhost/api/roster/students${query}`));
}

async function attendance(sessionId: string) {
  const { GET } = await import("../app/api/test-sessions/[sessionId]/attendance/route");
  return GET(new Request("http://localhost/x"), { params: Promise.resolve({ sessionId }) });
}

/** An overlay row bound to a roster student, plus an attempt in the sitting. */
async function joinAs(
  owner: string,
  rosterPsId: string,
  assessmentId: string,
  sessionId: string,
  status: "in_progress" | "submitted",
) {
  const db = getDb();
  const [st] = await db
    .insert(students)
    .values({ owner_sub: owner, roster_ps_id: rosterPsId, name: `overlay ${rosterPsId}` })
    .returning();
  await db.insert(attempts).values({
    assessment_id: assessmentId,
    student_id: st!.id,
    test_session_id: sessionId,
    status,
    submitted_at: status === "submitted" ? new Date() : null,
  });
}

describe("GET /api/roster/students", () => {
  test("lists the students in the teacher's current sections, once each", async () => {
    principal = staffPrincipal(TEACHER);
    const res = await rosterStudents();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      students: { ps_id: string; name: string; sections: { ps_id: string }[] }[];
    };
    const ids = body.students.map((s) => s.ps_id);
    expect(ids).toContain(STUDENT.ps_id);
    expect(ids).toContain(OTHER_STUDENT.ps_id);
    expect(ids).not.toContain(BIOLOGY_STUDENT.ps_id); // teacher.two's
    expect(ids).not.toContain("1004"); // left in 2021
    // Ada is in 5001 and 5003 — one row, two sections.
    const ada = body.students.find((s) => s.ps_id === STUDENT.ps_id)!;
    expect(ada.sections.map((s) => s.ps_id).sort()).toEqual(["5001", "5003"]);
    expect(ada.name).toBe("Fixture, Ada"); // studentDisplayName: "Last, First"
  });

  test("narrows to one section", async () => {
    principal = staffPrincipal(TEACHER);
    const res = await rosterStudents("?section_ps_id=5003");
    const body = (await res.json()) as { students: { ps_id: string }[] };
    expect(body.students.map((s) => s.ps_id)).toEqual([STUDENT.ps_id]);
  });

  test("is empty without an email, and refused for students", async () => {
    principal = { sub: TEACHER, role: "staff" };
    expect(((await (await rosterStudents()).json()) as { students: unknown[] }).students).toEqual([]);
    principal = studentPrincipal();
    expect((await rosterStudents()).status).toBe(403);
  });
});

describe("POST /api/test-sessions on a draft", () => {
  test("is refused with not_published", async () => {
    principal = staffPrincipal(TEACHER);
    const [draft] = await getDb()
      .insert(assessments)
      .values({ owner_sub: TEACHER, name: "Draft" })
      .returning();
    const { POST } = await import("../app/api/test-sessions/route");
    const res = await POST(
      new Request("http://localhost/api/test-sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ assessment_id: draft!.id }),
      }),
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("not_published");
  });
});

describe("GET /api/test-sessions/:id/attendance", () => {
  test("is 404 for a sitting the caller does not own", async () => {
    principal = staffPrincipal(OTHER_TEACHER, OTHER_TEACHER_EMAIL);
    const a = await seedAssessment(OTHER_TEACHER);
    const sitting = await createSitting({ assessment_id: a.id });
    principal = staffPrincipal(TEACHER);
    expect((await attendance(sitting.id)).status).toBe(404);
    expect((await attendance("not-a-uuid")).status).toBe(400);
  });

  test("expects one section's students and reports each as not joined", async () => {
    principal = staffPrincipal(TEACHER);
    const a = await seedAssessment();
    const sitting = await createSitting({ assessment_id: a.id, section_ps_id: "5001" });
    const res = await attendance(sitting.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      test_session: { code: string };
      rows: { ps_id: string; status: string; section_label: string | null; in_scope: boolean }[];
      counts: { expected: number; joined: number; submitted: number };
    };
    expect(body.test_session.code).toHaveLength(6);
    expect(body.rows.map((r) => r.ps_id).sort()).toEqual([STUDENT.ps_id, OTHER_STUDENT.ps_id]);
    expect(body.rows.every((r) => r.status === "not_joined" && r.in_scope)).toBe(true);
    expect(body.rows[0]!.section_label).toContain("Algebra");
    expect(body.counts).toEqual({ expected: 2, joined: 0, submitted: 0 });
  });

  test("shows in-progress and submitted attempts against the expected list", async () => {
    principal = staffPrincipal(TEACHER);
    const a = await seedAssessment();
    const sitting = await createSitting({ assessment_id: a.id });
    await joinAs(TEACHER, STUDENT.ps_id, a.id, sitting.id, "in_progress");
    await joinAs(TEACHER, OTHER_STUDENT.ps_id, a.id, sitting.id, "submitted");
    const body = (await (await attendance(sitting.id)).json()) as {
      rows: {
        ps_id: string;
        status: string;
        started_at: string | null;
        submitted_at: string | null;
        attempt_id: string | null;
      }[];
      counts: { expected: number; joined: number; submitted: number };
    };
    const byId = new Map(body.rows.map((r) => [r.ps_id, r]));
    expect(byId.get(STUDENT.ps_id)!.status).toBe("in_progress");
    expect(byId.get(STUDENT.ps_id)!.started_at).not.toBeNull();
    // Peek P3: the monitor's Peek button posts against this id.
    expect(byId.get(STUDENT.ps_id)!.attempt_id).not.toBeNull();
    expect(byId.get(STUDENT.ps_id)!.submitted_at).toBeNull();
    expect(byId.get(OTHER_STUDENT.ps_id)!.status).toBe("submitted");
    expect(byId.get(OTHER_STUDENT.ps_id)!.submitted_at).not.toBeNull();
    expect(body.counts).toEqual({ expected: 2, joined: 2, submitted: 1 });
  });

  test("slice 85: progress — answered of total, last activity, and a change cursor", async () => {
    principal = staffPrincipal(TEACHER);
    const a = await seedAssessment();
    const db = getDb();
    const seeded = await db
      .insert(items)
      .values([1, 2, 3].map((n) => ({ assessment_id: a.id, position: n, type: "mc", stem: `Q${n}` })))
      .returning();
    const sitting = await createSitting({ assessment_id: a.id, section_ps_id: "5001" });
    // Ada answered two of three; her last save is the newest activity.
    const [ada] = await db
      .insert(students)
      .values({ owner_sub: TEACHER, roster_ps_id: STUDENT.ps_id, name: "Ada" })
      .returning();
    const startedAt = new Date(Date.now() - 10 * 60_000);
    const [attempt] = await db
      .insert(attempts)
      .values({ assessment_id: a.id, student_id: ada!.id, test_session_id: sitting.id, status: "in_progress", started_at: startedAt })
      .returning();
    const lastSave = new Date(Date.now() - 60_000);
    await db.insert(responses).values([
      { attempt_id: attempt!.id, item_id: seeded[0]!.id, response: { kind: "mc", choice_ids: ["a"] } as never, updated_at: new Date(Date.now() - 5 * 60_000) },
      { attempt_id: attempt!.id, item_id: seeded[1]!.id, response: { kind: "mc", choice_ids: ["b"] } as never, updated_at: lastSave },
    ]);

    const body = (await (await attendance(sitting.id)).json()) as {
      rows: { ps_id: string; answered: number; total_items: number; last_activity_at: string | null }[];
      updated_at: string | null;
      total_items: number;
    };
    expect(body.total_items).toBe(3);
    const byId = new Map(body.rows.map((r) => [r.ps_id, r]));
    expect(byId.get(STUDENT.ps_id)).toMatchObject({ answered: 2, total_items: 3 });
    expect(new Date(byId.get(STUDENT.ps_id)!.last_activity_at!).getTime()).toBe(lastSave.getTime());
    expect(byId.get(OTHER_STUDENT.ps_id)).toMatchObject({ answered: 0, total_items: 3, last_activity_at: null });
    expect(new Date(body.updated_at!).getTime()).toBe(lastSave.getTime());
  });

  test("an explicit list is exactly that list; an attempt outside today's scope is kept and flagged", async () => {
    principal = staffPrincipal(TEACHER);
    const a = await seedAssessment();
    const sitting = await createSitting({ assessment_id: a.id, student_ps_ids: [OTHER_STUDENT.ps_id] });
    // Someone not on the list ended up with an attempt here (scope edited
    // later, or a pre-slice-78 join). Shown, flagged, not counted as expected.
    await joinAs(TEACHER, STUDENT.ps_id, a.id, sitting.id, "in_progress");
    const body = (await (await attendance(sitting.id)).json()) as {
      rows: { ps_id: string; status: string; in_scope: boolean }[];
      counts: { expected: number; joined: number; submitted: number };
    };
    const byId = new Map(body.rows.map((r) => [r.ps_id, r]));
    expect(byId.get(OTHER_STUDENT.ps_id)).toMatchObject({ status: "not_joined", in_scope: true });
    expect(byId.get(STUDENT.ps_id)).toMatchObject({ status: "in_progress", in_scope: false });
    expect(body.counts).toEqual({ expected: 1, joined: 1, submitted: 0 });
  });

  // Finding 8.2 (2026-08-28): Ben rejoined through a second sitting and the
  // first sitting's monitor was the only place he showed up. The rejoin now
  // moves the attempt, so the sitting the teacher is watching lists him.
  test("finding 8.2: a rejoin through a new sitting moves the student to its attendance, progress intact", async () => {
    principal = staffPrincipal(TEACHER);
    const a = await seedAssessment();
    const db = getDb();
    const seeded = await db
      .insert(items)
      .values([1, 2].map((n) => ({ assessment_id: a.id, position: n, type: "mc", stem: `Q${n}` })))
      .returning();
    const first = await createSitting({ assessment_id: a.id, section_ps_id: "5001" });
    const second = await createSitting({ assessment_id: a.id, section_ps_id: "5001" });
    await joinAs(TEACHER, STUDENT.ps_id, a.id, first.id, "in_progress");
    const [attempt] = await db.select().from(attempts);
    await db.insert(responses).values({
      attempt_id: attempt!.id,
      item_id: seeded[0]!.id,
      response: { kind: "mc", choice_ids: ["a"] } as never,
    });

    // Ada rejoins through the second sitting — the real route, not a row edit.
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
    expect(((await joined.json()) as { attempt: { id: string } }).attempt.id).toBe(attempt!.id);

    principal = staffPrincipal(TEACHER);
    type Body = {
      rows: { ps_id: string; status: string; answered: number; attempt_id: string | null }[];
      counts: { expected: number; joined: number; submitted: number };
    };
    const onSecond = (await (await attendance(second.id)).json()) as Body;
    const adaOnSecond = onSecond.rows.find((r) => r.ps_id === STUDENT.ps_id)!;
    expect(adaOnSecond).toMatchObject({ status: "in_progress", answered: 1, attempt_id: attempt!.id });
    expect(onSecond.counts).toEqual({ expected: 2, joined: 1, submitted: 0 });

    const onFirst = (await (await attendance(first.id)).json()) as Body;
    expect(onFirst.rows.find((r) => r.ps_id === STUDENT.ps_id)).toMatchObject({ status: "not_joined", attempt_id: null });
    expect(onFirst.counts).toEqual({ expected: 2, joined: 0, submitted: 0 });
  });
});

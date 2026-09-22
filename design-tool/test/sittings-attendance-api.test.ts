// Slice 82: the roster picker behind sitting creation, and attendance — who a
// sitting expects versus who has joined or submitted.
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { closeDb, getDb } from "../db/client";
import {
  assessments,
  attempt_events,
  attempts,
  items,
  responses,
  students,
  test_sessions,
} from "../db/schema";
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
      counts: { expected: number; joined: number; submitted: number; submitted_earlier: number };
    };
    expect(body.test_session.code).toHaveLength(6);
    expect(body.rows.map((r) => r.ps_id).sort()).toEqual([STUDENT.ps_id, OTHER_STUDENT.ps_id]);
    expect(body.rows.every((r) => r.status === "not_joined" && r.in_scope)).toBe(true);
    expect(body.rows[0]!.section_label).toContain("Algebra");
    expect(body.counts).toEqual({ expected: 2, joined: 0, submitted: 0, submitted_earlier: 0 });
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
      counts: { expected: number; joined: number; submitted: number; submitted_earlier: number };
    };
    const byId = new Map(body.rows.map((r) => [r.ps_id, r]));
    expect(byId.get(STUDENT.ps_id)!.status).toBe("in_progress");
    expect(byId.get(STUDENT.ps_id)!.started_at).not.toBeNull();
    // Peek P3: the monitor's Peek button posts against this id.
    expect(byId.get(STUDENT.ps_id)!.attempt_id).not.toBeNull();
    expect(byId.get(STUDENT.ps_id)!.submitted_at).toBeNull();
    expect(byId.get(OTHER_STUDENT.ps_id)!.status).toBe("submitted");
    expect(byId.get(OTHER_STUDENT.ps_id)!.submitted_at).not.toBeNull();
    expect(body.counts).toEqual({ expected: 2, joined: 2, submitted: 1, submitted_earlier: 0 });
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

    // CS-1: a resume (a newer lockdown_begin) is activity too — the student
    // is back inside the test even before their first answer lands.
    const resumedAt = new Date(Date.now() - 10_000);
    await db.insert(attempt_events).values({ attempt_id: attempt!.id, kind: "lockdown_begin", at: resumedAt });
    const after = (await (await attendance(sitting.id)).json()) as {
      rows: { ps_id: string; last_activity_at: string | null }[];
      updated_at: string | null;
    };
    const adaAfter = after.rows.find((r) => r.ps_id === STUDENT.ps_id)!;
    expect(new Date(adaAfter.last_activity_at!).getTime()).toBe(resumedAt.getTime());
    expect(new Date(after.updated_at!).getTime()).toBe(resumedAt.getTime());
  });

  // T-2 (the 2026-09-14 hand-run): the monitor row carries the same deadline
  // answer the hand-in route uses, so its Hand in button enables on exactly
  // what the route accepts rather than on the closed session alone.
  test("T-2: an in-progress row reports deadline_passed once the limit plus grace is up", async () => {
    principal = staffPrincipal(TEACHER);
    const db = getDb();
    const a = await seedAssessment();
    const sitting = await createSitting({ assessment_id: a.id, section_ps_id: "5001" });

    type Body = { rows: { ps_id: string; status: string; deadline_passed: boolean }[] };
    const read = async () =>
      new Map(
        ((await (await attendance(sitting.id)).json()) as Body).rows.map((r) => [r.ps_id, r]),
      );

    const [ada] = await db
      .insert(students)
      .values({ owner_sub: TEACHER, roster_ps_id: STUDENT.ps_id, name: "Ada" })
      .returning();
    await db.insert(attempts).values({
      assessment_id: a.id,
      student_id: ada!.id,
      test_session_id: sitting.id,
      status: "in_progress",
      started_at: new Date(Date.now() - 30 * 60_000),
    });

    // No limit on the assessment: nothing to be past, however long ago she
    // started. The not-joined row is false too.
    let byId = await read();
    expect(byId.get(STUDENT.ps_id)).toMatchObject({
      status: "in_progress",
      deadline_passed: false,
    });
    expect(byId.get(OTHER_STUDENT.ps_id)).toMatchObject({
      status: "not_joined",
      deadline_passed: false,
    });

    // An hour allowed, thirty minutes in: still running.
    await db
      .update(assessments)
      .set({ time_limit_seconds: 60 * 60 })
      .where(eq(assessments.id, a.id));
    byId = await read();
    expect(byId.get(STUDENT.ps_id)!.deadline_passed).toBe(false);

    // Ten minutes allowed, thirty minutes in: past the deadline and its grace.
    await db
      .update(assessments)
      .set({ time_limit_seconds: 10 * 60 })
      .where(eq(assessments.id, a.id));
    byId = await read();
    expect(byId.get(STUDENT.ps_id)!.deadline_passed).toBe(true);

    // Handing in settles it — a submitted row never reports the deadline.
    await db
      .update(attempts)
      .set({ status: "submitted", submitted_at: new Date() })
      .where(eq(attempts.assessment_id, a.id));
    byId = await read();
    expect(byId.get(STUDENT.ps_id)).toMatchObject({
      status: "submitted",
      deadline_passed: false,
    });
  });

  // The teacher's extension, on the monitor row. `deadline_at` is the instant
  // the student is actually counting down to — the override when one was
  // granted, the computed deadline otherwise.
  test("deadline_at is the effective deadline, and a teacher's override wins", async () => {
    principal = staffPrincipal(TEACHER);
    const db = getDb();
    const a = await seedAssessment();
    const sitting = await createSitting({ assessment_id: a.id, section_ps_id: "5001" });

    type Body = {
      rows: { ps_id: string; status: string; deadline_passed: boolean; deadline_at: string | null }[];
    };
    const read = async () =>
      new Map(
        ((await (await attendance(sitting.id)).json()) as Body).rows.map((r) => [r.ps_id, r]),
      );

    const [ada] = await db
      .insert(students)
      .values({ owner_sub: TEACHER, roster_ps_id: STUDENT.ps_id, name: "Ada" })
      .returning();
    const startedAt = new Date(Date.now() - 30 * 60_000);
    await db.insert(attempts).values({
      assessment_id: a.id,
      student_id: ada!.id,
      test_session_id: sitting.id,
      status: "in_progress",
      started_at: startedAt,
    });

    // No limit, no extension: nothing to show, on the joined row or the other.
    let byId = await read();
    expect(byId.get(STUDENT.ps_id)!.deadline_at).toBeNull();
    expect(byId.get(OTHER_STUDENT.ps_id)!.deadline_at).toBeNull();

    // Ten minutes allowed, thirty minutes in: past, and the instant says when.
    await db
      .update(assessments)
      .set({ time_limit_seconds: 10 * 60 })
      .where(eq(assessments.id, a.id));
    byId = await read();
    expect(byId.get(STUDENT.ps_id)!.deadline_at).toBe(
      new Date(startedAt.getTime() + 10 * 60_000).toISOString(),
    );
    expect(byId.get(STUDENT.ps_id)!.deadline_passed).toBe(true);

    // The teacher gives them another twenty minutes.
    const override = new Date(Date.now() + 20 * 60_000);
    await db
      .update(attempts)
      .set({ deadline_override_at: override })
      .where(eq(attempts.assessment_id, a.id));
    byId = await read();
    expect(byId.get(STUDENT.ps_id)!.deadline_at).toBe(override.toISOString());
    expect(byId.get(STUDENT.ps_id)!.deadline_passed).toBe(false);
  });

  // Finding H-1 (2026-09-17): a student whose only attempt was handed in
  // through an EARLIER sitting cannot join today's — the join route gives
  // them back the submitted attempt. Today's row said "Not joined" with no
  // hint; it now says so.
  test("H-1: a submitted attempt from an earlier sitting reads as submitted_earlier today", async () => {
    principal = staffPrincipal(TEACHER);
    const db = getDb();
    const a = await seedAssessment();
    const seeded = await db
      .insert(items)
      .values([1, 2].map((n) => ({ assessment_id: a.id, position: n, type: "mc", stem: `Q${n}` })))
      .returning();

    const yesterday = await createSitting({ assessment_id: a.id, section_ps_id: "5001" });
    // Ada handed in yesterday; Ben's attempt is still in progress there.
    await joinAs(TEACHER, STUDENT.ps_id, a.id, yesterday.id, "submitted");
    await joinAs(TEACHER, OTHER_STUDENT.ps_id, a.id, yesterday.id, "in_progress");
    const [adaAttempt] = await db
      .select()
      .from(attempts)
      .where(eq(attempts.status, "submitted"));
    await db.insert(responses).values({
      attempt_id: adaAttempt!.id,
      item_id: seeded[0]!.id,
      response: { kind: "mc", choice_ids: ["a"] } as never,
    });
    await db
      .update(test_sessions)
      .set({ status: "closed" })
      .where(eq(test_sessions.id, yesterday.id));

    const today = await createSitting({ assessment_id: a.id, section_ps_id: "5001" });
    type Body = {
      rows: {
        ps_id: string;
        status: string;
        attempt_id: string | null;
        submitted_at: string | null;
        started_at: string | null;
        answered: number;
        last_activity_at: string | null;
        deadline_passed: boolean;
        alert: unknown;
        passed_back_waiting: boolean;
      }[];
      counts: { expected: number; joined: number; submitted: number; submitted_earlier: number };
    };
    const body = (await (await attendance(today.id)).json()) as Body;
    const byId = new Map(body.rows.map((r) => [r.ps_id, r]));

    expect(byId.get(STUDENT.ps_id)).toMatchObject({
      status: "submitted_earlier",
      attempt_id: adaAttempt!.id,
      answered: 1,
      deadline_passed: false,
      last_activity_at: null,
      alert: null,
    });
    expect(byId.get(STUDENT.ps_id)!.submitted_at).not.toBeNull();
    expect(byId.get(STUDENT.ps_id)!.started_at).not.toBeNull();

    // Ben's attempt is in progress elsewhere: joining today WOULD rebind it,
    // so he stays a plain not-joined row with nothing of the other sitting on it.
    expect(byId.get(OTHER_STUDENT.ps_id)).toMatchObject({
      status: "not_joined",
      attempt_id: null,
      answered: 0,
      submitted_at: null,
      passed_back_waiting: false,
    });
    expect(byId.get(STUDENT.ps_id)!.passed_back_waiting).toBe(false);

    // PB-4 (2026-09-22): once that in-progress attempt was passed back, the
    // row stays not_joined but says it is waiting for the student.
    await db
      .update(attempts)
      .set({ pass_back_count: 1 })
      .where(eq(attempts.status, "in_progress"));
    const afterPassBack = (await (await attendance(today.id)).json()) as Body;
    expect(
      afterPassBack.rows.find((r) => r.ps_id === OTHER_STUDENT.ps_id),
    ).toMatchObject({ status: "not_joined", attempt_id: null, passed_back_waiting: true });

    // James, 2026-09-17: counted apart — "0 of 2 joined · 0 handed in · 1
    // already handed in"; Ben's in-progress attempt elsewhere is not joined.
    expect(body.counts).toEqual({ expected: 2, joined: 0, submitted: 0, submitted_earlier: 1 });

    // Yesterday's own monitor is unchanged — a student with an attempt on THAT
    // sitting is reported from it, not from the H-1 lookup.
    const before = (await (await attendance(yesterday.id)).json()) as Body;
    const yById = new Map(before.rows.map((r) => [r.ps_id, r]));
    expect(yById.get(STUDENT.ps_id)).toMatchObject({
      status: "submitted",
      attempt_id: adaAttempt!.id,
      answered: 1,
    });
    expect(yById.get(STUDENT.ps_id)!.last_activity_at).not.toBeNull();
    expect(yById.get(OTHER_STUDENT.ps_id)!.status).toBe("in_progress");
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
      counts: { expected: number; joined: number; submitted: number; submitted_earlier: number };
    };
    const byId = new Map(body.rows.map((r) => [r.ps_id, r]));
    expect(byId.get(OTHER_STUDENT.ps_id)).toMatchObject({ status: "not_joined", in_scope: true });
    expect(byId.get(STUDENT.ps_id)).toMatchObject({ status: "in_progress", in_scope: false });
    expect(body.counts).toEqual({ expected: 1, joined: 1, submitted: 0, submitted_earlier: 0 });
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
      counts: { expected: number; joined: number; submitted: number; submitted_earlier: number };
    };
    const onSecond = (await (await attendance(second.id)).json()) as Body;
    const adaOnSecond = onSecond.rows.find((r) => r.ps_id === STUDENT.ps_id)!;
    expect(adaOnSecond).toMatchObject({ status: "in_progress", answered: 1, attempt_id: attempt!.id });
    expect(onSecond.counts).toEqual({ expected: 2, joined: 1, submitted: 0, submitted_earlier: 0 });

    const onFirst = (await (await attendance(first.id)).json()) as Body;
    expect(onFirst.rows.find((r) => r.ps_id === STUDENT.ps_id)).toMatchObject({ status: "not_joined", attempt_id: null });
    expect(onFirst.counts).toEqual({ expected: 2, joined: 0, submitted: 0, submitted_earlier: 0 });
  });
});

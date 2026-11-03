// Competency assessments, slice 4 (docs/competency-assessment-design.md, 4.1):
// the proctor path. This is a security surface — it is the first place a
// staff member reaches students who are not in their sections — so it is
// pinned from both sides: what a proctor CAN do (start a sitting for their
// own students, monitor and close it, act on those students' attempts) and
// everything they cannot (anyone else's student, any other sitting, the
// assessment itself, scoring, a withdrawn case, a teacher's own assessment).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { closeDb, getDb } from "../db/client";
import { assessments, attempts, competency_assignments, item_sets, students, test_sessions } from "../db/schema";
import { SESSION_COOKIE_NAME } from "../lib/auth/session";
import * as headersMod from "next/headers";
import * as sessionMod from "../lib/auth/session";
import { authorizeAssessment, authorizeAttempt, authorizeSitting } from "../lib/api/access";
import { loadProctorCases, proctorCaseCount } from "../lib/competency/proctoring";
import { OTHER_STUDENT, STUDENT, TEACHER_EMAIL, clearRoster, seedRoster, studentPrincipal } from "./helpers/roster";

const expectTestDb = () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("secure_test_design_tool_test")) {
    throw new Error(`competency proctor tests require the test DB; got: ${url}`);
  }
};

const OWNER = { sub: "assessment-office-sub", role: "staff", email: "assessment-office@psd401.net" };
const PROCTOR = { sub: "proctor-sub", role: "staff", email: "cba-proctor@psd401.net" };
const OTHER_PROCTOR = { sub: "other-proctor-sub", role: "staff", email: "cba-proctor-two@psd401.net" };
// Teaches STUDENT in the roster fixture, but has no part in the CBA.
const SECTION_TEACHER = { sub: "section-teacher-sub", role: "staff", email: TEACHER_EMAIL };

type Principal = { sub: string; role: string; email?: string } | null;
let principal: Principal = PROCTOR;

mock.module("next/headers", () => ({
  ...headersMod,
  headers: async () => new Headers(),
  cookies: async () => ({
    get: (name: string) => (principal && name === SESSION_COOKIE_NAME ? { value: "x" } : undefined),
  }),
}));

mock.module("../lib/auth/session", () => ({
  ...sessionMod,
  readSessionFromCookies: async () => principal,
}));

beforeAll(async () => {
  expectTestDb();
  await clearRoster();
  await seedRoster();
});

beforeEach(() => {
  principal = PROCTOR;
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

/** A published district assessment: STUDENT → PROCTOR, OTHER_STUDENT → OTHER_PROCTOR. */
async function seed(scope: "district" | "teacher" = "district") {
  const db = getDb();
  const [a] = await db
    .insert(assessments)
    .values({
      owner_sub: OWNER.sub,
      owner_email: OWNER.email,
      name: "CBA task",
      assigned_scope: scope,
      status: "published",
    })
    .returning();
  const [set] = await db.insert(item_sets).values({ assessment_id: a!.id }).returning();
  const assign = (ps: string, proctor: string) =>
    db
      .insert(competency_assignments)
      .values({
        assessment_id: a!.id,
        student_ps_id: ps,
        item_set_id: set!.id,
        proctor_email: proctor,
        assigned_by_sub: OWNER.sub,
        assigned_by_email: OWNER.email,
      })
      .returning();
  const [mine] = await assign(STUDENT.ps_id, PROCTOR.email);
  const [theirs] = await assign(OTHER_STUDENT.ps_id, OTHER_PROCTOR.email);
  return { a: a!, mine: mine!, theirs: theirs! };
}

async function startSitting(body: Record<string, unknown>) {
  const { POST } = await import("../app/api/test-sessions/route");
  return POST(new Request("http://local/api/test-sessions", { method: "POST", body: JSON.stringify(body) }));
}

/** An overlay row + in-progress attempt for a roster student, as a join leaves them. */
async function attemptFor(assessmentId: string, ps: string, sittingId: string | null = null) {
  const db = getDb();
  const [s] = await db
    .insert(students)
    .values({ owner_sub: OWNER.sub, roster_ps_id: ps, name: ps })
    .returning();
  const [att] = await db
    .insert(attempts)
    .values({ assessment_id: assessmentId, student_id: s!.id, status: "in_progress", test_session_id: sittingId })
    .returning();
  return att!;
}

describe("POST /api/test-sessions: the proctor's scope", () => {
  test("a proctor starts a sitting for their own student; it is theirs", async () => {
    const { a } = await seed();
    const res = await startSitting({ assessment_id: a.id, student_ps_ids: [STUDENT.ps_id] });
    expect(res.status).toBe(201);
    const { test_session } = (await res.json()) as { test_session: { owner_sub: string; student_ps_ids: string[] } };
    expect(test_session.owner_sub).toBe(PROCTOR.sub);
    expect(test_session.student_ps_ids).toEqual([STUDENT.ps_id]);
  });

  test("another proctor's student, alone or alongside, is refused", async () => {
    const { a } = await seed();
    for (const ids of [[OTHER_STUDENT.ps_id], [STUDENT.ps_id, OTHER_STUDENT.ps_id]]) {
      const res = await startSitting({ assessment_id: a.id, student_ps_ids: ids });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("students_not_taught");
    }
  });

  test("no list, a section, or practice is refused: a proctor's scope is their students", async () => {
    const { a } = await seed();
    expect((await startSitting({ assessment_id: a.id })).status).toBe(400);
    expect((await startSitting({ assessment_id: a.id, section_ps_id: "5001" })).status).toBe(400);
    expect((await startSitting({ assessment_id: a.id, kind: "practice" })).status).toBe(400);
    expect(await getDb().select().from(test_sessions)).toHaveLength(0);
  });

  test("a withdrawn case, a teacher's own assessment, or staff with no case: 404", async () => {
    const { a, mine } = await seed();
    await getDb()
      .update(competency_assignments)
      .set({ status: "withdrawn", withdrawn_at: new Date() })
      .where(eq(competency_assignments.id, mine.id));
    expect((await startSitting({ assessment_id: a.id, student_ps_ids: [STUDENT.ps_id] })).status).toBe(404);

    const teacherOwn = await seed("teacher");
    expect((await startSitting({ assessment_id: teacherOwn.a.id, student_ps_ids: [STUDENT.ps_id] })).status).toBe(404);

    principal = SECTION_TEACHER;
    const fresh = await seed();
    expect((await startSitting({ assessment_id: fresh.a.id, student_ps_ids: [STUDENT.ps_id] })).status).toBe(404);
    expect(await getDb().select().from(test_sessions)).toHaveLength(0);
  });
});

describe("the proctor through the access doors", () => {
  async function proctorSitting(assessmentId: string) {
    const res = await startSitting({ assessment_id: assessmentId, student_ps_ids: [STUDENT.ps_id] });
    return ((await res.json()) as { test_session: { id: string } }).test_session.id;
  }

  test("the assessment itself stays shut: results, scoring and editing are 404", async () => {
    const { a } = await seed();
    for (const need of ["view", "run", "score", "edit"] as const) {
      const access = await authorizeAssessment(getDb(), PROCTOR, a.id, need, "read");
      expect(access.ok).toBe(false);
    }
  });

  test("their own sitting at run; never at own; never another proctor's sitting", async () => {
    const { a } = await seed();
    const mineId = await proctorSitting(a.id);
    const ok = await authorizeSitting(getDb(), PROCTOR, mineId, "run", "write");
    expect(ok.ok && ok.via).toBe("proctor");
    expect((await authorizeSitting(getDb(), PROCTOR, mineId, "own", "write")).ok).toBe(false);

    principal = OTHER_PROCTOR;
    const res = await startSitting({ assessment_id: a.id, student_ps_ids: [OTHER_STUDENT.ps_id] });
    const theirsId = ((await res.json()) as { test_session: { id: string } }).test_session.id;
    expect((await authorizeSitting(getDb(), PROCTOR, theirsId, "view", "read")).ok).toBe(false);
  });

  test("a replaced proctor loses their old sitting and the student's attempt", async () => {
    const { a, mine } = await seed();
    const sittingId = await proctorSitting(a.id);
    const att = await attemptFor(a.id, STUDENT.ps_id, sittingId);
    expect((await authorizeAttempt(getDb(), PROCTOR, att.id, "run", "write")).ok).toBe(true);
    await getDb()
      .update(competency_assignments)
      .set({ proctor_email: OTHER_PROCTOR.email })
      .where(eq(competency_assignments.id, mine.id));
    expect((await authorizeSitting(getDb(), PROCTOR, sittingId, "run", "read")).ok).toBe(false);
    expect((await authorizeAttempt(getDb(), PROCTOR, att.id, "run", "write")).ok).toBe(false);
  });

  test("their student's attempt at run, not at score; another proctor's student never", async () => {
    const { a } = await seed();
    const mineAtt = await attemptFor(a.id, STUDENT.ps_id);
    const theirsAtt = await attemptFor(a.id, OTHER_STUDENT.ps_id);
    const ok = await authorizeAttempt(getDb(), PROCTOR, mineAtt.id, "run", "write");
    expect(ok.ok && ok.via).toBe("proctor");
    expect((await authorizeAttempt(getDb(), PROCTOR, mineAtt.id, "score", "write")).ok).toBe(false);
    expect((await authorizeAttempt(getDb(), PROCTOR, theirsAtt.id, "view", "read")).ok).toBe(false);
  });

  test("the close route admits the proctor on their own sitting", async () => {
    const { a } = await seed();
    const sittingId = await proctorSitting(a.id);
    const { POST } = await import("../app/api/test-sessions/[sessionId]/close/route");
    const res = await POST(new Request("http://local/x", { method: "POST" }), {
      params: Promise.resolve({ sessionId: sittingId }),
    });
    expect(res.status).toBe(200);
  });
});

describe("the case moves to in progress on the first join", () => {
  test("POST /api/attempts as the student marks assigned → in_progress, once", async () => {
    const { a, mine, theirs } = await seed();
    const res = await startSitting({ assessment_id: a.id, student_ps_ids: [STUDENT.ps_id] });
    const sittingId = ((await res.json()) as { test_session: { id: string } }).test_session.id;
    principal = studentPrincipal();
    const { POST } = await import("../app/api/attempts/route");
    const join = await POST(
      new Request("http://local/api/attempts", { method: "POST", body: JSON.stringify({ test_session_id: sittingId }) }),
    );
    expect(join.status).toBe(201);
    const status = async (id: string) =>
      (await getDb().select().from(competency_assignments).where(eq(competency_assignments.id, id)))[0]?.status;
    expect(await status(mine.id)).toBe("in_progress");
    expect(await status(theirs.id)).toBe("assigned");
  });
});

describe("the proctor's home list", () => {
  test("lists their own students and open sittings only", async () => {
    const { a } = await seed();
    await startSitting({ assessment_id: a.id, student_ps_ids: [STUDENT.ps_id] });
    const groups = await loadProctorCases(getDb(), PROCTOR.email, PROCTOR.sub);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.students.map((s) => s.ps_id)).toEqual([STUDENT.ps_id]);
    expect(groups[0]!.open_sittings).toHaveLength(1);
    expect(await proctorCaseCount(getDb(), PROCTOR.email)).toBe(1);
    expect(await proctorCaseCount(getDb(), SECTION_TEACHER.email)).toBe(0);
  });
});

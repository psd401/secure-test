// Competency assessments, slice 8 (docs/competency-assessment-design.md,
// D-8): a counselor with a `school` grant at `run` assigns their school's
// students. The school scope is the security surface here, so every route is
// pinned both ways: the counselor's own school works, any other school's
// student is invisible, Release stays Assessment's, a `view` counselor
// assigns nothing, and the grant still opens no assessment.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { closeDb, getDb } from "../db/client";
import { access_grants, assessments, competency_assignments, item_sets, roster_students } from "../db/schema";
import { SESSION_COOKIE_NAME } from "../lib/auth/session";
import * as headersMod from "next/headers";
import * as sessionMod from "../lib/auth/session";
import { authorizeAssessment } from "../lib/api/access";
import { STUDENT, clearRoster, seedRoster } from "./helpers/roster";

const expectTestDb = () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("secure_test_design_tool_test")) {
    throw new Error(`counselor assign tests require the test DB; got: ${url}`);
  }
};

const STAFF = { sub: "assessment-office-sub", role: "staff", email: "assessment-office@psd401.net" };
const COUNSELOR = { sub: "counselor-sub", role: "staff", email: "cba-counselor@psd401.net" };
const PROCTOR = "cba-proctor@psd401.net";
/** The fixture's one student at another school than STUDENT's. */
const OTHER_SCHOOL_PS = "1005";

type Principal = { sub: string; role: string; email?: string } | null;
let principal: Principal = COUNSELOR;

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

let mySchool = "";
let otherName = "";

beforeAll(async () => {
  expectTestDb();
  await clearRoster();
  await seedRoster();
  const db = getDb();
  const [me] = await db.select().from(roster_students).where(eq(roster_students.ps_id, STUDENT.ps_id));
  const [other] = await db.select().from(roster_students).where(eq(roster_students.ps_id, OTHER_SCHOOL_PS));
  mySchool = me!.school_id!;
  otherName = other!.last_name || other!.first_name;
  expect(other!.school_id).not.toBe(mySchool);
});

beforeEach(() => {
  process.env.COMPETENCY_ADMIN_EMAILS = STAFF.email;
  principal = COUNSELOR;
});

afterEach(async () => {
  delete process.env.COMPETENCY_ADMIN_EMAILS;
  const db = getDb();
  await db.execute(sql`truncate table assessments restart identity cascade`);
  await db.execute(sql`truncate table access_grants restart identity cascade`);
});

afterAll(async () => {
  await clearRoster();
  await closeDb();
});

async function grant(level: "view" | "run", school = mySchool) {
  await getDb().insert(access_grants).values({
    grantee_email: COUNSELOR.email,
    scope_kind: "school",
    scope_id: school,
    level,
    granted_by_sub: STAFF.sub,
    granted_by_email: STAFF.email,
    note: "counselor",
  });
}

async function seed(opts: { scope?: "district" | "teacher"; archived?: boolean } = {}) {
  const db = getDb();
  const [a] = await db
    .insert(assessments)
    .values({
      owner_sub: STAFF.sub,
      owner_email: STAFF.email,
      name: "CBA task",
      assigned_scope: opts.scope ?? "district",
      archived_at: opts.archived ? new Date() : null,
    })
    .returning();
  const [set] = await db.insert(item_sets).values({ assessment_id: a!.id }).returning();
  return { a: a!, setId: set!.id };
}

async function assignByStaff(assessmentId: string, setId: string, ps: string) {
  const [row] = await getDb()
    .insert(competency_assignments)
    .values({
      assessment_id: assessmentId,
      student_ps_id: ps,
      item_set_id: setId,
      proctor_email: PROCTOR,
      assigned_by_sub: STAFF.sub,
      assigned_by_email: STAFF.email,
    })
    .returning();
  return row!;
}

const call = async (method: "GET" | "POST" | "PATCH", id: string, path: string, body?: unknown, assignmentId?: string) => {
  const req = new Request(`http://local/api/assessments/${id}/competency/${path}`, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (path.startsWith("students")) {
    const { GET } = await import("../app/api/assessments/[id]/competency/students/route");
    return GET(req, { params: Promise.resolve({ id }) });
  }
  if (path === "assignments") {
    const mod = await import("../app/api/assessments/[id]/competency/assignments/route");
    return method === "GET" ? mod.GET(req, { params: Promise.resolve({ id }) }) : mod.POST(req, { params: Promise.resolve({ id }) });
  }
  const { PATCH } = await import("../app/api/assessments/[id]/competency/assignments/[assignmentId]/route");
  return PATCH(req, { params: Promise.resolve({ id, assignmentId: assignmentId! }) });
};

const body = (setId: string, ps: string) => ({ student_ps_id: ps, item_set_id: setId, proctor_email: PROCTOR });

describe("a counselor at run assigns their school's students", () => {
  test("their school's student: assigned; another school's: refused as unknown", async () => {
    await grant("run");
    const { a, setId } = await seed();
    expect((await call("POST", a.id, "assignments", body(setId, STUDENT.ps_id))).status).toBe(201);
    const other = await call("POST", a.id, "assignments", body(setId, OTHER_SCHOOL_PS));
    expect(other.status).toBe(400);
    expect(((await other.json()) as { error: string }).error).toBe("unknown_student");
  });

  test("the list holds their school's cases only, with no unreleased result and no review link", async () => {
    await grant("run");
    const { a, setId } = await seed();
    await assignByStaff(a.id, setId, STUDENT.ps_id);
    await assignByStaff(a.id, setId, OTHER_SCHOOL_PS);
    const list = (await (await call("GET", a.id, "assignments")).json()) as {
      assignments: { student_ps_id: string; result: string | null; attempt_id: string | null }[];
    };
    expect(list.assignments.map((x) => x.student_ps_id)).toEqual([STUDENT.ps_id]);
    expect(list.assignments[0]!.result).toBeNull();
    expect(list.assignments[0]!.attempt_id).toBeNull();
  });

  test("the search finds no other school's student", async () => {
    await grant("run");
    const { a } = await seed();
    const res = (await (await call("GET", a.id, `students?q=${encodeURIComponent(otherName)}`)).json()) as {
      students: { ps_id: string }[];
    };
    expect(res.students.map((s) => s.ps_id)).not.toContain(OTHER_SCHOOL_PS);
    // The same search as Assessment staff does find them — the filter is the school.
    principal = STAFF;
    const staff = (await (await call("GET", a.id, `students?q=${encodeURIComponent(otherName)}`)).json()) as {
      students: { ps_id: string }[];
    };
    expect(staff.students.map((s) => s.ps_id)).toContain(OTHER_SCHOOL_PS);
  });

  test("withdraw their school's case; another school's case is 404; Release is never theirs", async () => {
    await grant("run");
    const { a, setId } = await seed();
    const mine = await assignByStaff(a.id, setId, STUDENT.ps_id);
    const theirs = await assignByStaff(a.id, setId, OTHER_SCHOOL_PS);
    expect((await call("PATCH", a.id, "x", { action: "release" }, mine.id)).status).toBe(404);
    expect((await call("PATCH", a.id, "x", { action: "withdraw" }, theirs.id)).status).toBe(404);
    expect((await call("PATCH", a.id, "x", { action: "withdraw" }, mine.id)).status).toBe(200);
    const rows = await getDb().select().from(competency_assignments).where(eq(competency_assignments.id, theirs.id));
    expect(rows[0]!.status).toBe("assigned");
  });
});

describe("what a counselor cannot reach", () => {
  test("a view-only counselor assigns nothing (404)", async () => {
    await grant("view");
    const { a, setId } = await seed();
    expect((await call("GET", a.id, "assignments")).status).toBe(404);
    expect((await call("POST", a.id, "assignments", body(setId, STUDENT.ps_id))).status).toBe(404);
  });

  test("a teacher's own assessment, or an archived district one: 404", async () => {
    await grant("run");
    const own = await seed({ scope: "teacher" });
    expect((await call("POST", own.a.id, "assignments", body(own.setId, STUDENT.ps_id))).status).toBe(404);
    const archived = await seed({ archived: true });
    expect((await call("GET", archived.a.id, "assignments")).status).toBe(404);
  });

  test("a revoked or expired grant: 404", async () => {
    const { a } = await seed();
    await grant("run");
    await getDb().update(access_grants).set({ ends_at: new Date(Date.now() - 1000) });
    expect((await call("GET", a.id, "assignments")).status).toBe(404);
  });

  test("the grant opens the assessment itself at no level", async () => {
    await grant("run");
    const { a } = await seed();
    for (const need of ["view", "run", "score", "edit"] as const) {
      expect((await authorizeAssessment(getDb(), COUNSELOR, a.id, need, "read")).ok).toBe(false);
    }
  });
});

describe("Assessment staff make a counselor who can assign", () => {
  test("can_assign makes a `run` school grant; without it, `view`", async () => {
    principal = STAFF;
    const { POST } = await import("../app/api/competency/counselors/route");
    const add = (b: unknown) => POST(new Request("http://local/x", { method: "POST", body: JSON.stringify(b) }));
    expect((await add({ grantee_email: COUNSELOR.email, school_id: mySchool, can_assign: true })).status).toBe(201);
    expect((await add({ grantee_email: "cba-counselor-two@psd401.net", school_id: mySchool })).status).toBe(201);
    const rows = await getDb().select().from(access_grants);
    expect(Object.fromEntries(rows.map((r) => [r.grantee_email, r.level]))).toEqual({
      [COUNSELOR.email]: "run",
      "cba-counselor-two@psd401.net": "view",
    });
  });
});

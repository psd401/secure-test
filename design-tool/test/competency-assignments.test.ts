// Competency assessments, slice 2 (docs/competency-assessment-design.md):
// the status machine, and the assignment routes on the test DB — who may
// reach them (the gate is the security surface), one live assignment per
// student, withdrawal as the only way to switch, and the option guard on
// the item-set DELETE.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { closeDb, getDb } from "../db/client";
import { assessments, competency_assignments, item_sets } from "../db/schema";
import { SESSION_COOKIE_NAME } from "../lib/auth/session";
import * as headersMod from "next/headers";
import * as sessionMod from "../lib/auth/session";
import { ASSIGNMENT_TRANSITIONS, canTransition } from "../lib/competency/assignments";
import { OTHER_STUDENT, STUDENT, clearRoster, seedRoster } from "./helpers/roster";

const ASSESSMENT_STAFF = "assessment-office@psd401.net";
const TEACHER_EMAIL = "cba-teacher@psd401.net";
const PROCTOR = "cba-proctor@psd401.net";

// --- the status machine -----------------------------------------------------

describe("assignment status transitions", () => {
  test("the stored milestones: assigned → in progress → released", () => {
    expect(canTransition("assigned", "in_progress")).toBe(true);
    expect(canTransition("in_progress", "released")).toBe(true);
    // A case joined before its assignment existed still releases.
    expect(canTransition("assigned", "released")).toBe(true);
    expect(canTransition("in_progress", "assigned")).toBe(false);
  });

  test("a rescored case is released again", () => {
    expect(canTransition("released", "released")).toBe(true);
  });

  test("handed in and scored are read, never written", () => {
    expect(ASSIGNMENT_TRANSITIONS.handed_in).toEqual([]);
    expect(ASSIGNMENT_TRANSITIONS.scored).toEqual([]);
    expect(canTransition("in_progress", "handed_in")).toBe(false);
    expect(canTransition("in_progress", "scored")).toBe(false);
  });

  test("every live status can be withdrawn; withdrawn is final", () => {
    for (const from of ["assigned", "in_progress", "released"] as const) {
      expect(canTransition(from, "withdrawn")).toBe(true);
    }
    expect(ASSIGNMENT_TRANSITIONS.withdrawn).toEqual([]);
  });
});

// --- the routes -------------------------------------------------------------

const expectTestDb = () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("secure_test_design_tool_test")) {
    throw new Error(`competency tests require the test DB; got: ${url}`);
  }
};

type Principal = { sub: string; role: string; email?: string; actor_sub?: string } | null;
let principal: Principal = null;

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

const STAFF = { sub: "staff-sub", role: "staff", email: ASSESSMENT_STAFF };

async function newAssessment(opts: { district?: boolean; ownerSub?: string; ownerEmail?: string } = {}) {
  const [a] = await getDb()
    .insert(assessments)
    .values({
      owner_sub: opts.ownerSub ?? STAFF.sub,
      owner_email: opts.ownerEmail ?? ASSESSMENT_STAFF,
      name: "CBA",
      assigned_scope: opts.district === false ? "teacher" : "district",
    })
    .returning();
  if (!a) throw new Error("insert returned no row");
  const sets = await getDb()
    .insert(item_sets)
    .values([
      { assessment_id: a.id, sources: [{ label: "Topic one", text: "x".repeat(30) }] },
      { assessment_id: a.id },
    ])
    .returning();
  // Two inserts in one statement share created_at; the id tiebreak orders them.
  const ordered = [...sets].sort((x, y) => x.id.localeCompare(y.id));
  return { a, sets: ordered };
}

const call = async (
  method: "GET" | "POST" | "PATCH",
  id: string,
  path: string,
  body?: unknown,
  extra: Record<string, string> = {},
) => {
  const url = `http://local/api/assessments/${id}/competency/${path}`;
  const req = new Request(url, { method, body: body === undefined ? undefined : JSON.stringify(body) });
  if (path.startsWith("students")) {
    const { GET } = await import("../app/api/assessments/[id]/competency/students/route");
    return GET(req, { params: Promise.resolve({ id }) });
  }
  if (path === "assignments") {
    const mod = await import("../app/api/assessments/[id]/competency/assignments/route");
    return method === "GET"
      ? mod.GET(req, { params: Promise.resolve({ id }) })
      : mod.POST(req, { params: Promise.resolve({ id }) });
  }
  const { PATCH } = await import("../app/api/assessments/[id]/competency/assignments/[assignmentId]/route");
  return PATCH(req, { params: Promise.resolve({ id, assignmentId: extra.assignmentId! }) });
};

describe("competency assignment routes", () => {
  beforeAll(async () => {
    expectTestDb();
    await clearRoster();
    await seedRoster();
  });
  beforeEach(() => {
    process.env.COMPETENCY_ADMIN_EMAILS = ASSESSMENT_STAFF;
    principal = STAFF;
  });
  afterEach(async () => {
    principal = null;
    delete process.env.COMPETENCY_ADMIN_EMAILS;
    await getDb().execute(sql`truncate table assessments restart identity cascade`);
  });
  afterAll(async () => {
    await clearRoster();
    await closeDb();
  });

  const assignBody = (setId: string, ps: string = STUDENT.ps_id) => ({
    student_ps_id: ps,
    item_set_id: setId,
    proctor_email: PROCTOR.toUpperCase(),
  });

  test("Assessment staff assign a student an option and a proctor, and see it listed", async () => {
    const { a, sets } = await newAssessment();
    const res = await call("POST", a.id, "assignments", assignBody(sets[0]!.id));
    expect(res.status).toBe(201);
    const list = (await (await call("GET", a.id, "assignments")).json()) as {
      options: { item_set_id: string; label: string }[];
      assignments: { proctor_email: string; status: string; option_label: string; student_name: string }[];
    };
    expect(list.options.map((o) => o.label)).toEqual(
      sets.map((s, i) => (s.sources.length ? `Option ${i + 1}: Topic one` : `Option ${i + 1}`)),
    );
    expect(list.assignments).toHaveLength(1);
    expect(list.assignments[0]!.proctor_email).toBe(PROCTOR);
    expect(list.assignments[0]!.status).toBe("assigned");
    expect(list.assignments[0]!.student_name).not.toBe("");
  });

  test("the gate: not listed, act-as, a teacher's own assessment, someone else's — all 404", async () => {
    const { a, sets } = await newAssessment();
    // A co-author who is not on the list (owner, but unlisted).
    delete process.env.COMPETENCY_ADMIN_EMAILS;
    expect((await call("GET", a.id, "assignments")).status).toBe(404);
    expect((await call("POST", a.id, "assignments", assignBody(sets[0]!.id))).status).toBe(404);
    expect((await call("GET", a.id, "students?q=ad")).status).toBe(404);
    process.env.COMPETENCY_ADMIN_EMAILS = ASSESSMENT_STAFF;

    // Act-as: never Assessment staff.
    principal = { ...STAFF, actor_sub: "admin-sub" };
    expect((await call("GET", a.id, "assignments")).status).toBe(404);
    principal = STAFF;

    // Listed, but the assessment is a teacher's own (not district).
    const own = await newAssessment({ district: false });
    expect((await call("POST", own.a.id, "assignments", assignBody(own.sets[0]!.id))).status).toBe(404);

    // Listed, but someone else's district assessment with no grant.
    const other = await newAssessment({ ownerSub: "teacher-sub", ownerEmail: TEACHER_EMAIL });
    expect((await call("GET", other.a.id, "assignments")).status).toBe(404);

    const rows = await getDb().select().from(competency_assignments);
    expect(rows).toHaveLength(0);
  });

  test("one live assignment per student; withdraw, then a new option is allowed", async () => {
    const { a, sets } = await newAssessment();
    const first = (await (await call("POST", a.id, "assignments", assignBody(sets[0]!.id))).json()) as {
      assignment: { id: string };
    };
    const dup = await call("POST", a.id, "assignments", assignBody(sets[1]!.id));
    expect(dup.status).toBe(409);
    expect(((await dup.json()) as { error: string }).error).toBe("already_assigned");

    const w = await call("PATCH", a.id, "x", { action: "withdraw" }, { assignmentId: first.assignment.id });
    expect(w.status).toBe(200);
    expect((await call("POST", a.id, "assignments", assignBody(sets[1]!.id))).status).toBe(201);

    // A withdrawn case is the record: it cannot be changed again.
    const again = await call("PATCH", a.id, "x", { action: "withdraw" }, { assignmentId: first.assignment.id });
    expect(again.status).toBe(409);
    const rows = await getDb().select().from(competency_assignments).where(eq(competency_assignments.assessment_id, a.id));
    expect(rows.map((r) => r.status).sort()).toEqual(["assigned", "withdrawn"]);
    expect(rows.find((r) => r.status === "withdrawn")?.withdrawn_at).not.toBeNull();
  });

  test("change proctor; a non-staff proctor is refused", async () => {
    const { a, sets } = await newAssessment();
    const created = (await (await call("POST", a.id, "assignments", assignBody(sets[0]!.id))).json()) as {
      assignment: { id: string };
    };
    const id = created.assignment.id;
    const bad = await call("PATCH", a.id, "x", { action: "change_proctor", proctor_email: STUDENT.email }, { assignmentId: id });
    expect(bad.status).toBe(400);
    const ok = await call("PATCH", a.id, "x", { action: "change_proctor", proctor_email: TEACHER_EMAIL }, { assignmentId: id });
    expect(ok.status).toBe(200);
    const [row] = await getDb().select().from(competency_assignments).where(eq(competency_assignments.id, id));
    expect(row?.proctor_email).toBe(TEACHER_EMAIL);
    // Status is not this route's to set.
    expect(
      (await call("PATCH", a.id, "x", { action: "set_status", status: "released" }, { assignmentId: id })).status,
    ).toBe(400);
  });

  test("bad assignments are refused: student proctor, unknown student, another assessment's option", async () => {
    const { a, sets } = await newAssessment();
    const other = await newAssessment();
    const post = (body: unknown) => call("POST", a.id, "assignments", body);
    expect((await post({ ...assignBody(sets[0]!.id), proctor_email: STUDENT.email })).status).toBe(400);
    expect((await post(assignBody(sets[0]!.id, "no-such-student"))).status).toBe(400);
    expect((await post(assignBody(other.sets[0]!.id))).status).toBe(400);
    expect((await post({ ...assignBody(sets[0]!.id), extra: true })).status).toBe(400);
    expect(await getDb().select().from(competency_assignments)).toHaveLength(0);
  });

  test("student search: active roster by name, nothing under two characters", async () => {
    const { a } = await newAssessment();
    const [first] = STUDENT.name.split(" ");
    const hit = (await (await call("GET", a.id, `students?q=${first}`)).json()) as { students: { ps_id: string }[] };
    expect(hit.students.map((s) => s.ps_id)).toContain(STUDENT.ps_id);
    expect(hit.students.map((s) => s.ps_id)).not.toContain(OTHER_STUDENT.ps_id);
    const short = (await (await call("GET", a.id, "students?q=a")).json()) as { students: unknown[] };
    expect(short.students).toEqual([]);
    // LIKE syntax matches literally, not as a wildcard.
    const wild = (await (await call("GET", a.id, "students?q=%25%25")).json()) as { students: unknown[] };
    expect(wild.students).toEqual([]);
  });

  test("an assigned option cannot be deleted; the whole assessment still can", async () => {
    const { a, sets } = await newAssessment();
    expect((await call("POST", a.id, "assignments", assignBody(sets[0]!.id))).status).toBe(201);
    const { DELETE } = await import("../app/api/assessments/[id]/item-sets/[setId]/route");
    const del = (setId: string) =>
      DELETE(new Request("http://local/x", { method: "DELETE" }), { params: Promise.resolve({ id: a.id, setId }) });
    const refused = await del(sets[0]!.id);
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toBe("option_assigned");
    expect((await del(sets[1]!.id)).status).toBe(204);

    await getDb().delete(assessments).where(eq(assessments.id, a.id));
    expect(await getDb().select().from(competency_assignments)).toHaveLength(0);
  });
});

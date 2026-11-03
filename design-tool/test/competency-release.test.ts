// Competency assessments, slice 6 (docs/competency-assessment-design.md,
// D-10, D-13, James 6.1–6.3): the case's status read from the attempt and
// the final score, Assessment's Release, and the counselor's list through a
// school grant that opens nothing else.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import type { Rubric } from "@secure-test/schema";
import { closeDb, getDb } from "../db/client";
import {
  assessments,
  attempts,
  competency_assignments,
  item_sets,
  items,
  responses,
  roster_students,
  scores,
  students,
} from "../db/schema";
import { SESSION_COOKIE_NAME } from "../lib/auth/session";
import * as headersMod from "next/headers";
import * as sessionMod from "../lib/auth/session";
import { authorizeAssessment } from "../lib/api/access";
import { caseStatusOf } from "../lib/competency/caseState";
import { counselorSchoolIds, releasedResultsForSchools } from "../lib/competency/counselors";
import { STUDENT, clearRoster, seedRoster } from "./helpers/roster";

// --- the status, read --------------------------------------------------------

describe("caseStatusOf", () => {
  const at = (m: number) => new Date(2026, 10, 2, 9, m);
  const base = { stored: "in_progress" as const, released_at: null, attempt_status: null, result: null, scored_at: null };

  test("before a join it is what was stored; withdrawn always wins", () => {
    expect(caseStatusOf({ ...base, stored: "assigned" })).toBe("assigned");
    expect(caseStatusOf({ ...base, stored: "withdrawn", attempt_status: "submitted" })).toBe("withdrawn");
  });

  test("in progress while the attempt is — including a passed-back one after release", () => {
    expect(caseStatusOf({ ...base, attempt_status: "in_progress" })).toBe("in_progress");
    expect(
      caseStatusOf({ ...base, stored: "released", released_at: at(5), attempt_status: "in_progress", result: "needs_revision", scored_at: at(1) }),
    ).toBe("in_progress");
  });

  test("handed in until a result exists; scored once it does; released until a newer score", () => {
    expect(caseStatusOf({ ...base, attempt_status: "submitted" })).toBe("handed_in");
    expect(caseStatusOf({ ...base, attempt_status: "submitted", result: "pass", scored_at: at(1) })).toBe("scored");
    const released = { ...base, stored: "released" as const, released_at: at(5), attempt_status: "submitted" as const, result: "pass" as const };
    expect(caseStatusOf({ ...released, scored_at: at(1) })).toBe("released");
    expect(caseStatusOf({ ...released, scored_at: at(9) })).toBe("scored");
  });
});

// --- routes ------------------------------------------------------------------

const expectTestDb = () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("secure_test_design_tool_test")) {
    throw new Error(`competency release tests require the test DB; got: ${url}`);
  }
};

const STAFF = { sub: "assessment-office-sub", role: "staff", email: "assessment-office@psd401.net" };
const COUNSELOR = { sub: "counselor-sub", role: "staff", email: "cba-counselor@psd401.net" };

type Principal = { sub: string; role: string; email?: string } | null;
let principal: Principal = STAFF;

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
  process.env.COMPETENCY_ADMIN_EMAILS = STAFF.email;
  principal = STAFF;
});

afterEach(async () => {
  delete process.env.COMPETENCY_ADMIN_EMAILS;
  const db = getDb();
  await db.execute(sql`truncate table assessments restart identity cascade`);
  await db.execute(sql`truncate table students restart identity cascade`);
  await db.execute(sql`truncate table access_grants restart identity cascade`);
});

afterAll(async () => {
  await clearRoster();
  await closeDb();
});

const level = (n: number) => ({ id: `l${n}`, label: String(n), points: n });
const RUBRIC = {
  style: "analytic",
  criteria: ["claim", "evidence"].map((id) => ({ id, name: id, levels: [level(4), level(3), level(2), level(1)] })),
} as Rubric;
const picks = (claim: number, evidence: number) => ({
  criterion_scores: [
    { criterion_id: "claim", level_id: `l${claim}`, points: claim, rationale: "" },
    { criterion_id: "evidence", level_id: `l${evidence}`, points: evidence, rationale: "" },
  ],
});

/** A handed-in CBA for STUDENT: one option (planning + final with the rubric). */
async function seedCase() {
  const db = getDb();
  const [a] = await db
    .insert(assessments)
    .values({
      owner_sub: STAFF.sub,
      owner_email: STAFF.email,
      name: "CBA task",
      assigned_scope: "district",
      competency_pass_min_points: 3,
      status: "published",
    })
    .returning();
  const [set] = await db.insert(item_sets).values({ assessment_id: a!.id }).returning();
  const [, final] = await db
    .insert(items)
    .values([
      { assessment_id: a!.id, item_set_id: set!.id, position: 1, type: "essay", stem: "Plan" },
      { assessment_id: a!.id, item_set_id: set!.id, position: 2, type: "essay", stem: "Final", config: { rubric: RUBRIC } },
    ])
    .returning();
  const [assignment] = await db
    .insert(competency_assignments)
    .values({
      assessment_id: a!.id,
      student_ps_id: STUDENT.ps_id,
      item_set_id: set!.id,
      proctor_email: "cba-proctor@psd401.net",
      assigned_by_sub: STAFF.sub,
      assigned_by_email: STAFF.email,
      status: "in_progress",
    })
    .returning();
  const [student] = await db
    .insert(students)
    .values({ owner_sub: STAFF.sub, roster_ps_id: STUDENT.ps_id, name: "x" })
    .returning();
  const [attempt] = await db
    .insert(attempts)
    .values({ assessment_id: a!.id, student_id: student!.id, status: "submitted" })
    .returning();
  const [response] = await db
    .insert(responses)
    .values({ attempt_id: attempt!.id, item_id: final!.id, response: { type: "essay", text: "essay" } })
    .returning();
  return { a: a!, assignment: assignment!, attempt: attempt!, response: response! };
}

async function score(responseId: string, claim: number, evidence: number) {
  const db = getDb();
  await db.update(scores).set({ status: "superseded" }).where(eq(scores.response_id, responseId));
  await db.insert(scores).values({
    response_id: responseId,
    method: "human",
    points: claim + evidence,
    max_points: 8,
    rationale: picks(claim, evidence),
    scorer: STAFF.sub,
    status: "final",
  });
}

type Listed = { status: string; result: string | null; released_result: string | null; attempt_id: string | null };

async function list(id: string): Promise<Listed> {
  const { GET } = await import("../app/api/assessments/[id]/competency/assignments/route");
  const res = await GET(new Request("http://local/x"), { params: Promise.resolve({ id }) });
  return ((await res.json()) as { assignments: Listed[] }).assignments[0]!;
}

async function release(id: string, assignmentId: string) {
  const { PATCH } = await import("../app/api/assessments/[id]/competency/assignments/[assignmentId]/route");
  return PATCH(new Request("http://local/x", { method: "PATCH", body: JSON.stringify({ action: "release" }) }), {
    params: Promise.resolve({ id, assignmentId }),
  });
}

describe("release", () => {
  test("handed in → scored (Pass) → released, storing what was released", async () => {
    const { a, assignment, attempt, response } = await seedCase();
    expect((await list(a.id)).status).toBe("handed_in");
    expect((await release(a.id, assignment.id)).status).toBe(409);

    await score(response.id, 3, 4);
    const scored = await list(a.id);
    expect(scored).toMatchObject({ status: "scored", result: "pass", attempt_id: attempt.id });

    expect((await release(a.id, assignment.id)).status).toBe(200);
    expect(await list(a.id)).toMatchObject({ status: "released", result: "pass", released_result: "pass" });
    // Released twice in a row is refused: nothing new to release.
    expect((await release(a.id, assignment.id)).status).toBe(409);
  });

  test("one criterion below 3 is Needs revision; a rescore after release reads Scored and re-releases", async () => {
    const { a, assignment, response } = await seedCase();
    await score(response.id, 2, 4);
    expect((await list(a.id)).result).toBe("needs_revision");
    expect((await release(a.id, assignment.id)).status).toBe(200);

    // Passed back and revised: the next final score is newer than the release.
    await new Promise((r) => setTimeout(r, 5));
    await score(response.id, 3, 3);
    expect(await list(a.id)).toMatchObject({ status: "scored", result: "pass", released_result: "needs_revision" });
    expect((await release(a.id, assignment.id)).status).toBe(200);
    expect((await list(a.id)).released_result).toBe("pass");
  });

  test("a passed-back attempt reads In progress, and cannot be released", async () => {
    const { a, assignment, attempt, response } = await seedCase();
    await score(response.id, 3, 3);
    await getDb().update(attempts).set({ status: "in_progress" }).where(eq(attempts.id, attempt.id));
    expect((await list(a.id)).status).toBe("in_progress");
    expect((await release(a.id, assignment.id)).status).toBe(409);
  });

  test("only Assessment staff release (404 otherwise)", async () => {
    const { a, assignment, response } = await seedCase();
    await score(response.id, 3, 3);
    delete process.env.COMPETENCY_ADMIN_EMAILS;
    expect((await release(a.id, assignment.id)).status).toBe(404);
  });
});

describe("counselors", () => {
  async function schoolOf(ps: string) {
    const [row] = await getDb().select().from(roster_students).where(eq(roster_students.ps_id, ps));
    if (!row?.school_id) throw new Error(`fixture student ${ps} has no school`);
    return row.school_id;
  }

  async function addCounselor(body: unknown) {
    const { POST } = await import("../app/api/competency/counselors/route");
    return POST(new Request("http://local/x", { method: "POST", body: JSON.stringify(body) }));
  }

  test("Assessment staff add a counselor to a school; anyone else, a student address or an unknown school is refused", async () => {
    const school = await schoolOf(STUDENT.ps_id);
    expect((await addCounselor({ grantee_email: STUDENT.email, school_id: school })).status).toBe(400);
    expect((await addCounselor({ grantee_email: COUNSELOR.email, school_id: "no-such-school" })).status).toBe(400);
    expect((await addCounselor({ grantee_email: COUNSELOR.email, school_id: school })).status).toBe(201);
    expect((await addCounselor({ grantee_email: COUNSELOR.email, school_id: school })).status).toBe(409);
    delete process.env.COMPETENCY_ADMIN_EMAILS;
    expect((await addCounselor({ grantee_email: "someone@psd401.net", school_id: school })).status).toBe(404);
    expect(await counselorSchoolIds(getDb(), COUNSELOR.email)).toEqual([school]);
  });

  test("the counselor sees released results for their school only, and nothing else opens", async () => {
    const { a, assignment, response } = await seedCase();
    const school = await schoolOf(STUDENT.ps_id);
    await addCounselor({ grantee_email: COUNSELOR.email, school_id: school });
    await score(response.id, 3, 3);

    // Scored but not released: nothing yet.
    let rows = await releasedResultsForSchools(getDb(), await counselorSchoolIds(getDb(), COUNSELOR.email));
    expect(rows).toEqual([]);

    await release(a.id, assignment.id);
    rows = await releasedResultsForSchools(getDb(), await counselorSchoolIds(getDb(), COUNSELOR.email));
    expect(rows.map((r) => [r.result, r.school_id])).toEqual([["pass", school]]);

    // Another school's counselor sees none of it.
    // 1005 is the fixture's one student at a different school.
    const otherSchool = await schoolOf("1005");
    expect(otherSchool).not.toBe(school);
    expect(await releasedResultsForSchools(getDb(), [otherSchool])).toEqual([]);

    // The school grant opens no assessment, at any level.
    for (const need of ["view", "run", "score", "edit"] as const) {
      expect((await authorizeAssessment(getDb(), COUNSELOR, a.id, need, "read")).ok).toBe(false);
    }
  });

  test("removing a counselor ends their access", async () => {
    const school = await schoolOf(STUDENT.ps_id);
    const created = (await (await addCounselor({ grantee_email: COUNSELOR.email, school_id: school })).json()) as {
      grant: { id: string };
    };
    const { DELETE } = await import("../app/api/competency/counselors/[grantId]/route");
    const del = () => DELETE(new Request("http://local/x"), { params: Promise.resolve({ grantId: created.grant.id }) });
    expect((await del()).status).toBe(204);
    expect((await del()).status).toBe(404);
    expect(await counselorSchoolIds(getDb(), COUNSELOR.email)).toEqual([]);
  });
});

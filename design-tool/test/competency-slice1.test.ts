// Competency assessments, slice 1 (docs/competency-assessment-design.md):
// the Assessment-staff list (D-14), the Pass / Needs Revision / No Score
// derivation, and `PUT /api/assessments/:id/competency` on the test DB.
//
// The derivation is the rule a student's credit hangs on, so it is pinned row
// by row: one criterion below the minimum is a Needs Revision however strong
// the rest are, and an incomplete score yields no result rather than a guess.
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import type { Rubric } from "@secure-test/schema";
import { closeDb, getDb } from "../db/client";
import { assessments } from "../db/schema";
import { SESSION_COOKIE_NAME } from "../lib/auth/session";
import * as headersMod from "next/headers";
import * as sessionMod from "../lib/auth/session";
import { competencyAdminEmails, isAdmin, isCompetencyAdmin } from "../lib/auth/admin";
import { deriveCompetencyResult } from "../lib/scoring/competencyResult";

const ASSESSMENT_STAFF = "assessment-office@psd401.net";
const TEACHER_EMAIL = "cba-teacher@psd401.net";

// --- the list ---------------------------------------------------------------

describe("isCompetencyAdmin", () => {
  afterEach(() => {
    delete process.env.COMPETENCY_ADMIN_EMAILS;
    delete process.env.ADMIN_EMAILS;
  });

  test("nobody is Assessment staff when the list is unset", () => {
    expect(competencyAdminEmails()).toEqual([]);
    expect(isCompetencyAdmin({ email: ASSESSMENT_STAFF })).toBe(false);
  });

  test("a listed address is, case- and space-insensitively", () => {
    process.env.COMPETENCY_ADMIN_EMAILS = ` ${ASSESSMENT_STAFF.toUpperCase()} ,`;
    expect(isCompetencyAdmin({ email: ASSESSMENT_STAFF })).toBe(true);
    expect(isCompetencyAdmin({ email: TEACHER_EMAIL })).toBe(false);
  });

  test("never while impersonating", () => {
    process.env.COMPETENCY_ADMIN_EMAILS = ASSESSMENT_STAFF;
    expect(isCompetencyAdmin({ email: ASSESSMENT_STAFF, actor_sub: "someone" })).toBe(false);
  });

  test("the two lists are independent", () => {
    process.env.ADMIN_EMAILS = TEACHER_EMAIL;
    process.env.COMPETENCY_ADMIN_EMAILS = ASSESSMENT_STAFF;
    expect(isCompetencyAdmin({ email: TEACHER_EMAIL })).toBe(false);
    expect(isAdmin({ email: ASSESSMENT_STAFF })).toBe(false);
  });
});

// --- the derivation ---------------------------------------------------------

const level = (n: number) => ({ id: `l${n}`, label: String(n), points: n });
const RUBRIC: Rubric = {
  style: "analytic",
  criteria: ["claim", "evidence", "citations"].map((id) => ({
    id,
    name: id,
    levels: [level(4), level(3), level(2), level(1)],
  })),
} as Rubric;

const picks = (claim: number, evidence: number, citations: number) => ({
  criterion_scores: [
    { criterion_id: "claim", level_id: `l${claim}`, points: claim, rationale: "" },
    { criterion_id: "evidence", level_id: `l${evidence}`, points: evidence, rationale: "" },
    { criterion_id: "citations", level_id: `l${citations}`, points: citations, rationale: "" },
  ],
});

describe("deriveCompetencyResult", () => {
  test("every criterion at the minimum or above is a pass", () => {
    expect(deriveCompetencyResult(RUBRIC, picks(3, 3, 3), 3)).toBe("pass");
    expect(deriveCompetencyResult(RUBRIC, picks(4, 3, 4), 3)).toBe("pass");
  });

  test("one criterion below the minimum is needs revision", () => {
    expect(deriveCompetencyResult(RUBRIC, picks(4, 4, 2), 3)).toBe("needs_revision");
    expect(deriveCompetencyResult(RUBRIC, picks(1, 1, 1), 3)).toBe("needs_revision");
  });

  test("a No Score reason wins over the picks", () => {
    expect(
      deriveCompetencyResult(RUBRIC, { ...picks(4, 4, 4), no_score_reason: "copied" }, 3),
    ).toBe("no_score");
  });

  test("an unknown No Score reason is ignored", () => {
    expect(
      deriveCompetencyResult(RUBRIC, { ...picks(3, 3, 3), no_score_reason: "bored" }, 3),
    ).toBe("pass");
  });

  test("no result for an incomplete or bare-points score", () => {
    const partial = { criterion_scores: picks(4, 4, 4).criterion_scores.slice(0, 2) };
    expect(deriveCompetencyResult(RUBRIC, partial, 3)).toBeNull();
    expect(deriveCompetencyResult(RUBRIC, { note: "override" }, 3)).toBeNull();
    expect(deriveCompetencyResult(RUBRIC, null, 3)).toBeNull();
    expect(
      deriveCompetencyResult(RUBRIC, { criterion_scores: [{ criterion_id: "claim" }] }, 3),
    ).toBeNull();
  });
});

// --- the route --------------------------------------------------------------

const expectTestDb = () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("secure_test_design_tool_test")) {
    throw new Error(`competency tests require the test DB; got: ${url}`);
  }
};

type Principal = { sub: string; role: string; email?: string } | null;
let principal: Principal = null;

mock.module("next/headers", () => ({
  ...headersMod,
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

describe("PUT /api/assessments/:id/competency", () => {
  beforeAll(() => {
    expectTestDb();
  });
  afterEach(async () => {
    principal = null;
    delete process.env.COMPETENCY_ADMIN_EMAILS;
    await getDb().execute(sql`truncate table assessments restart identity cascade`);
  });
  afterAll(async () => {
    await closeDb();
  });

  async function newAssessment(ownerSub: string, ownerEmail: string) {
    const [row] = await getDb()
      .insert(assessments)
      .values({ owner_sub: ownerSub, owner_email: ownerEmail, name: "CBA" })
      .returning();
    if (!row) throw new Error("insert returned no row");
    return row;
  }

  async function reload(id: string) {
    const [row] = await getDb().select().from(assessments).where(eq(assessments.id, id));
    if (!row) throw new Error("assessment vanished");
    return row;
  }

  async function put(id: string, body: unknown) {
    const { PUT } = await import("../app/api/assessments/[id]/competency/route");
    return PUT(
      new Request(`http://local/api/assessments/${id}/competency`, {
        method: "PUT",
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id }) },
    );
  }

  test("Assessment staff mark their own assessment district with a pass rule", async () => {
    process.env.COMPETENCY_ADMIN_EMAILS = ASSESSMENT_STAFF;
    const a = await newAssessment("staff-sub", ASSESSMENT_STAFF);
    principal = { sub: "staff-sub", role: "staff", email: ASSESSMENT_STAFF };
    const res = await put(a.id, { pass_min_points_per_criterion: 3 });
    expect(res.status).toBe(200);
    const row = await reload(a.id);
    expect(row.assigned_scope).toBe("district");
    expect(row.competency_pass_min_points).toBe(3);
  });

  test("an owner who is not on the list is refused", async () => {
    const a = await newAssessment("teacher-sub", TEACHER_EMAIL);
    principal = { sub: "teacher-sub", role: "staff", email: TEACHER_EMAIL };
    const res = await put(a.id, { pass_min_points_per_criterion: 3 });
    expect(res.status).toBe(404);
    const row = await reload(a.id);
    expect(row.assigned_scope).toBe("teacher");
    expect(row.competency_pass_min_points).toBeNull();
  });

  test("Assessment staff cannot claim someone else's assessment", async () => {
    process.env.COMPETENCY_ADMIN_EMAILS = ASSESSMENT_STAFF;
    const a = await newAssessment("teacher-sub", TEACHER_EMAIL);
    principal = { sub: "staff-sub", role: "staff", email: ASSESSMENT_STAFF };
    const res = await put(a.id, { pass_min_points_per_criterion: 3 });
    expect(res.status).not.toBe(200);
    const row = await reload(a.id);
    expect(row.assigned_scope).toBe("teacher");
  });

  test("a bad body is refused", async () => {
    process.env.COMPETENCY_ADMIN_EMAILS = ASSESSMENT_STAFF;
    const a = await newAssessment("staff-sub", ASSESSMENT_STAFF);
    principal = { sub: "staff-sub", role: "staff", email: ASSESSMENT_STAFF };
    expect((await put(a.id, { pass_min_points_per_criterion: -1 })).status).toBe(400);
    expect((await put(a.id, { pass_min_points_per_criterion: 3, extra: 1 })).status).toBe(400);
  });
});

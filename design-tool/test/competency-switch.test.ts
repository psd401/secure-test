// F-1 (hand-run 2026-11-02, docs/competency-assessment-design.md D-18):
// Switch option — withdraw, assign the new option and reopen a handed-in
// test as one action — and the status rule that keeps a hand-in from an
// earlier option from reading as this case's.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { closeDb, getDb } from "../db/client";
import {
  access_grants,
  assessments,
  attempt_events,
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
import { caseStatusOf } from "../lib/competency/caseState";
import { STUDENT, clearRoster, seedRoster } from "./helpers/roster";

describe("a hand-in from before the assignment is not this case's", () => {
  const at = (m: number) => new Date(2026, 10, 2, 9, m);
  test("submitted before the case was made reads as not started", () => {
    expect(
      caseStatusOf({
        stored: "assigned",
        released_at: null,
        attempt_status: "submitted",
        result: null,
        scored_at: null,
        attempt_submitted_at: at(1),
        assigned_at: at(5),
      }),
    ).toBe("assigned");
  });
  test("submitted after it reads Handed in, as before", () => {
    expect(
      caseStatusOf({
        stored: "in_progress",
        released_at: null,
        attempt_status: "submitted",
        result: null,
        scored_at: null,
        attempt_submitted_at: at(9),
        assigned_at: at(5),
      }),
    ).toBe("handed_in");
  });
});

const expectTestDb = () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("secure_test_design_tool_test")) {
    throw new Error(`switch tests require the test DB; got: ${url}`);
  }
};

const STAFF = { sub: "assessment-office-sub", role: "staff", email: "assessment-office@psd401.net" };
const COUNSELOR = { sub: "counselor-sub", role: "staff", email: "cba-counselor@psd401.net" };
const PROCTOR = "cba-proctor@psd401.net";

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

/** Two options; STUDENT on option 1 with a handed-in, scored attempt unless `attempt` is "none". */
async function seed(opts: { attempt?: "none" | "submitted"; timed?: boolean } = {}) {
  const db = getDb();
  const [a] = await db
    .insert(assessments)
    .values({ owner_sub: STAFF.sub, owner_email: STAFF.email, name: "CBA", assigned_scope: "district" })
    .returning();
  const [s1, s2] = await db
    .insert(item_sets)
    .values([{ assessment_id: a!.id }, { assessment_id: a!.id }])
    .returning();
  const [final1] = await db
    .insert(items)
    .values({ assessment_id: a!.id, item_set_id: s1!.id, position: 1, type: "essay", stem: "Final 1" })
    .returning();
  const [assignment] = await db
    .insert(competency_assignments)
    .values({
      assessment_id: a!.id,
      student_ps_id: STUDENT.ps_id,
      item_set_id: s1!.id,
      proctor_email: PROCTOR,
      assigned_by_sub: STAFF.sub,
      assigned_by_email: STAFF.email,
      status: "in_progress",
    })
    .returning();
  let attemptId: string | null = null;
  if (opts.attempt !== "none") {
    const [student] = await db
      .insert(students)
      .values({ owner_sub: STAFF.sub, roster_ps_id: STUDENT.ps_id, name: "x" })
      .returning();
    const [att] = await db
      .insert(attempts)
      .values({
        assessment_id: a!.id,
        student_id: student!.id,
        status: "submitted",
        submitted_at: new Date(),
        ...(opts.timed ? { deadline_override_at: new Date(Date.now() - 3600e3) } : {}),
      })
      .returning();
    const [resp] = await db
      .insert(responses)
      .values({ attempt_id: att!.id, item_id: final1!.id, response: { type: "essay", text: "x" } })
      .returning();
    await db.insert(scores).values({
      response_id: resp!.id,
      method: "human",
      points: 1,
      max_points: 1,
      scorer: STAFF.sub,
      status: "final",
    });
    attemptId = att!.id;
  }
  return { a: a!, s1: s1!, s2: s2!, assignment: assignment!, attemptId };
}

async function patch(id: string, assignmentId: string, body: unknown) {
  const { PATCH } = await import("../app/api/assessments/[id]/competency/assignments/[assignmentId]/route");
  return PATCH(new Request("http://local/x", { method: "PATCH", body: JSON.stringify(body) }), {
    params: Promise.resolve({ id, assignmentId }),
  });
}

const liveCases = async (assessmentId: string) =>
  (await getDb().select().from(competency_assignments).where(eq(competency_assignments.assessment_id, assessmentId)))
    .filter((r) => r.status !== "withdrawn");

describe("switch_option", () => {
  test("no attempt yet: old case withdrawn, new one live on the new option, same proctor, nothing reopened", async () => {
    const { a, s2, assignment } = await seed({ attempt: "none" });
    const res = await patch(a.id, assignment.id, { action: "switch_option", item_set_id: s2.id });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { reopened: boolean }).reopened).toBe(false);
    const live = await liveCases(a.id);
    expect(live.map((r) => [r.item_set_id, r.proctor_email])).toEqual([[s2.id, PROCTOR]]);
    const [old] = await getDb().select().from(competency_assignments).where(eq(competency_assignments.id, assignment.id));
    expect(old?.status).toBe("withdrawn");
  });

  test("a handed-in test reopens: in progress, old final superseded, a passed_back event", async () => {
    const { a, s2, assignment, attemptId } = await seed();
    const res = await patch(a.id, assignment.id, { action: "switch_option", item_set_id: s2.id });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { reopened: boolean }).reopened).toBe(true);
    const [att] = await getDb().select().from(attempts).where(eq(attempts.id, attemptId!));
    expect(att?.status).toBe("in_progress");
    expect(att?.pass_back_count).toBe(1);
    const sc = await getDb().select().from(scores);
    expect(sc.map((s) => s.status)).toEqual(["superseded"]);
    const ev = await getDb().select().from(attempt_events).where(eq(attempt_events.attempt_id, attemptId!));
    expect(ev.map((e) => e.kind)).toContain("passed_back");
  });

  test("a timed test needs an end; without one nothing changes", async () => {
    const { a, s2, assignment, attemptId } = await seed({ timed: true });
    const refused = await patch(a.id, assignment.id, { action: "switch_option", item_set_id: s2.id });
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toBe("ends_at_required");
    expect((await liveCases(a.id)).map((r) => r.id)).toEqual([assignment.id]);

    const end = new Date(Date.now() + 24 * 3600e3);
    const ok = await patch(a.id, assignment.id, { action: "switch_option", item_set_id: s2.id, ends_at: end.toISOString() });
    expect(ok.status).toBe(200);
    const [att] = await getDb().select().from(attempts).where(eq(attempts.id, attemptId!));
    expect(att?.deadline_override_at?.toISOString()).toBe(end.toISOString());
  });

  test("the same option, another assessment's option, or a withdrawn case is refused", async () => {
    const { a, s1, assignment } = await seed({ attempt: "none" });
    const other = await seed({ attempt: "none" });
    expect((await patch(a.id, assignment.id, { action: "switch_option", item_set_id: s1.id })).status).toBe(400);
    expect((await patch(a.id, assignment.id, { action: "switch_option", item_set_id: other.s2.id })).status).toBe(400);
    await patch(a.id, assignment.id, { action: "withdraw" });
    expect((await patch(a.id, assignment.id, { action: "switch_option", item_set_id: other.s2.id })).status).toBe(409);
  });

  test("a counselor switches their school's student (reopening the test); another school's is 404", async () => {
    const { a, s2, assignment, attemptId } = await seed();
    const [me] = await getDb().select().from(roster_students).where(eq(roster_students.ps_id, STUDENT.ps_id));
    const grant = (school: string) =>
      getDb().insert(access_grants).values({
        grantee_email: COUNSELOR.email,
        scope_kind: "school",
        scope_id: school,
        level: "run",
        granted_by_sub: STAFF.sub,
        granted_by_email: STAFF.email,
      });
    principal = COUNSELOR;
    await grant("some-other-school");
    expect((await patch(a.id, assignment.id, { action: "switch_option", item_set_id: s2.id })).status).toBe(404);
    await grant(me!.school_id!);
    expect((await patch(a.id, assignment.id, { action: "switch_option", item_set_id: s2.id })).status).toBe(200);
    const [att] = await getDb().select().from(attempts).where(eq(attempts.id, attemptId!));
    expect(att?.status).toBe("in_progress");
  });
});

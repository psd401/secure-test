// Competency assessments, slice 3 (docs/competency-assessment-design.md, D-4):
// a district assessment is delivered only as the option on the student's live
// assignment. The load-bearing assertions are negative and run on the raw
// response text: no stem, stimulus or source of another option appears
// anywhere in the bundle, and without a live assignment nothing is served.
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { closeDb, getDb } from "../db/client";
import { assessments, attempts, competency_assignments, item_sets, items, responses, students } from "../db/schema";
import { SESSION_COOKIE_NAME } from "../lib/auth/session";
import * as headersMod from "next/headers";
import * as sessionMod from "../lib/auth/session";
import { STUDENT, clearRoster, seedRoster, studentPrincipal } from "./helpers/roster";

const expectTestDb = () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("secure_test_design_tool_test")) {
    throw new Error(`competency delivery tests require the test DB; got: ${url}`);
  }
};

const OWNER = "assessment-office-sub";

type Principal = { sub: string; role: string; email?: string } | null;
let principal: Principal = studentPrincipal();

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

let originalSecret: string | undefined;

beforeAll(async () => {
  expectTestDb();
  await clearRoster();
  await seedRoster();
  originalSecret = process.env.DESIGN_TOOL_SESSION_SECRET;
  process.env.DESIGN_TOOL_SESSION_SECRET ||= "competency-delivery-test-secret";
});

afterEach(async () => {
  principal = studentPrincipal();
  const db = getDb();
  await db.execute(sql`truncate table assessments restart identity cascade`);
  await db.execute(sql`truncate table students restart identity cascade`);
});

afterAll(async () => {
  await clearRoster();
  await closeDb();
  if (originalSecret === undefined) delete process.env.DESIGN_TOOL_SESSION_SECRET;
  else process.env.DESIGN_TOOL_SESSION_SECRET = originalSecret;
});

async function getDelivery(id: string) {
  const { GET } = await import("../app/api/assessments/[id]/delivery/route");
  return GET(new Request(`http://localhost/api/assessments/${id}/delivery`), { params: Promise.resolve({ id }) });
}

/**
 * Two options, each a set with its own marked stimulus, source and two
 * questions, plus one shared question in no set. Every marker is unique, so a
 * substring search of the response finds any leak.
 */
async function seedCba(scope: "district" | "teacher" = "district") {
  const db = getDb();
  const [a] = await db
    .insert(assessments)
    .values({ owner_sub: OWNER, name: "CBA task", assigned_scope: scope })
    .returning();
  const opt = async (n: 1 | 2, start: number) => {
    const [set] = await db
      .insert(item_sets)
      .values({
        assessment_id: a!.id,
        stimulus_text: `OPT${n}-STIMULUS prompt text`,
        sources: [{ label: `OPT${n}-SOURCE-LABEL`, text: `OPT${n}-SOURCE-TEXT ${"x".repeat(20)}` }],
      })
      .returning();
    const qs = await db
      .insert(items)
      .values([
        { assessment_id: a!.id, item_set_id: set!.id, position: start, type: "essay", stem: `OPT${n}-PLANNING` },
        { assessment_id: a!.id, item_set_id: set!.id, position: start + 1, type: "essay", stem: `OPT${n}-FINAL` },
      ])
      .returning();
    return { set: set!, qs };
  };
  const one = await opt(1, 1);
  const two = await opt(2, 3);
  const [shared] = await db
    .insert(items)
    .values({ assessment_id: a!.id, position: 5, type: "essay", stem: "SHARED-REFLECTION" })
    .returning();
  const [student] = await db
    .insert(students)
    .values({ owner_sub: OWNER, ssid: STUDENT.ssid, roster_ps_id: STUDENT.ps_id, name: STUDENT.name })
    .returning();
  const [attempt] = await db
    .insert(attempts)
    .values({ assessment_id: a!.id, student_id: student!.id, status: "in_progress" })
    .returning();
  return { a: a!, one, two, shared: shared!, attempt: attempt! };
}

async function assign(assessmentId: string, itemSetId: string, status: "assigned" | "withdrawn" = "assigned") {
  const [row] = await getDb()
    .insert(competency_assignments)
    .values({
      assessment_id: assessmentId,
      student_ps_id: STUDENT.ps_id,
      item_set_id: itemSetId,
      proctor_email: "cba-proctor@psd401.net",
      assigned_by_sub: OWNER,
      assigned_by_email: "assessment-office@psd401.net",
      status,
      ...(status === "withdrawn" ? { withdrawn_at: new Date() } : {}),
    })
    .returning();
  return row!;
}

const OPT1 = ["OPT1-STIMULUS", "OPT1-SOURCE-LABEL", "OPT1-SOURCE-TEXT", "OPT1-PLANNING", "OPT1-FINAL"];
const OPT2 = OPT1.map((m) => m.replace("OPT1", "OPT2"));

describe("competency delivery: only the assigned option", () => {
  test("the bundle carries the assigned option and the shared question, and nothing of the other option", async () => {
    const { a, two, shared } = await seedCba();
    await assign(a.id, two.set.id);
    const res = await getDelivery(a.id);
    expect(res.status).toBe(200);
    const text = await res.text();
    for (const m of OPT2) expect(text).toContain(m);
    expect(text).toContain("SHARED-REFLECTION");
    for (const m of OPT1) expect(text).not.toContain(m);

    const body = JSON.parse(text) as { items: { id: string }[]; item_sets: { id: string; item_ids: string[] }[] };
    expect(body.items.map((i) => i.id)).toEqual([...two.qs.map((q) => q.id), shared.id]);
    expect(body.item_sets.map((s) => s.id)).toEqual([two.set.id]);
  });

  test("no assignment, or only a withdrawn one, serves nothing (404)", async () => {
    const { a, one } = await seedCba();
    let res = await getDelivery(a.id);
    expect(res.status).toBe(404);
    await assign(a.id, one.set.id, "withdrawn");
    res = await getDelivery(a.id);
    expect(res.status).toBe(404);
    const text = await res.text();
    for (const m of [...OPT1, ...OPT2, "SHARED-REFLECTION"]) expect(text).not.toContain(m);
  });

  test("a switch of option (D-18) serves the new option, and the old option's saved answers stay out", async () => {
    const { a, one, two, attempt } = await seedCba();
    const first = await assign(a.id, one.set.id);
    await getDb().insert(responses).values({
      attempt_id: attempt.id,
      item_id: one.qs[1]!.id,
      response: { type: "essay", text: "OPT1-SAVED-ANSWER" },
    });
    expect(await (await getDelivery(a.id)).text()).toContain("OPT1-SAVED-ANSWER");

    await getDb()
      .update(competency_assignments)
      .set({ status: "withdrawn", withdrawn_at: new Date() })
      .where(eq(competency_assignments.id, first.id));
    await assign(a.id, two.set.id);
    const res = await getDelivery(a.id);
    expect(res.status).toBe(200);
    const text = await res.text();
    for (const m of OPT2) expect(text).toContain(m);
    for (const m of [...OPT1, "OPT1-SAVED-ANSWER"]) expect(text).not.toContain(m);
    // The old option's answer is still on the attempt, as the record.
    const kept = await getDb().select().from(responses).where(eq(responses.attempt_id, attempt.id));
    expect(kept).toHaveLength(1);
  });

  test("another student's assignment does not admit this one", async () => {
    const { a, one } = await seedCba();
    await getDb()
      .insert(competency_assignments)
      .values({
        assessment_id: a.id,
        student_ps_id: "1002",
        item_set_id: one.set.id,
        proctor_email: "cba-proctor@psd401.net",
        assigned_by_sub: OWNER,
        assigned_by_email: "assessment-office@psd401.net",
      });
    expect((await getDelivery(a.id)).status).toBe(404);
  });

  test("a teacher's own assessment is unchanged: every option, no assignment needed", async () => {
    const { a } = await seedCba("teacher");
    const res = await getDelivery(a.id);
    expect(res.status).toBe(200);
    const text = await res.text();
    for (const m of [...OPT1, ...OPT2, "SHARED-REFLECTION"]) expect(text).toContain(m);
  });
});

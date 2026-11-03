// Competency assessments, slice 7 server half (docs/competency-assessment-
// design.md, D-16): after a Needs Revision is passed back, the delivery
// bundle carries the scorer's per-row feedback beside the option's final
// response — only past the renderer floor, and never for a Pass, a classroom
// test, a fresh option, or once the revision is rescored.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { DeliveryBundleSchema, type Rubric } from "@secure-test/schema";
import { closeDb, getDb } from "../db/client";
import {
  assessments,
  attempts,
  competency_assignments,
  item_sets,
  items,
  response_feedback,
  responses,
  scores,
  students,
} from "../db/schema";
import { SESSION_COOKIE_NAME } from "../lib/auth/session";
import * as headersMod from "next/headers";
import * as sessionMod from "../lib/auth/session";
import { setRevisionFeedbackRendererFloor, MIN_RENDERER_VERSION_FOR_REVISION_FEEDBACK } from "../lib/items/clientSupport";
import { setRendererResolver, type RendererResolver } from "../lib/renderer/current";
import { STUDENT, clearRoster, seedRoster, studentPrincipal } from "./helpers/roster";

const expectTestDb = () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("secure_test_design_tool_test")) {
    throw new Error(`revision feedback tests require the test DB; got: ${url}`);
  }
};

const OWNER = "assessment-office-sub";
const RENDERER_VERSION = 2_000_000_000;

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

const fakeRenderer: RendererResolver = {
  current: async () => ({ sha256: "a".repeat(64), version: RENDERER_VERSION }),
  reset() {},
};

let previousResolver: RendererResolver;
let previousFloor: number | null;
let originalFlag: string | undefined;
let originalSecret: string | undefined;

beforeAll(async () => {
  expectTestDb();
  await clearRoster();
  await seedRoster();
  originalSecret = process.env.DESIGN_TOOL_SESSION_SECRET;
  process.env.DESIGN_TOOL_SESSION_SECRET ||= "revision-feedback-test-secret";
  originalFlag = process.env.RENDERER_DELIVERY;
  previousResolver = setRendererResolver(fakeRenderer);
});

beforeEach(() => {
  principal = studentPrincipal();
  process.env.RENDERER_DELIVERY = "on";
  previousFloor = setRevisionFeedbackRendererFloor(RENDERER_VERSION);
});

afterEach(async () => {
  setRevisionFeedbackRendererFloor(previousFloor);
  const db = getDb();
  await db.execute(sql`truncate table assessments restart identity cascade`);
  await db.execute(sql`truncate table students restart identity cascade`);
});

afterAll(async () => {
  setRendererResolver(previousResolver);
  if (originalFlag === undefined) delete process.env.RENDERER_DELIVERY;
  else process.env.RENDERER_DELIVERY = originalFlag;
  if (originalSecret === undefined) delete process.env.DESIGN_TOOL_SESSION_SECRET;
  else process.env.DESIGN_TOOL_SESSION_SECRET = originalSecret;
  await clearRoster();
  await closeDb();
});

async function getDelivery(id: string, clientVersion: string | null = "2.0.0") {
  const { GET } = await import("../app/api/assessments/[id]/delivery/route");
  return GET(
    new Request(`http://localhost/api/assessments/${id}/delivery`, {
      headers: clientVersion ? { "X-SecureTest-Version": clientVersion } : {},
    }),
    { params: Promise.resolve({ id }) },
  );
}

const lvl = (n: number) => ({ id: `l${n}`, label: `Level ${n}`, points: n });
const RUBRIC = {
  style: "analytic",
  criteria: [
    { id: "claim", name: "Claim", levels: [lvl(4), lvl(3), lvl(2), lvl(1)] },
    { id: "evidence", name: "Evidence", levels: [lvl(4), lvl(3), lvl(2), lvl(1)] },
  ],
} as Rubric;

/**
 * A passed-back CBA: one option whose final response was scored and the
 * score superseded by pass back. `claim`/`evidence` are the old picks.
 */
async function seed(opts: { claim: number; evidence: number; scope?: "district" | "teacher"; passBacks?: number }) {
  const db = getDb();
  const [a] = await db
    .insert(assessments)
    .values({
      owner_sub: OWNER,
      name: "CBA",
      assigned_scope: opts.scope ?? "district",
      competency_pass_min_points: 3,
    })
    .returning();
  const [set] = await db.insert(item_sets).values({ assessment_id: a!.id }).returning();
  const [plan, final] = await db
    .insert(items)
    .values([
      { assessment_id: a!.id, item_set_id: set!.id, position: 1, type: "essay", stem: "Plan" },
      { assessment_id: a!.id, item_set_id: set!.id, position: 2, type: "essay", stem: "Final", config: { rubric: RUBRIC } },
    ])
    .returning();
  await db.insert(competency_assignments).values({
    assessment_id: a!.id,
    student_ps_id: STUDENT.ps_id,
    item_set_id: set!.id,
    proctor_email: "cba-proctor@psd401.net",
    assigned_by_sub: OWNER,
    assigned_by_email: "assessment-office@psd401.net",
    status: "released",
    result: "needs_revision",
  });
  const [student] = await db
    .insert(students)
    .values({ owner_sub: OWNER, ssid: STUDENT.ssid, roster_ps_id: STUDENT.ps_id, name: STUDENT.name })
    .returning();
  const [attempt] = await db
    .insert(attempts)
    .values({ assessment_id: a!.id, student_id: student!.id, status: "in_progress", pass_back_count: opts.passBacks ?? 1 })
    .returning();
  const [response] = await db
    .insert(responses)
    .values({ attempt_id: attempt!.id, item_id: final!.id, response: { type: "essay", text: "first draft" } })
    .returning();
  await db.insert(scores).values({
    response_id: response!.id,
    method: "human",
    points: opts.claim + opts.evidence,
    max_points: 8,
    rationale: {
      criterion_scores: [
        { criterion_id: "claim", level_id: `l${opts.claim}`, points: opts.claim, rationale: "Your claim is unclear." },
        { criterion_id: "evidence", level_id: `l${opts.evidence}`, points: opts.evidence, rationale: "" },
      ],
    },
    scorer: OWNER,
    status: "superseded",
  });
  return { a: a!, plan: plan!, final: final!, response: response! };
}

describe("revision feedback in the delivery bundle", () => {
  test("a passed-back Needs Revision carries the old score's rows and the written note, on the final response", async () => {
    const { a, final, response } = await seed({ claim: 2, evidence: 4 });
    await getDb().insert(response_feedback).values({ response_id: response.id, author_sub: OWNER, text: "Revise your claim." });
    const body = await (await getDelivery(a.id)).json();
    expect(body.revision_feedback).toEqual({
      [final.id]: {
        criteria: [
          { name: "Claim", level_label: "Level 2", rationale: "Your claim is unclear." },
          { name: "Evidence", level_label: "Level 4" },
        ],
        note: "Revise your claim.",
      },
    });
    expect(DeliveryBundleSchema.parse(body).revision_feedback).toBeDefined();
  });

  test("below the floor, an older client, or no renderer: no field, and the test still opens", async () => {
    const { a } = await seed({ claim: 2, evidence: 4 });
    setRevisionFeedbackRendererFloor(RENDERER_VERSION + 1);
    let res = await getDelivery(a.id);
    expect(res.status).toBe(200);
    expect(await res.json()).not.toHaveProperty("revision_feedback");

    setRevisionFeedbackRendererFloor(RENDERER_VERSION);
    res = await getDelivery(a.id, "1.9.0");
    expect(res.status).toBe(200);
    expect(await res.json()).not.toHaveProperty("revision_feedback");

    delete process.env.RENDERER_DELIVERY;
    res = await getDelivery(a.id);
    expect(await res.json()).not.toHaveProperty("revision_feedback");
  });

  test("the shipped floor is null: nothing is emitted until the merge sets it", async () => {
    expect(MIN_RENDERER_VERSION_FOR_REVISION_FEEDBACK).toBeNull();
    const { a } = await seed({ claim: 2, evidence: 4 });
    setRevisionFeedbackRendererFloor(null);
    expect(await (await getDelivery(a.id)).json()).not.toHaveProperty("revision_feedback");
  });

  test("a superseded Pass sends nothing", async () => {
    const { a } = await seed({ claim: 3, evidence: 4 });
    expect(await (await getDelivery(a.id)).json()).not.toHaveProperty("revision_feedback");
  });

  test("an attempt never passed back carries nothing", async () => {
    const fresh = await seed({ claim: 2, evidence: 4, passBacks: 0 });
    expect(await (await getDelivery(fresh.a.id)).json()).not.toHaveProperty("revision_feedback");
  });

  test("a classroom assessment never carries it", async () => {
    const { a } = await seed({ claim: 2, evidence: 4, scope: "teacher" });
    expect(await (await getDelivery(a.id)).json()).not.toHaveProperty("revision_feedback");
  });

  test("once the revision has a new final score, the panel goes away", async () => {
    const { a, response } = await seed({ claim: 2, evidence: 4 });
    await getDb().insert(scores).values({
      response_id: response.id,
      method: "human",
      points: 7,
      max_points: 8,
      rationale: { criterion_scores: [] },
      scorer: OWNER,
      status: "final",
    });
    expect(await (await getDelivery(a.id)).json()).not.toHaveProperty("revision_feedback");
  });

  test("a switched option (D-18) carries no feedback from the old one", async () => {
    const { a } = await seed({ claim: 2, evidence: 4 });
    const db = getDb();
    const [newSet] = await db.insert(item_sets).values({ assessment_id: a.id }).returning();
    await db
      .insert(items)
      .values({ assessment_id: a.id, item_set_id: newSet!.id, position: 3, type: "essay", stem: "Other final", config: { rubric: RUBRIC } });
    await db
      .update(competency_assignments)
      .set({ status: "withdrawn", withdrawn_at: new Date() })
      .where(eq(competency_assignments.assessment_id, a.id));
    await db.insert(competency_assignments).values({
      assessment_id: a.id,
      student_ps_id: STUDENT.ps_id,
      item_set_id: newSet!.id,
      proctor_email: "cba-proctor@psd401.net",
      assigned_by_sub: OWNER,
      assigned_by_email: "assessment-office@psd401.net",
    });
    expect(await (await getDelivery(a.id)).json()).not.toHaveProperty("revision_feedback");
  });
});

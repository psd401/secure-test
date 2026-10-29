// Score all with AI at the top of the scoring queue (beta feedback
// 2026-10-28): the review-queue payload carries `ai_batch`, the same count the
// Results page's button shows, over the filtered section's handed-in attempts,
// and only at edit access.
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { sql } from "drizzle-orm";
import type { Rubric } from "@secure-test/schema";
import { closeDb, getDb } from "../db/client";
import { access_grants, assessments, attempts, items, responses, scores, students } from "../db/schema";
import { SESSION_COOKIE_NAME } from "../lib/auth/session";
import * as headersMod from "next/headers";
import * as sessionMod from "../lib/auth/session";
import { OTHER_TEACHER_EMAIL, TEACHER_EMAIL, staffPrincipal, type TestPrincipal } from "./helpers/roster";

const OWNER = "queue-ai-batch-teacher";
const OTHER = "queue-ai-batch-coteacher";
let principal: TestPrincipal = staffPrincipal(OWNER);

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

let originalSessionSecret: string | undefined;

beforeAll(() => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("secure_test_design_tool_test")) {
    throw new Error(`review-queue-ai-batch tests require the test DB DATABASE_URL; got: ${url}`);
  }
  originalSessionSecret = process.env.DESIGN_TOOL_SESSION_SECRET;
  process.env.DESIGN_TOOL_SESSION_SECRET = "test-session-secret-do-not-use";
});

afterEach(async () => {
  principal = staffPrincipal(OWNER);
  const db = getDb();
  await db.execute(sql`truncate table assessments restart identity cascade`);
  await db.execute(sql`truncate table students restart identity cascade`);
  await db.execute(sql`truncate table access_grants restart identity cascade`);
});

afterAll(async () => {
  await closeDb();
  if (originalSessionSecret === undefined) delete process.env.DESIGN_TOOL_SESSION_SECRET;
  else process.env.DESIGN_TOOL_SESSION_SECRET = originalSessionSecret;
});

const RUBRIC: Rubric = {
  style: "holistic",
  criteria: [
    {
      id: "c",
      name: "Overall",
      levels: [
        { id: "l0", label: "Missing", points: 0 },
        { id: "l1", label: "Complete", points: 1 },
      ],
    },
  ],
};

// Two handed-in students answer one AI short answer; the second is already
// scored, so one answer is waiting. Neither student has a roster section.
async function seed(method: "ai" | "human" = "ai") {
  const db = getDb();
  const [a] = await db.insert(assessments).values({ owner_sub: OWNER, name: "Batch queue" }).returning();
  const [item] = await db
    .insert(items)
    .values({
      assessment_id: a!.id,
      position: 0,
      type: "short_text",
      stem: "Why?",
      config: method === "ai" ? { scoring_method: "ai", rubric: RUBRIC } : { scoring_method: "human" },
    })
    .returning();
  const studentRows = await db
    .insert(students)
    .values([
      { owner_sub: OWNER, ssid: "901", name: "Batch Student One" },
      { owner_sub: OWNER, ssid: "902", name: "Batch Student Two" },
    ])
    .returning();
  const attemptRows = await db
    .insert(attempts)
    .values(
      studentRows.map((s) => ({
        assessment_id: a!.id,
        student_id: s.id,
        status: "submitted" as const,
        submitted_at: new Date(),
      })),
    )
    .returning();
  const responseRows = await db
    .insert(responses)
    .values(
      attemptRows.map((at) => ({
        attempt_id: at.id,
        item_id: item!.id,
        response: { type: "short_text" as const, text: "Because." },
      })),
    )
    .returning();
  await db.insert(scores).values({
    response_id: responseRows[1]!.id,
    method: "human",
    points: 1,
    max_points: 1,
    scorer: OWNER,
    status: "final",
    reviewed_by_sub: OWNER,
  });
  return { assessment: a!, attempts: attemptRows };
}

type Body = { ai_batch?: { has_ai_items: boolean; attempt_ids: string[]; count: number } };

async function getQueue(assessmentId: string, query = "") {
  const { GET } = await import("../app/api/assessments/[id]/review-queue/route");
  const res = await GET(
    new Request(`http://localhost/api/assessments/${assessmentId}/review-queue${query}`),
    { params: Promise.resolve({ id: assessmentId }) },
  );
  expect(res.status).toBe(200);
  return (await res.json()) as Body;
}

describe("review-queue ai_batch", () => {
  test("counts the unscored AI answers, by attempt", async () => {
    const { assessment, attempts: at } = await seed();
    const body = await getQueue(assessment.id);
    expect(body.ai_batch).toEqual({ has_ai_items: true, attempt_ids: [at[0]!.id], count: 1 });
  });

  test("follows the section filter", async () => {
    const { assessment, attempts: at } = await seed();
    expect((await getQueue(assessment.id, "?section=__none__")).ai_batch?.attempt_ids).toEqual([at[0]!.id]);
    expect((await getQueue(assessment.id, "?section=Period%202")).ai_batch).toEqual({
      has_ai_items: true,
      attempt_ids: [],
      count: 0,
    });
  });

  test("no AI item: has_ai_items is false", async () => {
    const { assessment } = await seed("human");
    expect((await getQueue(assessment.id)).ai_batch?.has_ai_items).toBe(false);
  });

  test("absent below edit access, present at edit", async () => {
    const { assessment } = await seed();
    const db = getDb();
    const grant = {
      grantee_email: OTHER_TEACHER_EMAIL,
      scope_kind: "assessment",
      scope_id: assessment.id,
      granted_by_sub: OWNER,
      granted_by_email: TEACHER_EMAIL,
    };
    await db.insert(access_grants).values({ ...grant, level: "view" });
    principal = staffPrincipal(OTHER, OTHER_TEACHER_EMAIL);
    expect((await getQueue(assessment.id)).ai_batch).toBeUndefined();

    await db.execute(sql`update access_grants set level = 'edit'`);
    expect((await getQueue(assessment.id)).ai_batch?.count).toBe(1);
  });
});

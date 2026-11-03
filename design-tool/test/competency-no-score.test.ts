// Competency assessments: the No Score write path (docs/competency-assessment-
// design.md, "The pass rule"). A scorer marks OSPI's No Score with a reason;
// it is 0 points with no rubric picks, it is accepted only on a district
// assessment's rubric-scored response, and it yields the `no_score` result.
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import type { Rubric } from "@secure-test/schema";
import { closeDb, getDb } from "../db/client";
import { assessments, attempts, items, responses, scores, students } from "../db/schema";
import { SESSION_COOKIE_NAME } from "../lib/auth/session";
import * as headersMod from "next/headers";
import * as sessionMod from "../lib/auth/session";
import { ManualScoreBody, checkManualScore } from "../lib/api/reviewActions";
import { deriveCompetencyResult, noScoreLabel } from "../lib/scoring/competencyResult";

const lvl = (n: number) => ({ id: `l${n}`, label: String(n), points: n });
const RUBRIC = {
  style: "analytic",
  criteria: ["claim", "evidence"].map((id) => ({ id, name: id, levels: [lvl(4), lvl(3), lvl(2), lvl(1)] })),
} as Rubric;

describe("the No Score body", () => {
  test("0 points and a reason is a No Score", () => {
    const b = ManualScoreBody.parse({ points: 0, max_points: 8, no_score_reason: "off_topic" });
    expect(b.no_score_reason).toBe("off_topic");
  });

  test("points, picks or an unknown reason are refused", () => {
    expect(ManualScoreBody.safeParse({ points: 2, max_points: 8, no_score_reason: "off_topic" }).success).toBe(false);
    expect(
      ManualScoreBody.safeParse({
        points: 0,
        max_points: 8,
        no_score_reason: "off_topic",
        criterion_scores: [{ criterion_id: "claim", level_id: "l1", points: 0 }],
      }).success,
    ).toBe(false);
    expect(ManualScoreBody.safeParse({ points: 0, max_points: 8, no_score_reason: "too_short" }).success).toBe(false);
  });

  test("only a competency assessment's rubric-scored response takes one", () => {
    const item = { config: { rubric: RUBRIC }, type: "essay" } as unknown as Parameters<typeof checkManualScore>[0];
    const plain = { config: {}, type: "essay" } as unknown as Parameters<typeof checkManualScore>[0];
    const body = ManualScoreBody.parse({ points: 0, max_points: 8, no_score_reason: "copied" });
    expect(checkManualScore(item, body, { competency: true }).ok).toBe(true);
    expect(checkManualScore(item, body).ok).toBe(false);
    expect(checkManualScore(plain, ManualScoreBody.parse({ points: 0, max_points: 1, no_score_reason: "copied" }), { competency: true }).ok).toBe(false);
  });

  test("the label, and the result it yields", () => {
    expect(noScoreLabel({ no_score_reason: "not_english" })).toBe("No Score: Not in English");
    expect(noScoreLabel({ criterion_scores: [] })).toBeNull();
    expect(deriveCompetencyResult(RUBRIC, { no_score_reason: "unintelligible" }, 3)).toBe("no_score");
  });
});

// --- the routes ---------------------------------------------------------------

const expectTestDb = () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("secure_test_design_tool_test")) {
    throw new Error(`no-score tests require the test DB; got: ${url}`);
  }
};

const STAFF = { sub: "assessment-office-sub", role: "staff", email: "assessment-office@psd401.net" };

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

describe("POST /score and /change-score with a No Score", () => {
  beforeAll(() => expectTestDb());
  afterEach(async () => {
    principal = STAFF;
    const db = getDb();
    await db.execute(sql`truncate table assessments restart identity cascade`);
    await db.execute(sql`truncate table students restart identity cascade`);
  });
  afterAll(async () => {
    await closeDb();
  });

  async function seed(scope: "district" | "teacher") {
    const db = getDb();
    const [a] = await db
      .insert(assessments)
      .values({ owner_sub: STAFF.sub, owner_email: STAFF.email, name: "CBA", assigned_scope: scope })
      .returning();
    const [item] = await db
      .insert(items)
      .values({ assessment_id: a!.id, position: 1, type: "essay", stem: "Final", config: { rubric: RUBRIC } })
      .returning();
    const [student] = await db.insert(students).values({ owner_sub: STAFF.sub, name: "x" }).returning();
    const [attempt] = await db
      .insert(attempts)
      .values({ assessment_id: a!.id, student_id: student!.id, status: "submitted" })
      .returning();
    const [response] = await db
      .insert(responses)
      .values({ attempt_id: attempt!.id, item_id: item!.id, response: { type: "essay", text: "x" } })
      .returning();
    return response!;
  }

  const post = async (path: "score" | "change-score", responseId: string, body: unknown) => {
    const mod =
      path === "score"
        ? await import("../app/api/responses/[responseId]/score/route")
        : await import("../app/api/responses/[responseId]/change-score/route");
    return mod.POST(new Request("http://local/x", { method: "POST", body: JSON.stringify(body) }), {
      params: Promise.resolve({ responseId }),
    });
  };

  const finalOf = async (responseId: string) =>
    (await getDb().select().from(scores).where(eq(scores.response_id, responseId))).find((s) => s.status === "final");

  test("a district assessment stores the reason on a 0-point final", async () => {
    const response = await seed("district");
    const res = await post("score", response.id, { points: 0, max_points: 8, no_score_reason: "off_purpose" });
    expect(res.status).toBe(201);
    const final = await finalOf(response.id);
    expect(final?.points).toBe(0);
    expect(final?.rationale).toEqual({ no_score_reason: "off_purpose" });
  });

  test("a classroom assessment refuses it and writes nothing", async () => {
    const response = await seed("teacher");
    const res = await post("score", response.id, { points: 0, max_points: 8, no_score_reason: "off_purpose" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("no_score_not_allowed");
    expect(await finalOf(response.id)).toBeUndefined();
  });

  test("Change score can turn a scored response into a No Score, and back", async () => {
    const response = await seed("district");
    const picks = [
      { criterion_id: "claim", level_id: "l3", points: 3 },
      { criterion_id: "evidence", level_id: "l3", points: 3 },
    ];
    expect((await post("score", response.id, { points: 6, max_points: 8, criterion_scores: picks })).status).toBe(201);
    expect((await post("change-score", response.id, { points: 0, max_points: 8, no_score_reason: "copied" })).status).toBe(201);
    // Change score also records what it replaced (`changed_from`).
    expect((await finalOf(response.id))?.rationale).toMatchObject({ no_score_reason: "copied" });
    expect((await finalOf(response.id))?.points).toBe(0);
    expect((await post("change-score", response.id, { points: 6, max_points: 8, criterion_scores: picks })).status).toBe(201);
    expect(noScoreLabel((await finalOf(response.id))?.rationale)).toBeNull();
  });
});

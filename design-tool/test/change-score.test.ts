// Change a final score (docs/change-score-design.md, slice 1):
// `POST /api/responses/[responseId]/change-score`, `lib/api/changeScore.ts`,
// and the cause `lib/scoring/supersededScores.ts` now reports.
//
// Harness: superseded-scores.test.ts's — a staff principal mocked at the
// session module, the route driven in process against the test DB.
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import type { Rubric } from "@secure-test/schema";
import { closeDb, getDb } from "../db/client";
import {
  assessments,
  attempt_events,
  attempts,
  items,
  responses,
  scores,
  students,
} from "../db/schema";
import { SESSION_COOKIE_NAME } from "../lib/auth/session";
import * as sessionMod from "../lib/auth/session";
import { passBackAttempt } from "../lib/api/passBackAttempt";
import { buildResults } from "../lib/scoring/results";
import { listSupersededScores } from "../lib/scoring/supersededScores";

const expectTestDb = () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("secure_test_design_tool_test")) {
    throw new Error(`change-score tests require the test DB; got: ${url}`);
  }
};

const OWNER = "change-score-teacher";
const OTHER = "change-score-other-teacher";
let mockSub: string | null = OWNER;

mock.module("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({
    get: (name: string) => (mockSub && name === SESSION_COOKIE_NAME ? { value: "x" } : undefined),
  }),
}));

mock.module("../lib/auth/session", () => ({
  ...sessionMod,
  readSessionFromCookies: async () => (mockSub ? { sub: mockSub, role: "staff" } : null),
}));

let originalSecret: string | undefined;

beforeAll(() => {
  expectTestDb();
  originalSecret = process.env.DESIGN_TOOL_SESSION_SECRET;
  process.env.DESIGN_TOOL_SESSION_SECRET ||= "change-score-test-secret-do-not-use";
});

afterEach(async () => {
  mockSub = OWNER;
  const db = getDb();
  await db.execute(sql`truncate table assessments restart identity cascade`);
  await db.execute(sql`truncate table students restart identity cascade`);
});

afterAll(async () => {
  await closeDb();
  if (originalSecret === undefined) delete process.env.DESIGN_TOOL_SESSION_SECRET;
  else process.env.DESIGN_TOOL_SESSION_SECRET = originalSecret;
});

const RUBRIC: Rubric = {
  style: "analytic",
  criteria: [
    {
      id: "ideas",
      name: "Ideas",
      levels: [
        { id: "i1", label: "Emerging", points: 1 },
        { id: "i2", label: "Developing", points: 2 },
        { id: "i3", label: "Proficient", points: 3 },
      ],
    },
    {
      id: "org",
      name: "Organization",
      levels: [
        { id: "o1", label: "Emerging", points: 1 },
        { id: "o2", label: "Proficient", points: 2 },
      ],
    },
  ],
};

/**
 * A handed-in attempt: an auto MC with an `auto` final (1 of 1) and a rubric
 * essay (max 5) with a `human` final of 3 — unless `essayFinal` is false.
 */
async function scene(opts: { essayFinal?: boolean } = {}) {
  const db = getDb();
  const [assessment] = await db
    .insert(assessments)
    .values({ owner_sub: OWNER, name: "Change score" })
    .returning();
  const [mc] = await db
    .insert(items)
    .values({
      assessment_id: assessment!.id,
      position: 0,
      type: "multiple_choice_single",
      stem: "Pick one",
      choices: [
        { id: "c1", text: "one" },
        { id: "c2", text: "two" },
      ],
      correct_choice_ids: ["c1"],
    })
    .returning();
  const [essay] = await db
    .insert(items)
    .values({
      assessment_id: assessment!.id,
      position: 1,
      type: "essay",
      stem: "Explain",
      config: { rubric: RUBRIC },
    })
    .returning();
  const [student] = await db
    .insert(students)
    .values({ owner_sub: OWNER, ssid: "CHG-1", name: "Chg Student" })
    .returning();
  const [attempt] = await db
    .insert(attempts)
    .values({
      assessment_id: assessment!.id,
      student_id: student!.id,
      status: "submitted",
      submitted_at: new Date(),
    })
    .returning();
  const [mcResponse, essayResponse] = await db
    .insert(responses)
    .values([
      {
        attempt_id: attempt!.id,
        item_id: mc!.id,
        response: { type: "multiple_choice_single", choice_id: "c1" },
      },
      {
        attempt_id: attempt!.id,
        item_id: essay!.id,
        response: { type: "essay", text: "A first draft." },
      },
    ])
    .returning();
  const [mcScore] = await db
    .insert(scores)
    .values({
      response_id: mcResponse!.id,
      method: "auto",
      points: 1,
      max_points: 1,
      scorer: "auto",
      status: "final",
    })
    .returning();
  let essayScore: typeof scores.$inferSelect | undefined;
  if (opts.essayFinal !== false) {
    [essayScore] = await db
      .insert(scores)
      .values({
        response_id: essayResponse!.id,
        method: "human",
        points: 3,
        max_points: 5,
        scorer: OWNER,
        status: "final",
        reviewed_by_sub: OWNER,
      })
      .returning();
  }
  return {
    assessment: assessment!,
    mc: mc!,
    essay: essay!,
    attempt: attempt!,
    mcResponse: mcResponse!,
    essayResponse: essayResponse!,
    mcScore: mcScore!,
    essayScore,
  };
}

async function postChange(responseId: string, body: unknown) {
  const { POST } = await import("../app/api/responses/[responseId]/change-score/route");
  return POST(
    new Request(`http://localhost/api/responses/${responseId}/change-score`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ responseId }) },
  );
}

async function scoreRows(responseId: string) {
  return getDb().select().from(scores).where(eq(scores.response_id, responseId));
}

describe("POST /api/responses/[responseId]/change-score", () => {
  test("supersedes the final, writes a human final, logs the event; results read the new points", async () => {
    const s = await scene();
    const before = await buildResults(s.assessment.id);
    expect(before.rows[0]!.total_points).toBe(4);

    const res = await postChange(s.essayResponse.id, { points: 4, max_points: 5 });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.score).toMatchObject({
      response_id: s.essayResponse.id,
      method: "human",
      points: 4,
      max_points: 5,
      status: "final",
      scorer: OWNER,
      reviewed_by_sub: OWNER,
    });
    expect(body.score.rationale).toEqual({
      changed_from: { score_id: s.essayScore!.id, points: 3, method: "human", scorer: OWNER },
    });

    const rows = await scoreRows(s.essayResponse.id);
    const old = rows.find((r) => r.id === s.essayScore!.id)!;
    expect(old.status).toBe("superseded");
    expect(rows.filter((r) => r.status === "final").map((r) => r.id)).toEqual([body.score.id]);

    const events = await getDb()
      .select()
      .from(attempt_events)
      .where(
        and(eq(attempt_events.attempt_id, s.attempt.id), eq(attempt_events.kind, "score_changed")),
      );
    expect(events).toHaveLength(1);
    expect(events[0]!.detail).toEqual({
      response_id: s.essayResponse.id,
      item_id: s.essay.id,
      from: 3,
      to: 4,
      max: 5,
    });

    const after = await buildResults(s.assessment.id);
    expect(after.rows[0]!.total_points).toBe(5);
    expect(after.rows[0]!.cells.map((c) => c.points)).toEqual([1, 4]);
  });

  test("the reason is stored as the new row's note", async () => {
    const s = await scene();
    const res = await postChange(s.essayResponse.id, {
      points: 2,
      max_points: 5,
      reason: "Misread the second paragraph",
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.score.rationale.note).toBe("Misread the second paragraph");
  });

  test("a reason over 500 characters is refused", async () => {
    const s = await scene();
    const res = await postChange(s.essayResponse.id, {
      points: 2,
      max_points: 5,
      reason: "x".repeat(501),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_body");
  });

  test("criterion picks are validated against the rubric and kept", async () => {
    const s = await scene();
    const bad = await postChange(s.essayResponse.id, {
      points: 5,
      max_points: 5,
      criterion_scores: [{ criterion_id: "ideas", level_id: "nope", points: 3 }],
    });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe("rubric_bounds");

    const good = await postChange(s.essayResponse.id, {
      points: 5,
      max_points: 5,
      criterion_scores: [
        { criterion_id: "ideas", level_id: "i3", points: 3 },
        { criterion_id: "org", level_id: "o2", points: 2 },
      ],
    });
    expect(good.status).toBe(201);
    expect((await good.json()).score.rationale.criterion_scores).toHaveLength(2);
  });

  test("an auto final can be changed (D-2)", async () => {
    const s = await scene();
    const res = await postChange(s.mcResponse.id, { points: 0, max_points: 1 });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.score.method).toBe("human");
    expect(body.score.rationale.changed_from).toEqual({
      score_id: s.mcScore.id,
      points: 1,
      method: "auto",
      scorer: "auto",
    });
    const rows = await scoreRows(s.mcResponse.id);
    expect(rows.find((r) => r.id === s.mcScore.id)!.status).toBe("superseded");
  });

  test("max_points must equal the item's max", async () => {
    const s = await scene();
    const res = await postChange(s.essayResponse.id, { points: 1, max_points: 1 });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "max_points_mismatch", expected: 5 });
    // Nothing moved.
    const rows = await scoreRows(s.essayResponse.id);
    expect(rows.map((r) => r.status)).toEqual(["final"]);
  });

  test("409 no_final when the response has no final", async () => {
    const s = await scene({ essayFinal: false });
    const res = await postChange(s.essayResponse.id, { points: 2, max_points: 5 });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("no_final");
    expect(await scoreRows(s.essayResponse.id)).toHaveLength(0);
  });

  test("a passed-back attempt: refused while in progress, no_final once handed in again", async () => {
    const s = await scene();
    await passBackAttempt(getDb(), s.attempt, OWNER);
    const open = await postChange(s.essayResponse.id, { points: 2, max_points: 5 });
    expect(open.status).toBe(400);
    expect((await open.json()).error).toBe("attempt_not_submitted");

    await getDb()
      .update(attempts)
      .set({ status: "submitted", submitted_at: new Date() })
      .where(eq(attempts.id, s.attempt.id));
    const again = await postChange(s.essayResponse.id, { points: 2, max_points: 5 });
    expect(again.status).toBe(409);
    expect((await again.json()).error).toBe("no_final");
  });

  test("another teacher gets 404", async () => {
    const s = await scene();
    mockSub = OTHER;
    const res = await postChange(s.essayResponse.id, { points: 2, max_points: 5 });
    expect(res.status).toBe(404);
    mockSub = OWNER;
    expect((await scoreRows(s.essayResponse.id)).map((r) => r.status)).toEqual(["final"]);
  });

  test("a bad id is 400", async () => {
    const res = await postChange("not-a-uuid", { points: 1, max_points: 1 });
    expect(res.status).toBe(400);
  });
});

describe("listSupersededScores reports why a row was set aside", () => {
  test("a changed row is cause 'changed' with its replacement; a pass back is 'pass_back'", async () => {
    const s = await scene();
    const changed = await postChange(s.essayResponse.id, {
      points: 4,
      max_points: 5,
      reason: "Regraded",
    });
    expect(changed.status).toBe(201);
    const newScore = (await changed.json()).score;

    // Before any pass back: the one superseded row is the changed essay score.
    const first = await listSupersededScores(getDb(), s.attempt.id);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      response_id: s.essayResponse.id,
      points: 3,
      cause: "changed",
      replaced_by: { points: 4, note: "Regraded" },
    });
    expect(first[0]!.replaced_by!.created_at).toBeInstanceOf(Date);

    // Pass back: the MC final and the essay's NEW final are set aside too.
    const [attempt] = await getDb().select().from(attempts).where(eq(attempts.id, s.attempt.id));
    await passBackAttempt(getDb(), attempt!, OWNER);
    const rows = await listSupersededScores(getDb(), s.attempt.id);
    expect(rows).toHaveLength(3);
    const byScore = (points: number, responseId: string) =>
      rows.find((r) => r.points === points && r.response_id === responseId)!;
    // The changed row still says changed — its replacement is superseded now,
    // but still names it.
    expect(byScore(3, s.essayResponse.id)).toMatchObject({
      cause: "changed",
      replaced_by: { points: 4, note: "Regraded" },
    });
    expect(byScore(4, s.essayResponse.id).cause).toBe("pass_back");
    expect(byScore(4, s.essayResponse.id).replaced_by).toBeUndefined();
    expect(byScore(1, s.mcResponse.id).cause).toBe("pass_back");
    expect(newScore.status).toBe("final");
  });
});

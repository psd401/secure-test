// Pass back (docs/pass-back-design.md, D-2): `superseded` is a score that is
// KEPT as a record and is not the score. This file is the proof of the second
// half — every teacher-facing reader is blind to it — and of the one reader
// that is not (`listSupersededScores`, which slice 2's "Earlier scores" section
// is built on).
//
// Why a reader-by-reader sweep rather than one test: the status was added for
// the auto-scoring pass's benefit (it skips a response that already has a
// `final`, so a changed answer would otherwise keep its old number), and each
// reader reaches the same rows by its own query. A single assertion on one of
// them would leave the others free to surface a superseded row as a live score
// — the packet's "latest ai row, whatever its status" branch did exactly that
// until this slice.
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { closeDb, getDb } from "../db/client";
import { assessments, attempts, items, responses, scores, students } from "../db/schema";
import { SESSION_COOKIE_NAME } from "../lib/auth/session";
import * as sessionMod from "../lib/auth/session";
import { buildResults, resultsToCsv } from "../lib/scoring/results";
import { summarizeCohort } from "../lib/reporting/printSummary";
import { selectPacketScores } from "../lib/reporting/workPacket";
import { describeAnswer } from "../lib/reporting/answerView";
import { runAutoScoringPass } from "../lib/scoring/runAutoScoring";
import { listSupersededScores } from "../lib/scoring/supersededScores";

const expectTestDb = () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("secure_test_design_tool_test")) {
    throw new Error(`superseded-score tests require the test DB; got: ${url}`);
  }
};

const OWNER = "superseded-teacher";
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
  process.env.DESIGN_TOOL_SESSION_SECRET ||= "superseded-test-secret-do-not-use";
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

/**
 * A handed-in attempt with one auto MC and one hand-scored essay, each answered,
 * each carrying ONE score row of the given status. The pass back itself is not
 * re-tested here (attempt-pass-back-api.test.ts owns it) — what matters is how
 * the readers see the rows it leaves behind.
 */
async function scene(status: "final" | "superseded") {
  const db = getDb();
  const [assessment] = await db
    .insert(assessments)
    .values({ owner_sub: OWNER, name: "Superseded" })
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
    .values({ assessment_id: assessment!.id, position: 1, type: "essay", stem: "Explain" })
    .returning();
  const [student] = await db
    .insert(students)
    .values({ owner_sub: OWNER, ssid: "SUP-1", name: "Sup Student" })
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
  await db.insert(scores).values([
    {
      response_id: mcResponse!.id,
      method: "auto",
      points: 1,
      max_points: 1,
      scorer: "auto",
      status,
    },
    {
      response_id: essayResponse!.id,
      method: "human",
      points: 3,
      max_points: 4,
      scorer: OWNER,
      status,
    },
  ]);
  return {
    assessment: assessment!,
    mc: mc!,
    essay: essay!,
    attempt: attempt!,
    mcResponse: mcResponse!,
    essayResponse: essayResponse!,
  };
}

describe("the results matrix, the CSV and the print summary are blind to superseded", () => {
  test("the same scene scores 2 of 2 as final and 0 of 2 as superseded", async () => {
    const live = await scene("final");
    const scored = await buildResults(live.assessment.id, OWNER);
    expect(scored.rows[0]!.total_points).toBe(4);
    expect(scored.rows[0]!.unscored_count).toBe(0);
    expect(scored.rows[0]!.cells.map((c) => c.status)).toEqual(["final", "final"]);
    // The print report's cohort fold reads the same rows: a complete row.
    expect(summarizeCohort(scored.rows).complete_count).toBe(1);
    // …and the CSV prints the numbers.
    expect(resultsToCsv(scored)).toContain(",1,3,");

    const db = getDb();
    await db.execute(sql`truncate table assessments restart identity cascade`);
    await db.execute(sql`truncate table students restart identity cascade`);

    const stale = await scene("superseded");
    const results = await buildResults(stale.assessment.id, OWNER);
    const row = results.rows[0]!;
    expect(row.cells.map((c) => c.status)).toEqual(["unscored", "unscored"]);
    expect(row.cells.every((c) => c.points === null)).toBe(true);
    expect(row.total_points).toBe(0);
    expect(row.unscored_count).toBe(2);
    // D-R2: no percent until nothing is unscored.
    expect(row.percent).toBeNull();
    // Nor is the row complete for the print summary's means…
    const summary = summarizeCohort(results.rows);
    expect(summary.complete_count).toBe(0);
    expect(summary.incomplete_count).toBe(1);
    expect(summary.mean_total).toBeNull();
    // …and the CSV's per-question cells are blank, not the old points.
    const csv = resultsToCsv(results);
    expect(csv).not.toContain(",3,");
    expect(csv).toContain(",,");
  });
});

describe("the review queue offers the response again", () => {
  async function queue(assessmentId: string) {
    const { GET } = await import("../app/api/assessments/[id]/review-queue/route");
    const res = await GET(
      new Request(`http://localhost/api/assessments/${assessmentId}/review-queue`),
      { params: Promise.resolve({ id: assessmentId }) },
    );
    expect(res.status).toBe(200);
    return res.json();
  }

  test("a hand-scored response whose only score is superseded is back in the queue, unproposed", async () => {
    const live = await scene("final");
    // A live final keeps it OUT — the queue is work still to do.
    expect((await queue(live.assessment.id)).entries).toHaveLength(0);

    const db = getDb();
    await db.execute(sql`truncate table assessments restart identity cascade`);
    await db.execute(sql`truncate table students restart identity cascade`);

    const stale = await scene("superseded");
    const body = await queue(stale.assessment.id);
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]!.response_id).toBe(stale.essayResponse.id);
    // The superseded row is not offered as a proposal to accept, and its points
    // are nowhere in the payload.
    expect(body.entries[0]!.proposed).toBeNull();
    expect(JSON.stringify(body)).not.toContain('"points":3');
  });
});

describe("auto-scoring re-scores a response whose only score is superseded", () => {
  test("the pass writes a new final; a live final still blocks it", async () => {
    const live = await scene("final");
    const blocked = await runAutoScoringPass(getDb(), live.attempt);
    expect(blocked.scored).toBe(0);
    expect(blocked.already_scored).toBe(1);

    const db = getDb();
    await db.execute(sql`truncate table assessments restart identity cascade`);
    await db.execute(sql`truncate table students restart identity cascade`);

    const stale = await scene("superseded");
    const summary = await runAutoScoringPass(getDb(), stale.attempt);
    expect(summary.scored).toBe(1);
    const rows = await getDb()
      .select()
      .from(scores)
      .where(eq(scores.response_id, stale.mcResponse.id));
    expect(rows.map((r) => r.status).sort()).toEqual(["final", "superseded"]);
  });
});

describe("the work packet never prints a superseded row", () => {
  const base = {
    created_at: new Date("2026-09-18T10:00:00Z"),
    points: 3,
    max_points: 4,
    rationale: null,
  };

  test("neither as the teacher score nor as the latest AI row", () => {
    const teacherish = selectPacketScores("both", [
      { ...base, status: "superseded", method: "human" },
    ]);
    expect(teacherish).toEqual({ teacher: null, ai: null });

    // The branch that used to leak: "latest ai row, whatever its status".
    const aiish = selectPacketScores("both", [
      { ...base, status: "superseded", method: "ai" },
    ]);
    expect(aiish).toEqual({ teacher: null, ai: null });

    // A live proposal beside a superseded one is still offered.
    const live = { ...base, created_at: new Date("2026-09-17T10:00:00Z"), status: "proposed", method: "ai" };
    const mixed = selectPacketScores("both", [
      { ...base, status: "superseded", method: "ai" },
      live,
    ]);
    expect(mixed.ai).toBe(live);
  });
});

describe("the answer view cannot see a score at all", () => {
  test("describeAnswer takes the item and the response, and nothing else", () => {
    // Structural on purpose: the reader is pure and score-free, so the proof
    // that a superseded row is invisible to it is that no score reaches it.
    expect(describeAnswer.length).toBe(2);
    expect(
      describeAnswer({ type: "essay", config: {} }, { type: "essay", text: "A first draft." }),
    ).toEqual({ kind: "text", text: "A first draft.", expected: null });
  });
});

describe("listSupersededScores is the one reader that sees them", () => {
  test("it returns the kept rows with their item, points and scorer — and nothing live", async () => {
    const stale = await scene("superseded");
    const rows = await listSupersededScores(getDb(), stale.attempt.id);
    expect(rows).toHaveLength(2);
    const byItem = new Map(rows.map((r) => [r.item_id, r]));
    expect(byItem.get(stale.mc.id)).toMatchObject({
      response_id: stale.mcResponse.id,
      points: 1,
      max: 1,
      method: "auto",
      scorer: "auto",
    });
    expect(byItem.get(stale.essay.id)).toMatchObject({
      points: 3,
      max: 4,
      method: "human",
      scorer: OWNER,
    });
    expect(byItem.get(stale.mc.id)!.created_at).toBeInstanceOf(Date);

    const db = getDb();
    await db.execute(sql`truncate table assessments restart identity cascade`);
    await db.execute(sql`truncate table students restart identity cascade`);

    const live = await scene("final");
    expect(await listSupersededScores(getDb(), live.attempt.id)).toEqual([]);
  });
});

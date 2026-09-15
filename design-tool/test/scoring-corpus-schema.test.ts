// Slice 1 of docs/scoring-corpus-design.md (migration 0035): the `research`
// score status and the corpus-run provenance columns. What the schema has to
// guarantee before any of the readers matter:
//   - a research row is accepted by the status CHECK,
//   - it does NOT collide with the one-final-per-response partial unique
//     index (it is never final, and any number may sit beside a final),
//   - deleting its run takes its rows with it (run_id cascade),
//   - deleting the attempt still takes everything with it (D-4).
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { closeDb, getDb } from "../db/client";
import {
  assessments,
  attempts,
  items,
  responses,
  scores,
  scoring_runs,
  students,
} from "../db/schema";

const expectTestDb = () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("secure_test_design_tool_test")) {
    throw new Error(`scoring-corpus tests require the test DB DATABASE_URL; got: ${url}`);
  }
};

const OWNER = "corpus-teacher";

beforeAll(() => {
  expectTestDb();
});

afterEach(async () => {
  const db = getDb();
  await db.execute(sql`truncate table assessments restart identity cascade`);
  await db.execute(sql`truncate table students restart identity cascade`);
  await db.execute(sql`truncate table scoring_runs restart identity cascade`);
});

afterAll(async () => {
  await closeDb();
});

async function seedResponse() {
  const db = getDb();
  const [assessment] = await db
    .insert(assessments)
    .values({ owner_sub: OWNER, name: "Corpus" })
    .returning();
  const [item] = await db
    .insert(items)
    .values({
      assessment_id: assessment!.id,
      position: 0,
      type: "essay",
      stem: "Explain the water cycle.",
      config: { scoring_method: "ai" },
    })
    .returning();
  const [student] = await db
    .insert(students)
    .values({ owner_sub: OWNER, ssid: "700", name: "Corpus Student" })
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
  const [response] = await db
    .insert(responses)
    .values({
      attempt_id: attempt!.id,
      item_id: item!.id,
      response: { type: "essay", text: "Water evaporates, condenses, falls." },
    })
    .returning();
  return { db, assessment: assessment!, attempt: attempt!, response: response! };
}

describe("scoring_runs + the research status (migration 0035)", () => {
  test("a run row carries its provider, prompt version and filter; labels are unique", async () => {
    const { db } = await seedResponse();
    const [run] = await db
      .insert(scoring_runs)
      .values({
        label: "sonnet-4-6 vs pilot finals",
        provider_id: "bedrock-us.anthropic.claude-sonnet-4-6",
        prompt_version: "2026-09-14",
        filter: { with_human_final: true, limit: 25 },
        created_by: "cli:operator",
        notes: "12 scored, 1 blocked",
      })
      .returning();
    expect(run!.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(run!.filter).toEqual({ with_human_final: true, limit: 25 });
    expect(run!.created_at).toBeInstanceOf(Date);

    const dupLabel = Promise.resolve().then(() =>
      db.insert(scoring_runs).values({
        label: "sonnet-4-6 vs pilot finals",
        provider_id: "mock",
        prompt_version: "2026-09-14",
        created_by: "cli:operator",
      }),
    );
    await expect(dupLabel).rejects.toThrow();
  });

  test("a research row is accepted and sits beside a final without colliding", async () => {
    const { db, response } = await seedResponse();
    const [run] = await db
      .insert(scoring_runs)
      .values({
        label: "run A",
        provider_id: "mock",
        prompt_version: "2026-09-14",
        created_by: "cli:operator",
      })
      .returning();
    await db.insert(scores).values({
      response_id: response.id,
      method: "human",
      points: 3,
      max_points: 4,
      scorer: OWNER,
      status: "final",
      reviewed_by_sub: OWNER,
    });
    // Two research rows on the SAME response as the final: the partial
    // unique index is on finals only, so nothing collides.
    await db.insert(scores).values([
      {
        response_id: response.id,
        method: "ai",
        points: 2,
        max_points: 4,
        scorer: "mock",
        status: "research",
        run_id: run!.id,
        prompt_version: "2026-09-14",
        rubric_snapshot: {
          style: "analytic",
          criteria: [
            {
              id: "focus",
              name: "Focus",
              levels: [
                { id: "l0", label: "Below", points: 0 },
                { id: "l1", label: "Meets", points: 4 },
              ],
            },
          ],
        },
      },
      {
        response_id: response.id,
        method: "ai",
        points: 4,
        max_points: 4,
        scorer: "mock",
        status: "research",
        run_id: run!.id,
        prompt_version: "2026-09-14",
      },
    ]);
    const rows = await db.select().from(scores).where(eq(scores.response_id, response.id));
    expect(rows).toHaveLength(3);
    const research = rows.filter((r) => r.status === "research");
    expect(research).toHaveLength(2);
    expect(research[0]!.run_id).toBe(run!.id);
    expect(research[0]!.prompt_version).toBe("2026-09-14");
    expect(research.some((r) => r.rubric_snapshot !== null)).toBe(true);
  });

  test("a fourth status is still refused", async () => {
    const { db, response } = await seedResponse();
    const badStatus = Promise.resolve().then(() =>
      db.insert(scores).values({
        response_id: response.id,
        method: "ai",
        points: 1,
        max_points: 4,
        scorer: "mock",
        status: "draft",
      }),
    );
    await expect(badStatus).rejects.toThrow();
  });

  test("deleting the run cascades its research rows; live proposals survive", async () => {
    const { db, response } = await seedResponse();
    const [run] = await db
      .insert(scoring_runs)
      .values({
        label: "run B",
        provider_id: "mock",
        prompt_version: "2026-09-14",
        created_by: "cli:operator",
      })
      .returning();
    await db.insert(scores).values([
      {
        response_id: response.id,
        method: "ai",
        points: 1,
        max_points: 4,
        scorer: "mock",
        status: "proposed",
        prompt_version: "2026-09-14",
      },
      {
        response_id: response.id,
        method: "ai",
        points: 2,
        max_points: 4,
        scorer: "mock",
        status: "research",
        run_id: run!.id,
        prompt_version: "2026-09-14",
      },
    ]);
    await db.delete(scoring_runs).where(eq(scoring_runs.id, run!.id));
    const rows = await db.select().from(scores).where(eq(scores.response_id, response.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("proposed");
    // Live proposals carry the prompt version too (no run, no snapshot).
    expect(rows[0]!.prompt_version).toBe("2026-09-14");
    expect(rows[0]!.run_id).toBeNull();
    expect(rows[0]!.rubric_snapshot).toBeNull();
  });

  test("D-4: deleting the attempt takes the research rows with it", async () => {
    const { db, attempt, response } = await seedResponse();
    const [run] = await db
      .insert(scoring_runs)
      .values({
        label: "run C",
        provider_id: "mock",
        prompt_version: "2026-09-14",
        created_by: "cli:operator",
      })
      .returning();
    await db.insert(scores).values({
      response_id: response.id,
      method: "ai",
      points: 2,
      max_points: 4,
      scorer: "mock",
      status: "research",
      run_id: run!.id,
    });
    await db.delete(attempts).where(eq(attempts.id, attempt.id));
    expect(await db.select().from(scores)).toHaveLength(0);
    // The run row itself is not a child of the attempt and stays.
    expect(await db.select().from(scoring_runs)).toHaveLength(1);
  });
});

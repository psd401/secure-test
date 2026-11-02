// Roadmap U-25 slice 2b (docs/bulk-pass-back-and-corrections-design.md):
// attempt 1 on the results rows, the CSV columns (D-18) and the words both
// pages show. The rule itself is test/attempt-one.test.ts.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { closeDb, getDb } from "../db/client";
import { assessments, attempts, items, responses, scores, students } from "../db/schema";
import {
  attemptOneChange,
  attemptOneDisplay,
  buildResults,
  resultsToCsv,
  type ResultsRow,
} from "../lib/scoring/results";
import { passBackAttempt } from "../lib/api/passBackAttempt";

type DisplayRow = Pick<
  ResultsRow,
  "attempt_one" | "status" | "total_points" | "percent" | "max_points"
>;
const handedIn = (total: number, one: ResultsRow["attempt_one"]): DisplayRow => ({
  attempt_one: one,
  status: "submitted",
  total_points: total,
  percent: Math.round((100 * total) / 10),
  max_points: 10,
});
const scored = (total: number) => ({ kind: "scored" as const, total, passed_back_at: "x" });

describe("attemptOneDisplay / attemptOneChange", () => {
  test("no attempt 1: a dash and no change", () => {
    expect(attemptOneDisplay(handedIn(7, null))).toEqual({ attempt: "—", change: "" });
  });

  test("scored both times: the total and a signed change", () => {
    expect(attemptOneDisplay(handedIn(9, scored(6)))).toEqual({ attempt: "6/10", change: "+3" });
    expect(attemptOneDisplay(handedIn(5, scored(6))).change).toBe("−1");
    expect(attemptOneDisplay(handedIn(6, scored(6))).change).toBe("0");
  });

  test("attempt 1 not fully scored: said so, no change (D-17)", () => {
    expect(
      attemptOneDisplay(handedIn(9, { kind: "not_fully_scored", passed_back_at: "x" })),
    ).toEqual({ attempt: "Not fully scored", change: "" });
  });

  test("latest not fully scored, or still working: no change", () => {
    expect(attemptOneChange({ ...handedIn(9, scored(6)), percent: null })).toBeNull();
    expect(
      attemptOneChange({ ...handedIn(0, scored(6)), status: "in_progress", total_points: null }),
    ).toBeNull();
  });
});

describe("buildResults + CSV (DB)", () => {
  beforeAll(() => {
    const url = process.env.DATABASE_URL ?? "";
    if (!url.includes("secure_test_design_tool_test")) {
      throw new Error(`results attempt-one tests require the test DB DATABASE_URL; got: ${url}`);
    }
  });
  afterEach(async () => {
    const db = getDb();
    await db.execute(sql`truncate table assessments restart identity cascade`);
    await db.execute(sql`truncate table students restart identity cascade`);
  });
  afterAll(async () => {
    await closeDb();
  });

  /** One MC item; student 0 answered right and was passed back, student 1
   * never was. Both handed in once, scored auto. */
  async function seed() {
    const db = getDb();
    const [assessment] = await db
      .insert(assessments)
      .values({ owner_sub: "results-a1-teacher", name: "Attempt one results" })
      .returning();
    const [item] = await db
      .insert(items)
      .values({
        assessment_id: assessment!.id,
        position: 0,
        type: "multiple_choice_single",
        stem: "Pick one",
        choices: [
          { id: "a", text: "A" },
          { id: "b", text: "B" },
        ],
        correct_choice_ids: ["a"],
      })
      .returning();
    const out = [];
    for (const i of [0, 1]) {
      const [student] = await db
        .insert(students)
        .values({ owner_sub: "results-a1-teacher", ssid: `66${i}`, name: `Student ${i}` })
        .returning();
      const [attempt] = await db
        .insert(attempts)
        .values({
          assessment_id: assessment!.id,
          student_id: student!.id,
          status: "submitted",
          submitted_at: new Date(Date.now() - 60_000),
        })
        .returning();
      const [response] = await db
        .insert(responses)
        .values({
          attempt_id: attempt!.id,
          item_id: item!.id,
          response: { type: "multiple_choice_single", choice_id: "a" },
          created_at: new Date(Date.now() - 120_000),
        })
        .returning();
      await db.insert(scores).values({
        response_id: response!.id,
        method: "auto",
        points: 1,
        max_points: 1,
        scorer: "auto",
        status: "final",
        created_at: new Date(Date.now() - 60_000),
      });
      out.push({ attempt: attempt!, response: response! });
    }
    return { assessment: assessment!, rows: out };
  }

  test("no one passed back: attempt_one null and no CSV columns", async () => {
    const s = await seed();
    const results = await buildResults(s.assessment.id);
    expect(results.rows.every((r) => r.attempt_one === null)).toBe(true);
    expect(resultsToCsv(results).split("\r\n")[0]).not.toContain("attempt_1");
  });

  test("a student working again keeps attempt 1 on an in-progress row (D-19)", async () => {
    const s = await seed();
    await passBackAttempt(getDb(), s.rows[0]!.attempt, "results-a1-teacher");
    const results = await buildResults(s.assessment.id, { include_in_progress: true });
    const row = results.rows.find((r) => r.attempt_id === s.rows[0]!.attempt.id)!;
    expect(row.status).toBe("in_progress");
    expect(row.attempt_one).toMatchObject({ kind: "scored", total: 1 });
  });

  test("handed in again with a new score: CSV carries attempt_1 and change", async () => {
    const s = await seed();
    const db = getDb();
    await passBackAttempt(db, s.rows[0]!.attempt, "results-a1-teacher");
    // The retake: handed in again, now scored 0.
    await db
      .update(attempts)
      .set({ status: "submitted", submitted_at: new Date() })
      .where(eq(attempts.id, s.rows[0]!.attempt.id));
    await db.insert(scores).values({
      response_id: s.rows[0]!.response.id,
      method: "auto",
      points: 0,
      max_points: 1,
      scorer: "auto",
      status: "final",
    });

    const results = await buildResults(s.assessment.id);
    const lines = resultsToCsv(results).trim().split("\r\n");
    const header = lines[0]!.split(",");
    expect(header.slice(-2)).toEqual(["attempt_1", "change"]);
    const byName = new Map(lines.slice(1).map((l) => [l.split(",")[1], l.split(",")]));
    expect(byName.get("Student 0")!.slice(-2)).toEqual(["1", "-1"]);
    // Never passed back: blank attempt 1, blank change.
    expect(byName.get("Student 1")!.slice(-2)).toEqual(["", ""]);
  });
});

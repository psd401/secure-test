// Roadmap U-25 slice 2a (docs/bulk-pass-back-and-corrections-design.md,
// D-15…D-20): which hand-in is "attempt 1", and its score. The rule is pure
// (`attemptOneFrom`) and tested case by case; one DB test drives the real
// `passBackAttempt` so the loader reads what the app actually writes.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { closeDb, getDb } from "../db/client";
import { assessments, attempt_events, attempts, items, responses, scores, students } from "../db/schema";
import { attemptOneByAttempt, attemptOneFrom } from "../lib/scoring/attemptOne";
import { passBackAttempt } from "../lib/api/passBackAttempt";

const t = (minute: number) => new Date(Date.UTC(2026, 10, 2, 9, minute));
const ev = (kind: string, minute: number) => ({ kind, at: t(minute) });
const resp = (id: string, minute: number) => ({ id, created_at: t(minute) });
const score = (response_id: string, status: string, points: number, minute: number) => ({
  response_id,
  status,
  points,
  created_at: t(minute),
});

describe("attemptOneFrom", () => {
  test("never passed back: no attempt 1", () => {
    expect(attemptOneFrom([], [resp("r1", 1)], [score("r1", "final", 1, 5)])).toBeNull();
  });

  test("the student handed in, then a pass back: the round's scores, superseded ones included", () => {
    const one = attemptOneFrom(
      [ev("passed_back", 10)],
      [resp("r1", 1), resp("r2", 1)],
      // r1 auto-scored at hand-in; r2 scored by hand; both superseded at 10.
      [score("r1", "superseded", 1, 5), score("r2", "superseded", 2, 8), score("r1", "final", 0, 20)],
    );
    expect(one).toEqual({ kind: "scored", total: 3, passed_back_at: t(10).toISOString() });
  });

  test("a Change in the round counts: the LAST score on the answer wins", () => {
    const one = attemptOneFrom(
      [ev("passed_back", 10)],
      [resp("r1", 1)],
      [score("r1", "superseded", 1, 5), score("r1", "superseded", 3, 7)],
    );
    expect(one).toMatchObject({ kind: "scored", total: 3 });
  });

  test("proposed and research rows never count", () => {
    const one = attemptOneFrom(
      [ev("passed_back", 10)],
      [resp("r1", 1)],
      [score("r1", "proposed", 2, 6), score("r1", "research", 2, 6)],
    );
    expect(one).toMatchObject({ kind: "not_fully_scored" });
  });

  test("an answer with no score at the pass back: not fully scored (5.1)", () => {
    const one = attemptOneFrom(
      [ev("passed_back", 10)],
      [resp("r1", 1), resp("r2", 1)],
      [score("r1", "superseded", 1, 5)],
    );
    expect(one).toEqual({ kind: "not_fully_scored", passed_back_at: t(10).toISOString() });
  });

  test("an answer first written after the pass back is not part of attempt 1", () => {
    const one = attemptOneFrom(
      [ev("passed_back", 10)],
      [resp("r1", 1), resp("r2", 15)],
      [score("r1", "superseded", 1, 5), score("r2", "final", 1, 20)],
    );
    expect(one).toMatchObject({ kind: "scored", total: 1 });
  });

  test("a teacher hand-in then a pass back is an extension, not attempt 1 (D-15)", () => {
    expect(
      attemptOneFrom(
        [ev("teacher_hand_in", 5), ev("passed_back", 10)],
        [resp("r1", 1)],
        [score("r1", "superseded", 1, 5)],
      ),
    ).toBeNull();
  });

  test("extension, then the student's own hand-in, then a pass back: that round is attempt 1 (5.5)", () => {
    const one = attemptOneFrom(
      [ev("teacher_hand_in", 5), ev("passed_back", 10), ev("passed_back", 30)],
      [resp("r1", 1)],
      // 5: scored in the extension round (not this attempt's); 22: the
      // student's own hand-in; 40: after the second pass back.
      [score("r1", "superseded", 0, 5), score("r1", "superseded", 1, 22), score("r1", "final", 2, 40)],
    );
    expect(one).toEqual({ kind: "scored", total: 1, passed_back_at: t(30).toISOString() });
  });

  test("an extension round's score does not fill an unscored answer in attempt 1", () => {
    const one = attemptOneFrom(
      [ev("teacher_hand_in", 5), ev("passed_back", 10), ev("passed_back", 30)],
      [resp("r1", 1)],
      [score("r1", "superseded", 1, 6)],
    );
    expect(one).toMatchObject({ kind: "not_fully_scored" });
  });

  test("two student pass backs: attempt 1 is the first", () => {
    const one = attemptOneFrom(
      [ev("passed_back", 10), ev("passed_back", 30)],
      [resp("r1", 1)],
      [score("r1", "superseded", 1, 5), score("r1", "superseded", 2, 25)],
    );
    expect(one).toMatchObject({ kind: "scored", total: 1, passed_back_at: t(10).toISOString() });
  });

  test("no answers at all: scored, total 0", () => {
    expect(attemptOneFrom([ev("passed_back", 10)], [], [])).toMatchObject({
      kind: "scored",
      total: 0,
    });
  });
});

describe("attemptOneByAttempt (DB)", () => {
  const expectTestDb = () => {
    const url = process.env.DATABASE_URL ?? "";
    if (!url.includes("secure_test_design_tool_test")) {
      throw new Error(`attempt-one tests require the test DB DATABASE_URL; got: ${url}`);
    }
  };
  beforeAll(() => expectTestDb());
  afterEach(async () => {
    const db = getDb();
    await db.execute(sql`truncate table assessments restart identity cascade`);
    await db.execute(sql`truncate table students restart identity cascade`);
  });
  afterAll(async () => {
    await closeDb();
  });

  test("reads what passBackAttempt writes; an attempt never passed back has no entry", async () => {
    const db = getDb();
    const [assessment] = await db
      .insert(assessments)
      .values({ owner_sub: "attempt-one-teacher", name: "Attempt one" })
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

    const seeded = [];
    for (const [i, points] of [1, 0].entries()) {
      const [student] = await db
        .insert(students)
        .values({ owner_sub: "attempt-one-teacher", ssid: `55${i}`, name: `Student ${i}` })
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
          response: { type: "multiple_choice_single", choice_id: points ? "a" : "b" },
          created_at: new Date(Date.now() - 120_000),
        })
        .returning();
      await db.insert(scores).values({
        response_id: response!.id,
        method: "auto",
        points,
        max_points: 1,
        scorer: "auto",
        status: "final",
        created_at: new Date(Date.now() - 60_000),
      });
      seeded.push(attempt!);
    }

    await passBackAttempt(db, seeded[0]!, "attempt-one-teacher");
    const map = await attemptOneByAttempt(
      db,
      seeded.map((a) => a.id),
    );
    expect(map.get(seeded[0]!.id)).toMatchObject({ kind: "scored", total: 1 });
    expect(map.has(seeded[1]!.id)).toBe(false);

    // A teacher hand-in first makes the same pass back an extension.
    await db.insert(attempt_events).values({
      attempt_id: seeded[1]!.id,
      kind: "teacher_hand_in",
      at: new Date(Date.now() - 30_000),
    });
    await passBackAttempt(db, seeded[1]!, "attempt-one-teacher");
    expect((await attemptOneByAttempt(db, [seeded[1]!.id])).has(seeded[1]!.id)).toBe(false);
  });
});

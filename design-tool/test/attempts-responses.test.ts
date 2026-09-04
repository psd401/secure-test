// Slice 35: attempts + responses tables and the dev seed library.
// Direct-DB integration tests against the local test DB, predating the
// student-plane routes (slice 61), so unlike items-api.test.ts there is no
// session mock.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { ItemResponseSchema } from "@secure-test/schema";
import { closeDb, getDb } from "../db/client";
import {
  assessments,
  attempts,
  items,
  responses,
  students,
} from "../db/schema";
import { buildResponseFor, seedAttempts } from "../lib/dev/seedAttempts";

const expectTestDb = () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("secure_test_design_tool_test")) {
    throw new Error(
      `attempts-responses tests require the test DB DATABASE_URL; got: ${url}`,
    );
  }
};

beforeAll(() => {
  expectTestDb();
});

afterEach(async () => {
  const db = getDb();
  // attempts/responses cascade from both parents; clear both roots.
  await db.execute(sql`truncate table assessments restart identity cascade`);
  await db.execute(sql`truncate table students restart identity cascade`);
});

afterAll(async () => {
  await closeDb();
});

const OWNER = "test-teacher-sub";

// Drizzle query builders are thenables, not Promises; expect(...).rejects
// needs a real Promise, so force resolution through one.
const run = <T>(q: PromiseLike<T>): Promise<T> => Promise.resolve().then(() => q);

// noUncheckedIndexedAccess: assert-and-return the first row.
const one = <T>(rows: T[]): T => {
  const row = rows[0];
  if (row === undefined) throw new Error("expected at least one row");
  return row;
};

async function createFixture() {
  const db = getDb();
  const assessment = one(
    await db
      .insert(assessments)
      .values({ owner_sub: OWNER, name: "Slice 35 fixture" })
      .returning(),
  );
  const choices = [
    { id: "c1", text: "Alpha" },
    { id: "c2", text: "Beta" },
    { id: "c3", text: "Gamma" },
  ];
  const itemRows = await db
    .insert(items)
    .values([
      {
        assessment_id: assessment.id,
        position: 0,
        type: "multiple_choice_single",
        stem: "Pick one",
        choices,
        correct_choice_ids: ["c1"],
      },
      {
        assessment_id: assessment.id,
        position: 1,
        type: "multiple_choice_multi",
        stem: "Pick some",
        choices,
        correct_choice_ids: ["c1", "c2"],
      },
      {
        assessment_id: assessment.id,
        position: 2,
        type: "short_text",
        stem: "One word",
        correct_answer: "mitochondria",
      },
      {
        assessment_id: assessment.id,
        position: 3,
        type: "essay",
        stem: "Discuss",
        config: { max_word_count: 60 },
      },
    ])
    .returning();
  const student = one(
    await db
      .insert(students)
      .values({ owner_sub: OWNER, ssid: "1234567890", name: "Test Student" })
      .returning(),
  );
  return { db, assessment, itemRows, student, firstItem: one(itemRows) };
}

describe("attempts + responses constraints", () => {
  test("one response per (attempt, item) — duplicate insert rejected", async () => {
    const { db, assessment, itemRows, student, firstItem } = await createFixture();
    const attempt = one(
      await db
        .insert(attempts)
        .values({ assessment_id: assessment.id, student_id: student.id })
        .returning(),
    );
    const row = {
      attempt_id: attempt.id,
      item_id: firstItem.id,
      response: { type: "multiple_choice_single" as const, choice_id: "c1" },
    };
    await db.insert(responses).values(row);
    await expect(run(db.insert(responses).values(row))).rejects.toThrow();
  });

  test("attempts.status CHECK rejects unknown status", async () => {
    const { db, assessment, student } = await createFixture();
    await expect(
      run(
        db.insert(attempts).values({
          assessment_id: assessment.id,
          student_id: student.id,
          status: "abandoned",
        }),
      ),
    ).rejects.toThrow();
  });

  test("deleting an attempt cascades to its responses", async () => {
    const { db, assessment, itemRows, student, firstItem } = await createFixture();
    const attempt = one(
      await db
        .insert(attempts)
        .values({ assessment_id: assessment.id, student_id: student.id })
        .returning(),
    );
    await db.insert(responses).values({
      attempt_id: attempt.id,
      item_id: firstItem.id,
      response: { type: "multiple_choice_single", choice_id: "c2" },
    });
    await db.delete(attempts).where(eq(attempts.id, attempt.id));
    const remaining = await db.select().from(responses);
    expect(remaining).toHaveLength(0);
  });

  test("deleting the assessment cascades through attempts to responses", async () => {
    const { db, assessment, itemRows, student, firstItem } = await createFixture();
    const attempt = one(
      await db
        .insert(attempts)
        .values({ assessment_id: assessment.id, student_id: student.id })
        .returning(),
    );
    await db.insert(responses).values({
      attempt_id: attempt.id,
      item_id: firstItem.id,
      response: { type: "multiple_choice_single", choice_id: "c3" },
    });
    await db.delete(assessments).where(eq(assessments.id, assessment.id));
    expect(await db.select().from(attempts)).toHaveLength(0);
    expect(await db.select().from(responses)).toHaveLength(0);
  });
});

describe("seedAttempts", () => {
  test("buildResponseFor matches each item type and validates", async () => {
    const { itemRows } = await createFixture();
    for (const item of itemRows) {
      const response = buildResponseFor(item);
      expect(response.type).toBe(item.type as typeof response.type);
      expect(() => ItemResponseSchema.parse(response)).not.toThrow();
    }
  });

  test("creates seed students to cover a roster shortfall", async () => {
    const { db, assessment, itemRows } = await createFixture(); // roster of 1
    const result = await seedAttempts(db, {
      assessmentId: assessment.id,
      count: 3,
    });
    expect(result.attemptIds).toHaveLength(3);
    expect(result.responseCount).toBe(3 * itemRows.length);
    const roster = await db
      .select()
      .from(students)
      .where(eq(students.owner_sub, OWNER));
    expect(roster).toHaveLength(3); // 1 fixture + 2 SEED-###
    expect(roster.filter((s) => s.ssid?.startsWith("SEED-"))).toHaveLength(2);

    // Every seeded response is schema-valid and marked submitted.
    const allResponses = await db.select().from(responses);
    expect(allResponses).toHaveLength(3 * itemRows.length);
    for (const r of allResponses) {
      expect(() => ItemResponseSchema.parse(r.response)).not.toThrow();
    }
    const allAttempts = await db.select().from(attempts);
    for (const a of allAttempts) {
      expect(a.status).toBe("submitted");
      expect(a.submitted_at).not.toBeNull();
    }
  });

  test("reuses existing roster students when the roster suffices", async () => {
    const { db, assessment } = await createFixture();
    const result = await seedAttempts(db, {
      assessmentId: assessment.id,
      count: 1,
    });
    expect(result.attemptIds).toHaveLength(1);
    const roster = await db
      .select()
      .from(students)
      .where(eq(students.owner_sub, OWNER));
    expect(roster).toHaveLength(1); // no SEED students created
  });

  test("rejects an assessment with no items", async () => {
    const db = getDb();
    const empty = one(
      await db
        .insert(assessments)
        .values({ owner_sub: OWNER, name: "No items" })
        .returning(),
    );
    await expect(
      seedAttempts(db, { assessmentId: empty.id, count: 1 }),
    ).rejects.toThrow(/no items/);
  });

  test("rejects an unknown assessment id", async () => {
    const db = getDb();
    await expect(
      seedAttempts(db, {
        assessmentId: "00000000-0000-0000-0000-000000000000",
        count: 1,
      }),
    ).rejects.toThrow(/not found/);
  });
});

// Slice 47: seeded match responses are schema-valid for both outcomes.
describe("buildResponseFor — match (slice 47)", () => {
  test("produces a schema-valid pair mapping covering every pair id", () => {
    const item = {
      id: "00000000-0000-0000-0000-00000000feed",
      type: "match",
      choices: [],
      correct_choice_ids: [],
      correct_answer: null,
      config: {
        pairs: [
          { id: "p1", left: "L1", right: "R1" },
          { id: "p2", left: "L2", right: "R2" },
          { id: "p3", left: "L3", right: "R3" },
        ],
      },
    } as unknown as Parameters<typeof buildResponseFor>[0];
    // Random correctness — run enough times to hit both branches.
    for (let i = 0; i < 20; i++) {
      const response = buildResponseFor(item);
      expect(() => ItemResponseSchema.parse(response)).not.toThrow();
      if (response.type === "match") {
        expect(Object.keys(response.matches).sort()).toEqual(["p1", "p2", "p3"]);
      }
    }
  });
});

// Slice 48: seeded order responses are schema-valid for both outcomes.
describe("buildResponseFor — order (slice 48)", () => {
  test("produces a schema-valid arrangement covering every entry id", () => {
    const item = {
      id: "00000000-0000-0000-0000-00000000f00d",
      type: "order",
      choices: [],
      correct_choice_ids: [],
      correct_answer: null,
      config: {
        sequence: [
          { id: "s1", label: "L1" },
          { id: "s2", label: "L2" },
          { id: "s3", label: "L3" },
        ],
      },
    } as unknown as Parameters<typeof buildResponseFor>[0];
    for (let i = 0; i < 20; i++) {
      const response = buildResponseFor(item);
      expect(() => ItemResponseSchema.parse(response)).not.toThrow();
      if (response.type === "order") {
        expect(response.ordered_ids.slice().sort()).toEqual(["s1", "s2", "s3"]);
      }
    }
  });
});

// Slice 49: seeded hotspot responses are schema-valid for both outcomes.
describe("buildResponseFor — hotspot (slice 49)", () => {
  test("produces schema-valid selections drawn from the item's regions", () => {
    const item = {
      id: "00000000-0000-0000-0000-00000000beef",
      type: "hotspot",
      choices: [],
      correct_choice_ids: [],
      correct_answer: null,
      config: {
        image_asset_id: "66666666-6666-6666-6666-666666666666",
        regions: [
          { id: "r1", x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
          { id: "r2", x: 0.5, y: 0.5, w: 0.2, h: 0.2 },
        ],
        correct_region_ids: ["r1"],
      },
    } as unknown as Parameters<typeof buildResponseFor>[0];
    const regionIds = new Set(["r1", "r2"]);
    for (let i = 0; i < 20; i++) {
      const response = buildResponseFor(item);
      expect(() => ItemResponseSchema.parse(response)).not.toThrow();
      if (response.type === "hotspot") {
        expect(response.region_ids.length).toBeGreaterThan(0);
        for (const id of response.region_ids) {
          expect(regionIds.has(id)).toBe(true);
        }
      }
    }
  });
});

// Slice 50: drawing_upload has no response format — seeding must skip it.
describe("seedAttempts skips drawing_upload (slice 50)", () => {
  test("buildResponseFor throws for drawing_upload", () => {
    const item = {
      id: "00000000-0000-0000-0000-00000000d0d0",
      type: "drawing_upload",
      choices: [],
      correct_choice_ids: [],
      correct_answer: null,
      config: {},
    } as unknown as Parameters<typeof buildResponseFor>[0];
    expect(() => buildResponseFor(item)).toThrow(/no response format/);
  });

  test("seeding an assessment with a drawing item responds to the others only", async () => {
    const db = getDb();
    const assessment = one(
      await db
        .insert(assessments)
        .values({ owner_sub: OWNER, name: "Slice 50 fixture" })
        .returning(),
    );
    const rows = await db
      .insert(items)
      .values([
        {
          assessment_id: assessment.id,
          position: 0,
          type: "short_text",
          stem: "Capital?",
          choices: [],
          correct_choice_ids: [],
          correct_answer: "Olympia",
        },
        {
          assessment_id: assessment.id,
          position: 1,
          type: "drawing_upload",
          stem: "Draw it",
          choices: [],
          correct_choice_ids: [],
        },
      ])
      .returning();
    expect(rows).toHaveLength(2);
    const result = await seedAttempts(db, { assessmentId: assessment.id, count: 2 });
    // 2 attempts × 1 respondable item — the drawing item produced nothing.
    expect(result.responseCount).toBe(2);
  });
});

// Review fix (2026-08-14): a drawing-only assessment reports the real
// condition, not the false "has no items".
describe("seedAttempts drawing-only message", () => {
  test("drawing-only assessment throws the authoring-only error", async () => {
    const db = getDb();
    const assessment = one(
      await db
        .insert(assessments)
        .values({ owner_sub: OWNER, name: "Drawing only" })
        .returning(),
    );
    await db.insert(items).values({
      assessment_id: assessment.id,
      position: 0,
      type: "drawing_upload",
      stem: "Draw it",
      choices: [],
      correct_choice_ids: [],
    });
    await expect(
      seedAttempts(db, { assessmentId: assessment.id, count: 1 }),
    ).rejects.toThrow(/authoring-only/);
  });
});

// Payload sizes (2026-10-25): the aggregates must be right, and the printed
// table must carry no id and no stored content — it lands in CloudWatch.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { closeDb, getDb } from "../db/client";
import { assessments, items } from "../db/schema";
import {
  PAYLOAD_CATEGORIES,
  formatPayloadSizes,
  measurePayloadSizes,
} from "../lib/observability/payloadSizes";

const expectTestDb = () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("secure_test_design_tool_test")) {
    throw new Error(`payload-sizes tests require the test DB; got: ${url}`);
  }
};

const SHORT_STEM = "Pick one of these";
const LONG_STEM = "Q".repeat(6000);

beforeAll(() => {
  expectTestDb();
});

afterEach(async () => {
  await getDb().execute(sql`truncate table assessments restart identity cascade`);
});

afterAll(async () => {
  await closeDb();
});

async function seedTwoItems(): Promise<{ assessmentId: string; itemIds: string[] }> {
  const [a] = await getDb()
    .insert(assessments)
    .values({ owner_sub: "payload-sizes-owner", owner_email: "owner@example.test", name: "Sizes" })
    .returning();
  const rows = await getDb()
    .insert(items)
    .values(
      [SHORT_STEM, LONG_STEM].map((stem, position) => ({
        assessment_id: a!.id,
        position,
        type: "multiple_choice_single" as const,
        stem,
        choices: [
          { id: "a", text: "A" },
          { id: "b", text: "B" },
        ],
        correct_choice_ids: ["a"],
      })),
    )
    .returning();
  return { assessmentId: a!.id, itemIds: rows.map((r) => r.id) };
}

describe("measurePayloadSizes", () => {
  test("one row per category, in order; an empty category has no sizes", async () => {
    const rows = await measurePayloadSizes(getDb());
    expect(rows.map((r) => r.category)).toEqual(PAYLOAD_CATEGORIES.map((c) => c.category));
    const responsesRow = rows.find((r) => r.category.startsWith("responses"))!;
    expect(responsesRow).toEqual({ category: responsesRow.category, rows: 0, p50: null, p99: null, max: null });
  });

  test("item sizes are the JSON text of the whole row: count, max and p50 match the rows", async () => {
    await seedTwoItems();
    const [expected] = (await getDb().execute(sql`
      select max(octet_length(row_to_json(t)::text)) as max,
             min(octet_length(row_to_json(t)::text)) as min
      from items t
    `)) as unknown as Array<{ max: number; min: number }>;

    const itemsRow = (await measurePayloadSizes(getDb())).find((r) => r.category.startsWith("items"))!;
    expect(itemsRow.rows).toBe(2);
    expect(itemsRow.max).toBe(Number(expected!.max));
    // The long stem alone is 6000 bytes, so the row is bigger than that.
    expect(itemsRow.max!).toBeGreaterThan(LONG_STEM.length);
    // Two rows: p50 is their midpoint, between the smaller and the larger.
    expect(itemsRow.p50!).toBeGreaterThan(Number(expected!.min));
    expect(itemsRow.p50!).toBeLessThan(itemsRow.max!);
    expect(itemsRow.p99!).toBeLessThanOrEqual(itemsRow.max!);
  });
});

describe("formatPayloadSizes", () => {
  test("prints sizes and counts only: no id and no stored content", async () => {
    const { assessmentId, itemIds } = await seedTwoItems();
    const out = formatPayloadSizes(await measurePayloadSizes(getDb()));
    expect(out).toContain("items (item create/edit)");
    expect(out).toContain("KiB");
    for (const id of [assessmentId, ...itemIds]) expect(out).not.toContain(id);
    expect(out).not.toContain(SHORT_STEM);
    expect(out).not.toContain("QQQQ");
    expect(out).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
  });
});

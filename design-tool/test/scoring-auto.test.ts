// Slice 37: pure auto-scoring engine + the score-attempt route + the
// one-final-per-response invariant. DB parts use the items-api harness.
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { closeDb, getDb } from "../db/client";
import {
  assessments,
  attempts,
  items,
  responses,
  scores,
  students,
  type ItemRow,
} from "../db/schema";
import { SESSION_COOKIE_NAME } from "../lib/auth/session";
import * as sessionMod from "../lib/auth/session";
import { normalizeShortText, scoreResponse } from "../lib/scoring/auto";

const expectTestDb = () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("secure_test_design_tool_test")) {
    throw new Error(`scoring-auto tests require the test DB DATABASE_URL; got: ${url}`);
  }
};

let originalSessionSecret: string | undefined;
let mockSub: string | null = null;

mock.module("next/headers", () => ({
  // Slice 58: requireSession now reads an Authorization bearer header as
  // well as the cookie, so the mocked module has to provide headers().
  headers: async () => new Headers(),
  cookies: async () => ({
    get: (name: string) => (mockSub && name === SESSION_COOKIE_NAME ? { value: "x" } : undefined),
  }),
}));

mock.module("../lib/auth/session", () => ({
  ...sessionMod,
  readSessionFromCookies: async () =>
    mockSub ? { sub: mockSub, role: "staff" } : null,
}));

beforeAll(() => {
  expectTestDb();
  originalSessionSecret = process.env.DESIGN_TOOL_SESSION_SECRET;
  process.env.DESIGN_TOOL_SESSION_SECRET = "test-session-secret-do-not-use";
  mockSub = "scoring-auto-teacher";
});

afterEach(async () => {
  mockSub = "scoring-auto-teacher";
  const db = getDb();
  await db.execute(sql`truncate table assessments restart identity cascade`);
  await db.execute(sql`truncate table students restart identity cascade`);
});

afterAll(async () => {
  await closeDb();
  if (originalSessionSecret === undefined) {
    delete process.env.DESIGN_TOOL_SESSION_SECRET;
  } else {
    process.env.DESIGN_TOOL_SESSION_SECRET = originalSessionSecret;
  }
});

// Minimal ItemRow stand-in for the pure-function tests.
function fakeItem(partial: Partial<ItemRow> & { type: string }): ItemRow {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    assessment_id: "00000000-0000-0000-0000-000000000002",
    position: 0,
    stem: "stem",
    choices: [],
    correct_choice_ids: [],
    correct_answer: null,
    config: {},
    created_at: new Date(),
    updated_at: new Date(),
    ...partial,
  } as ItemRow;
}

describe("scoreResponse (pure)", () => {
  test.each([
    // [label, item, response, expected points | null]
    [
      "MC single correct",
      fakeItem({ type: "multiple_choice_single", correct_choice_ids: ["a"] }),
      { type: "multiple_choice_single", choice_id: "a" },
      1,
    ],
    [
      "MC single wrong",
      fakeItem({ type: "multiple_choice_single", correct_choice_ids: ["a"] }),
      { type: "multiple_choice_single", choice_id: "b" },
      0,
    ],
    [
      "MC single without key → unscorable",
      fakeItem({ type: "multiple_choice_single", correct_choice_ids: [] }),
      { type: "multiple_choice_single", choice_id: "a" },
      null,
    ],
    [
      "MC multi exact set (order-independent)",
      fakeItem({ type: "multiple_choice_multi", correct_choice_ids: ["a", "b"] }),
      { type: "multiple_choice_multi", choice_ids: ["b", "a"] },
      1,
    ],
    [
      "MC multi subset → all-or-nothing 0",
      fakeItem({ type: "multiple_choice_multi", correct_choice_ids: ["a", "b"] }),
      { type: "multiple_choice_multi", choice_ids: ["a"] },
      0,
    ],
    [
      "MC multi superset → 0",
      fakeItem({ type: "multiple_choice_multi", correct_choice_ids: ["a", "b"] }),
      { type: "multiple_choice_multi", choice_ids: ["a", "b", "c"] },
      0,
    ],
    [
      "short_text exact",
      fakeItem({ type: "short_text", correct_answer: "mitochondria" }),
      { type: "short_text", text: "mitochondria" },
      1,
    ],
    [
      "short_text case + whitespace folded",
      fakeItem({ type: "short_text", correct_answer: "Mitochondria" }),
      { type: "short_text", text: "  MITOCHONDRIA \n" },
      1,
    ],
    [
      "short_text internal whitespace collapsed",
      fakeItem({ type: "short_text", correct_answer: "cell wall" }),
      { type: "short_text", text: "cell   wall" },
      1,
    ],
    [
      "short_text wrong",
      fakeItem({ type: "short_text", correct_answer: "cell wall" }),
      { type: "short_text", text: "cellwall" },
      0,
    ],
    // E7(b): formula-aware folding, only when the text carries formula markup.
    [
      "short_text E7(b): typed subscript matches a plain key",
      fakeItem({ type: "short_text", correct_answer: "H2O" }),
      { type: "short_text", text: "H_2O" },
      1,
    ],
    [
      "short_text E7(b): pasted KaTeX matches a plain key",
      fakeItem({ type: "short_text", correct_answer: "K2Cr2O7" }),
      { type: "short_text", text: "$\\mathrm{K_2Cr_2O_7}$" },
      1,
    ],
    [
      "short_text E7(b): braces and spacing fold, exponent kept",
      fakeItem({ type: "short_text", correct_answer: "3.5 x 10^4" }),
      { type: "short_text", text: "3.5x10^{4}" },
      1,
    ],
    [
      "short_text E7(b): an exponent is not a digit — 10^4 ≠ 104",
      fakeItem({ type: "short_text", correct_answer: "10^4" }),
      { type: "short_text", text: "104" },
      0,
    ],
    [
      "short_text E7(b): a KaTeX key matches a typed answer the same way",
      fakeItem({ type: "short_text", correct_answer: "$x^2$" }),
      { type: "short_text", text: "x^2" },
      1,
    ],
    // "Plain or folded" (James, 2026-09-02): a stray underscore in a prose
    // answer can only add a match — the plain comparison is tried first.
    [
      "short_text E7(b): prose with a stray underscore still matches its key",
      fakeItem({ type: "short_text", correct_answer: "cell wall" }),
      { type: "short_text", text: "cell _wall_" },
      1,
    ],
    [
      "short_text E7(b): markup on the key side alone also folds",
      fakeItem({ type: "short_text", correct_answer: "$\\mathrm{CO_2}$" }),
      { type: "short_text", text: "co2" },
      1,
    ],
    [
      "short_text E7(b): no markup on either side stays plain — cellwall is still wrong",
      fakeItem({ type: "short_text", correct_answer: "cell wall" }),
      { type: "short_text", text: "cellwall" },
      0,
    ],
    [
      "short_text without key → unscorable",
      fakeItem({ type: "short_text", correct_answer: null }),
      { type: "short_text", text: "anything" },
      null,
    ],
    [
      "essay → unscorable",
      fakeItem({ type: "essay" }),
      { type: "essay", text: "long response" },
      null,
    ],
    // Slice 47: match — exact mapping, all-or-nothing (same policy as MC multi).
    [
      "match fully correct",
      fakeItem({
        type: "match",
        config: {
          pairs: [
            { id: "p1", left: "L1", right: "R1" },
            { id: "p2", left: "L2", right: "R2" },
          ],
        },
      }),
      { type: "match", matches: { p1: "p1", p2: "p2" } },
      1,
    ],
    [
      "match one swap → all-or-nothing 0",
      fakeItem({
        type: "match",
        config: {
          pairs: [
            { id: "p1", left: "L1", right: "R1" },
            { id: "p2", left: "L2", right: "R2" },
          ],
        },
      }),
      { type: "match", matches: { p1: "p2", p2: "p1" } },
      0,
    ],
    [
      "match missing a mapping → 0",
      fakeItem({
        type: "match",
        config: {
          pairs: [
            { id: "p1", left: "L1", right: "R1" },
            { id: "p2", left: "L2", right: "R2" },
          ],
        },
      }),
      { type: "match", matches: { p1: "p1" } },
      0,
    ],
    [
      "match extra unknown key → 0",
      fakeItem({
        type: "match",
        config: {
          pairs: [
            { id: "p1", left: "L1", right: "R1" },
            { id: "p2", left: "L2", right: "R2" },
          ],
        },
      }),
      { type: "match", matches: { p1: "p1", p2: "p2", p9: "p9" } },
      0,
    ],
    [
      "match without pairs (no key) → unscorable",
      fakeItem({ type: "match", config: {} }),
      { type: "match", matches: { p1: "p1" } },
      null,
    ],
    // Slice 48: order — exact sequence, all-or-nothing.
    [
      "order fully correct",
      fakeItem({
        type: "order",
        config: {
          sequence: [
            { id: "s1", label: "First" },
            { id: "s2", label: "Second" },
            { id: "s3", label: "Third" },
          ],
        },
      }),
      { type: "order", ordered_ids: ["s1", "s2", "s3"] },
      1,
    ],
    [
      "order wrong arrangement → 0",
      fakeItem({
        type: "order",
        config: {
          sequence: [
            { id: "s1", label: "First" },
            { id: "s2", label: "Second" },
            { id: "s3", label: "Third" },
          ],
        },
      }),
      { type: "order", ordered_ids: ["s2", "s1", "s3"] },
      0,
    ],
    [
      "order missing an entry → 0",
      fakeItem({
        type: "order",
        config: {
          sequence: [
            { id: "s1", label: "First" },
            { id: "s2", label: "Second" },
          ],
        },
      }),
      { type: "order", ordered_ids: ["s1"] },
      0,
    ],
    [
      "order extra unknown id → 0",
      fakeItem({
        type: "order",
        config: {
          sequence: [
            { id: "s1", label: "First" },
            { id: "s2", label: "Second" },
          ],
        },
      }),
      { type: "order", ordered_ids: ["s1", "s2", "s9"] },
      0,
    ],
    [
      "order without sequence (no key) → unscorable",
      fakeItem({ type: "order", config: {} }),
      { type: "order", ordered_ids: ["s1"] },
      null,
    ],
    [
      "response/item type mismatch → unscorable",
      fakeItem({ type: "multiple_choice_single", correct_choice_ids: ["a"] }),
      { type: "short_text", text: "a" },
      null,
    ],
  ] as const)("%s", (_label, item, response, expected) => {
    const result = scoreResponse(item, response as never);
    if (expected === null) {
      expect(result).toBeNull();
    } else {
      expect(result).toEqual({ points: expected, max_points: 1 });
    }
  });

  test("normalizeShortText folds trim/case/internal whitespace", () => {
    expect(normalizeShortText("  Cell   Wall \t")).toBe("cell wall");
  });
});

const OWNER = "scoring-auto-teacher";

async function seedScoredScenario() {
  const db = getDb();
  const [assessment] = await db
    .insert(assessments)
    .values({ owner_sub: OWNER, name: "Score me" })
    .returning();
  const a = assessment!;
  const itemRows = await db
    .insert(items)
    .values([
      {
        assessment_id: a.id,
        position: 0,
        type: "multiple_choice_single",
        stem: "Q1",
        choices: [
          { id: "a", text: "A" },
          { id: "b", text: "B" },
        ],
        correct_choice_ids: ["a"],
      },
      {
        assessment_id: a.id,
        position: 1,
        type: "short_text",
        stem: "Q2",
        correct_answer: "Photosynthesis",
      },
      // human-picked scoring method — the route must not touch it
      {
        assessment_id: a.id,
        position: 2,
        type: "short_text",
        stem: "Q3",
        correct_answer: "x",
        config: { scoring_method: "human" },
      },
      // essay defaults to human — untouched too
      { assessment_id: a.id, position: 3, type: "essay", stem: "Q4" },
    ])
    .returning();
  const [student] = await db
    .insert(students)
    .values({ owner_sub: OWNER, ssid: "555", name: "S" })
    .returning();
  const [attempt] = await db
    .insert(attempts)
    .values({
      assessment_id: a.id,
      student_id: student!.id,
      status: "submitted",
      submitted_at: new Date(),
    })
    .returning();
  const at = attempt!;
  await db.insert(responses).values([
    {
      attempt_id: at.id,
      item_id: itemRows[0]!.id,
      response: { type: "multiple_choice_single", choice_id: "a" }, // correct
    },
    {
      attempt_id: at.id,
      item_id: itemRows[1]!.id,
      response: { type: "short_text", text: "photosynthesis  " }, // correct after fold
    },
    {
      attempt_id: at.id,
      item_id: itemRows[2]!.id,
      response: { type: "short_text", text: "x" }, // human-method: skipped
    },
    {
      attempt_id: at.id,
      item_id: itemRows[3]!.id,
      response: { type: "essay", text: "an essay" }, // not auto: skipped
    },
  ]);
  return { db, assessment: a, attempt: at };
}

async function postScore(attemptId: string) {
  const { POST } = await import("../app/api/attempts/[attemptId]/score/route");
  return POST(new Request(`http://localhost/api/attempts/${attemptId}/score`, { method: "POST" }), {
    params: Promise.resolve({ attemptId }),
  });
}

describe("POST /api/attempts/:id/score", () => {
  test("scores auto items final, skips human/essay, is idempotent", async () => {
    const { db, attempt } = await seedScoredScenario();
    const res = await postScore(attempt.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.scored).toBe(2);
    expect(body.skipped_not_auto).toBe(2);
    expect(body.already_scored).toBe(0);
    expect(body.skipped_unscorable).toBe(0);

    const allScores = await db.select().from(scores);
    expect(allScores).toHaveLength(2);
    for (const s of allScores) {
      expect(s.method).toBe("auto");
      expect(s.status).toBe("final");
      expect(s.scorer).toBe("auto");
      expect(s.points).toBe(1);
      expect(s.max_points).toBe(1);
    }

    // Idempotent re-run: nothing new, everything reported already scored.
    const res2 = await postScore(attempt.id);
    const body2 = (await res2.json()) as Record<string, unknown>;
    expect(body2.scored).toBe(0);
    expect(body2.already_scored).toBe(2);
    expect(await db.select().from(scores)).toHaveLength(2);
  });

  test("403 for another teacher's attempt", async () => {
    const { attempt } = await seedScoredScenario();
    mockSub = "someone-else";
    const res = await postScore(attempt.id);
    expect(res.status).toBe(403);
  });

  test("400 for an in-progress attempt", async () => {
    const { db, assessment } = await seedScoredScenario();
    const [student] = await db
      .insert(students)
      .values({ owner_sub: OWNER, ssid: "556", name: "S2" })
      .returning();
    const [inProgress] = await db
      .insert(attempts)
      .values({ assessment_id: assessment.id, student_id: student!.id })
      .returning();
    const res = await postScore(inProgress!.id);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      "attempt_not_submitted",
    );
  });

  test("404 for an unknown attempt", async () => {
    const res = await postScore("00000000-0000-0000-0000-00000000dead");
    expect(res.status).toBe(404);
  });
});

describe("scores table invariants", () => {
  test("second final for the same response is rejected; proposed coexists", async () => {
    const { db, attempt } = await seedScoredScenario();
    await postScore(attempt.id);
    const [scoreRow] = await db.select().from(scores).limit(1);
    const responseId = scoreRow!.response_id;

    const dupFinal = Promise.resolve().then(() =>
      db.insert(scores).values({
        response_id: responseId,
        method: "human",
        points: 0,
        max_points: 1,
        scorer: "teacher-1",
        status: "final",
      }),
    );
    await expect(dupFinal).rejects.toThrow();

    // A proposed row alongside the final is fine (AI drafts, slice 38).
    await db.insert(scores).values({
      response_id: responseId,
      method: "ai",
      points: 1,
      max_points: 1,
      scorer: "model-x",
      status: "proposed",
    });
    const rows = await db
      .select()
      .from(scores)
      .where(eq(scores.response_id, responseId));
    expect(rows).toHaveLength(2);
  });

  test("points CHECK rejects points > max_points", async () => {
    const { db, attempt } = await seedScoredScenario();
    await postScore(attempt.id);
    const [scoreRow] = await db.select().from(scores).limit(1);
    const bad = Promise.resolve().then(() =>
      db.insert(scores).values({
        response_id: scoreRow!.response_id,
        method: "human",
        points: 5,
        max_points: 1,
        scorer: "teacher-1",
        status: "proposed",
      }),
    );
    await expect(bad).rejects.toThrow();
  });
});

// Slice 49: hotspot — exact region set, all-or-nothing; drafts unscorable.
describe("scoreResponse — hotspot (slice 49)", () => {
  const configured = fakeItem({
    type: "hotspot",
    config: {
      image_asset_id: "77777777-7777-7777-7777-777777777777",
      regions: [
        { id: "r1", x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
        { id: "r2", x: 0.5, y: 0.5, w: 0.2, h: 0.2 },
      ],
      correct_region_ids: ["r1", "r2"],
    },
  });

  test("exact set (order-independent) → 1", () => {
    expect(
      scoreResponse(configured, { type: "hotspot", region_ids: ["r2", "r1"] }),
    ).toEqual({ points: 1, max_points: 1 });
  });

  test("subset → 0; extra region → 0", () => {
    expect(
      scoreResponse(configured, { type: "hotspot", region_ids: ["r1"] }),
    ).toEqual({ points: 0, max_points: 1 });
    expect(
      scoreResponse(configured, {
        type: "hotspot",
        region_ids: ["r1", "r2", "r9"],
      }),
    ).toEqual({ points: 0, max_points: 1 });
  });

  test("draft hotspot (no key) → unscorable null", () => {
    expect(
      scoreResponse(fakeItem({ type: "hotspot", config: {} }), {
        type: "hotspot",
        region_ids: ["r1"],
      }),
    ).toBeNull();
  });
});

// Review fixes (2026-08-14), group A: data-integrity guards.
describe("review fixes — data integrity (group A)", () => {
  test("item DELETE is blocked once responses exist (has_responses 409)", async () => {
    const { db, assessment } = await seedScoredScenario();
    const [firstItem] = await db
      .select()
      .from(items)
      .where(eq(items.assessment_id, assessment.id))
      .limit(1);
    const { DELETE } = await import(
      "../app/api/assessments/[id]/items/[itemId]/route"
    );
    const res = await DELETE(
      new Request(
        `http://localhost/api/assessments/${assessment.id}/items/${firstItem!.id}`,
        { method: "DELETE" },
      ),
      {
        params: Promise.resolve({ id: assessment.id, itemId: firstItem!.id }),
      },
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("has_responses");
    // The responses are still there.
    const remaining = await db
      .select()
      .from(responses)
      .where(eq(responses.item_id, firstItem!.id));
    expect(remaining.length).toBeGreaterThan(0);
  });

  test("concurrent final inserts do not 500 (onConflictDoNothing)", async () => {
    const { db, attempt } = await seedScoredScenario();
    const [resp] = await db
      .select()
      .from(responses)
      .where(eq(responses.attempt_id, attempt.id))
      .limit(1);
    const row = {
      response_id: resp!.id,
      method: "human" as const,
      points: 1,
      max_points: 1,
      rationale: null,
      scorer: "t1",
      status: "final" as const,
    };
    const first = await db
      .insert(scores)
      .values(row)
      .onConflictDoNothing()
      .returning({ id: scores.id });
    expect(first).toHaveLength(1);
    // The losing racer: same response, second final — swallowed, not thrown.
    const second = await db
      .insert(scores)
      .values({ ...row, scorer: "t2" })
      .onConflictDoNothing()
      .returning({ id: scores.id });
    expect(second).toHaveLength(0);
  });
});

// E3 slice 1: table auto-scoring — one point per keyed cell (D-2), numbers
// compared as numbers when both sides are plain decimals (D-3).
describe("scoreResponse: table (E3)", () => {
  const keyed = fakeItem({
    type: "table",
    config: {
      columns: [{ id: "c1", label: "Observed" }, { id: "c2", label: "Expected" }],
      rows: [{ id: "r1", label: "Middle" }, { id: "r2", label: "Total" }],
      cell_keys: { r1: { c1: "12", c2: "1.5" }, r2: { c1: "H2O" } },
    },
  });

  test("every keyed cell right → full marks, max = keyed cells (unkeyed cells never count)", () => {
    const r = scoreResponse(keyed, {
      type: "table",
      cells: { r1: { c1: "12", c2: "1.5" }, r2: { c1: "H2O", c2: "anything" } },
    });
    expect(r).toEqual({ points: 3, max_points: 3 });
  });

  test("a wrong cell and a missing cell each cost one point", () => {
    const r = scoreResponse(keyed, {
      type: "table",
      cells: { r1: { c1: "13" }, r2: { c1: "H2O" } },
    });
    expect(r).toEqual({ points: 1, max_points: 3 });
  });

  test("D-3: 1.50 and +12.0 match numeric keys; 10^4 does not become 104", () => {
    const r = scoreResponse(keyed, {
      type: "table",
      cells: { r1: { c1: "+12.0", c2: " 1.50 " }, r2: { c1: "h_2o" } },
    });
    expect(r).toEqual({ points: 3, max_points: 3 });
    const exp = fakeItem({
      type: "table",
      config: { columns: [{ id: "c1", label: "x" }], rows: [{ id: "r1", label: "" }], cell_keys: { r1: { c1: "10^4" } } },
    });
    expect(scoreResponse(exp, { type: "table", cells: { r1: { c1: "104" } } })).toEqual({ points: 0, max_points: 1 });
    expect(scoreResponse(exp, { type: "table", cells: { r1: { c1: "10^{4}" } } })).toEqual({ points: 1, max_points: 1 });
  });

  test("no keys → unscorable (null), not zero", () => {
    const draft = fakeItem({
      type: "table",
      config: { columns: [{ id: "c1", label: "x" }], rows: [{ id: "r1", label: "" }] },
    });
    expect(scoreResponse(draft, { type: "table", cells: { r1: { c1: "1" } } })).toBeNull();
  });

  test("a response of another type is defensive-null", () => {
    expect(scoreResponse(keyed, { type: "short_text", text: "12" })).toBeNull();
  });
});

// E3 slice 2: the denominator every score path shares for a table.
describe("tableMaxPoints (E3)", () => {
  test("keyed cells when there are any, else every body cell, else 0", async () => {
    const { tableMaxPoints } = await import("../lib/scoring/auto");
    const grid = { columns: [{ id: "c1", label: "A" }, { id: "c2", label: "B" }], rows: [{ id: "r1", label: "" }, { id: "r2", label: "" }, { id: "r3", label: "" }] };
    expect(tableMaxPoints({ ...grid, cell_keys: { r1: { c1: "1", c2: "2" }, r3: { c2: "3" } } })).toBe(3);
    expect(tableMaxPoints(grid)).toBe(6);
    expect(tableMaxPoints({})).toBe(0);
    expect(tableMaxPoints(null)).toBe(0);
  });
});

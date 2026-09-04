// Slice 39: review queue + manual score + approve + re-run AI. Covers the
// state transitions, append-only retention, reviewed_by stamping, and
// queue membership rules. Same harness as the other API tests.
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import type { Rubric } from "@secure-test/schema";
import { closeDb, getDb } from "../db/client";
import {
  assessments,
  attempts,
  items,
  responses,
  scores,
  students, item_sets } from "../db/schema";
import { SESSION_COOKIE_NAME } from "../lib/auth/session";
import * as sessionMod from "../lib/auth/session";

const expectTestDb = () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("secure_test_design_tool_test")) {
    throw new Error(`review-queue tests require the test DB DATABASE_URL; got: ${url}`);
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

const OWNER = "review-queue-teacher";

beforeAll(() => {
  expectTestDb();
  originalSessionSecret = process.env.DESIGN_TOOL_SESSION_SECRET;
  process.env.DESIGN_TOOL_SESSION_SECRET = "test-session-secret-do-not-use";
  mockSub = OWNER;
});

afterEach(async () => {
  mockSub = OWNER;
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

// Seed: auto MC (final-scored), human essay w/ rubric, ai essay w/ rubric,
// human-picked short_text — one submitted attempt answering all four.
async function seedQueueScenario() {
  const db = getDb();
  const [assessment] = await db
    .insert(assessments)
    .values({ owner_sub: OWNER, name: "Queue" })
    .returning();
  const a = assessment!;
  const itemRows = await db
    .insert(items)
    .values([
      {
        assessment_id: a.id,
        position: 0,
        type: "multiple_choice_single",
        stem: "MC",
        choices: [
          { id: "a", text: "A" },
          { id: "b", text: "B" },
        ],
        correct_choice_ids: ["a"],
      },
      {
        assessment_id: a.id,
        position: 1,
        type: "essay",
        stem: "Human essay",
        config: { rubric: RUBRIC }, // human is the essay default
      },
      {
        assessment_id: a.id,
        position: 2,
        type: "essay",
        stem: "AI essay",
        config: { rubric: RUBRIC, scoring_method: "ai" },
      },
      {
        assessment_id: a.id,
        position: 3,
        type: "short_text",
        stem: "Short human",
        correct_answer: "x",
        config: { scoring_method: "human" },
      },
    ])
    .returning();
  const [student] = await db
    .insert(students)
    .values({ owner_sub: OWNER, ssid: "888", name: "Queue Student" })
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
  const responseRows = await db
    .insert(responses)
    .values([
      {
        attempt_id: at.id,
        item_id: itemRows[0]!.id,
        response: { type: "multiple_choice_single", choice_id: "a" },
      },
      {
        attempt_id: at.id,
        item_id: itemRows[1]!.id,
        response: { type: "essay", text: "Human-scored essay text." },
      },
      {
        attempt_id: at.id,
        item_id: itemRows[2]!.id,
        response: { type: "essay", text: "AI-scored essay text." },
      },
      {
        attempt_id: at.id,
        item_id: itemRows[3]!.id,
        response: { type: "short_text", text: "y" },
      },
    ])
    .returning();
  return { db, assessment: a, attempt: at, itemRows, responseRows };
}

async function getQueue(assessmentId: string) {
  const { GET } = await import("../app/api/assessments/[id]/review-queue/route");
  const res = await GET(
    new Request(`http://localhost/api/assessments/${assessmentId}/review-queue`),
    { params: Promise.resolve({ id: assessmentId }) },
  );
  return res;
}

async function postAutoScore(attemptId: string) {
  const { POST } = await import("../app/api/attempts/[attemptId]/score/route");
  return POST(new Request("http://localhost/x", { method: "POST" }), {
    params: Promise.resolve({ attemptId }),
  });
}

async function postAiScore(attemptId: string) {
  const { POST } = await import("../app/api/attempts/[attemptId]/score-ai/route");
  return POST(new Request("http://localhost/x", { method: "POST" }), {
    params: Promise.resolve({ attemptId }),
  });
}

async function postManualScore(responseId: string, body: unknown) {
  const { POST } = await import("../app/api/responses/[responseId]/score/route");
  return POST(
    new Request(`http://localhost/api/responses/${responseId}/score`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ responseId }) },
  );
}

async function postApprove(scoreId: string) {
  const { POST } = await import("../app/api/scores/[scoreId]/approve/route");
  return POST(new Request("http://localhost/x", { method: "POST" }), {
    params: Promise.resolve({ scoreId }),
  });
}

async function postRescoreAi(responseId: string) {
  const { POST } = await import(
    "../app/api/responses/[responseId]/rescore-ai/route"
  );
  return POST(new Request("http://localhost/x", { method: "POST" }), {
    params: Promise.resolve({ responseId }),
  });
}

type QueueBody = {
  entries: Array<{
    response_id: string;
    item: { stem: string; stem_html: string; scoring_method: string };
    proposed: { score_id: string; points: number } | null;
  }>;
};

describe("GET review-queue", () => {
  test("auto items excluded; human/ai items appear; finals drop out", async () => {
    const { attempt } = await seedQueueScenario();
    // Score the auto MC final + propose the AI essay.
    expect((await postAutoScore(attempt.id)).status).toBe(200);
    expect((await postAiScore(attempt.id)).status).toBe(200);

    const res = await getQueue((await seededAssessmentId()) ?? "");
    expect(res.status).toBe(200);
    const body = (await res.json()) as QueueBody;
    // MC is auto (excluded). Human essay + short_text need manual; AI essay proposed.
    expect(body.entries).toHaveLength(3);
    const stems = body.entries.map((e) => e.item.stem).sort();
    expect(stems).toEqual(["AI essay", "Human essay", "Short human"]);
    const aiEntry = body.entries.find((e) => e.item.stem === "AI essay")!;
    expect(aiEntry.proposed).not.toBeNull();
    expect(
      body.entries.filter((e) => e.proposed === null).map((e) => e.item.stem).sort(),
    ).toEqual(["Human essay", "Short human"]);
  });

  // E12 slice 4: a question under a source-backed stimulus says what the
  // student saw — their outline written in place here, or nothing.
  test("entries under a source-backed stimulus carry the outline indicator", async () => {
    const { db, assessment, attempt, itemRows } = await seedQueueScenario();
    const [outline] = await db.insert(assessments).values({ owner_sub: OWNER, name: "Outline" }).returning();
    const [outlineQ] = await db
      .insert(items)
      .values({ assessment_id: outline!.id, position: 0, type: "essay", stem: "Outline your argument" })
      .returning();
    const [set] = await db
      .insert(item_sets)
      .values({ assessment_id: assessment.id, stimulus_text: "Your outline:", source_item_id: outlineQ!.id })
      .returning();
    await db.update(items).set({ item_set_id: set!.id }).where(eq(items.id, itemRows[1]!.id));

    let body = (await (await getQueue(assessment.id)).json()) as { entries: { item: { id: string }; outline: { origin: string; words: number } | null }[] };
    const human = () => body.entries.find((e) => e.item.id === itemRows[1]!.id)!;
    expect(human().outline).toEqual({ origin: "missing", words: 0 });
    expect(body.entries.find((e) => e.item.id === itemRows[2]!.id)!.outline).toBeNull();

    await db.insert(responses).values({ attempt_id: attempt.id, item_id: outlineQ!.id, response: { type: "essay", text: "one two three four" } });
    body = (await (await getQueue(assessment.id)).json()) as typeof body;
    expect(human().outline).toEqual({ origin: "inline", words: 4 });
  });

  test("403 for another teacher", async () => {
    await seedQueueScenario();
    mockSub = "someone-else";
    const res = await getQueue((await seededAssessmentId()) ?? "");
    expect(res.status).toBe(403);
  });

  test("stem_html renders math; plain stems are escaped text", async () => {
    const { db, assessment, attempt } = await seedQueueScenario();
    const [mathItem] = await db
      .insert(items)
      .values({
        assessment_id: assessment.id,
        position: 4,
        type: "short_text",
        stem: "What is $\\frac{1}{2} + \\frac{1}{4}$?",
        correct_answer: "3/4",
        config: { scoring_method: "human" },
      })
      .returning();
    await db.insert(responses).values({
      attempt_id: attempt.id,
      item_id: mathItem!.id,
      response: { type: "short_text", text: "3/4" },
    });

    const res = await getQueue(assessment.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as QueueBody;
    const mathEntry = body.entries.find((e) => e.item.stem.startsWith("What is"))!;
    expect(mathEntry.item.stem_html).toContain("katex");
    expect(mathEntry.item.stem_html).not.toContain("$");
    const plainEntry = body.entries.find((e) => e.item.stem === "Human essay")!;
    expect(plainEntry.item.stem_html).toBe("Human essay");
  });
});

async function seededAssessmentId(): Promise<string | undefined> {
  const db = getDb();
  const [row] = await db.select().from(assessments).limit(1);
  return row?.id;
}

describe("manual scoring + approve + re-run", () => {
  test("rubric manual score writes human final; queue shrinks", async () => {
    const { db, responseRows } = await seedQueueScenario();
    const humanEssay = responseRows[1]!;
    const res = await postManualScore(humanEssay.id, {
      points: 5,
      max_points: 5,
      criterion_scores: [
        { criterion_id: "ideas", level_id: "i3", points: 3 },
        { criterion_id: "org", level_id: "o2", points: 2 },
      ],
      note: "strong work",
    });
    expect(res.status).toBe(201);
    const rows = await db
      .select()
      .from(scores)
      .where(eq(scores.response_id, humanEssay.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.method).toBe("human");
    expect(rows[0]!.status).toBe("final");
    expect(rows[0]!.scorer).toBe(OWNER);
    expect(rows[0]!.reviewed_by_sub).toBe(OWNER);

    const queue = (await (await getQueue((await seededAssessmentId())!)).json()) as QueueBody;
    expect(queue.entries.map((e) => e.item.stem)).not.toContain("Human essay");
  });

  test("rubric bounds rejected with 400; bare points accepted without rubric", async () => {
    const { responseRows } = await seedQueueScenario();
    const humanEssay = responseRows[1]!;
    const bad = await postManualScore(humanEssay.id, {
      points: 5,
      max_points: 5,
      criterion_scores: [
        { criterion_id: "ideas", level_id: "nope", points: 3 },
        { criterion_id: "org", level_id: "o2", points: 2 },
      ],
    });
    expect(bad.status).toBe(400);

    // short_text has no rubric: bare points work.
    const shortText = responseRows[3]!;
    const ok = await postManualScore(shortText.id, { points: 1, max_points: 1 });
    expect(ok.status).toBe(201);
  });

  test("second final 409s (override path is one final, audit retained)", async () => {
    const { responseRows } = await seedQueueScenario();
    const shortText = responseRows[3]!;
    expect((await postManualScore(shortText.id, { points: 1, max_points: 1 })).status).toBe(201);
    const again = await postManualScore(shortText.id, { points: 0, max_points: 1 });
    expect(again.status).toBe(409);
  });

  test("approve copies the proposal to a final; proposed retained; reviewed_by stamped", async () => {
    const { db, attempt, responseRows } = await seedQueueScenario();
    expect((await postAiScore(attempt.id)).status).toBe(200);
    const aiResponse = responseRows[2]!;
    const [proposal] = await db
      .select()
      .from(scores)
      .where(eq(scores.response_id, aiResponse.id));
    expect(proposal!.status).toBe("proposed");

    const res = await postApprove(proposal!.id);
    expect(res.status).toBe(201);

    const rows = await db
      .select()
      .from(scores)
      .where(eq(scores.response_id, aiResponse.id));
    expect(rows).toHaveLength(2); // proposed retained + new final
    const final = rows.find((r) => r.status === "final")!;
    expect(final.method).toBe("ai");
    expect(final.scorer).toBe("mock"); // model authorship preserved
    expect(final.reviewed_by_sub).toBe(OWNER); // human approval stamped
    expect(final.points).toBe(proposal!.points);

    // Approving again: the same proposal now has a final → 409.
    expect((await postApprove(proposal!.id)).status).toBe(409);
  });

  test("override an AI proposal: human final lands, proposal retained", async () => {
    const { db, attempt, responseRows } = await seedQueueScenario();
    expect((await postAiScore(attempt.id)).status).toBe(200);
    const aiResponse = responseRows[2]!;
    const res = await postManualScore(aiResponse.id, {
      points: 2,
      max_points: 5,
      criterion_scores: [
        { criterion_id: "ideas", level_id: "i1", points: 1 },
        { criterion_id: "org", level_id: "o1", points: 1 },
      ],
      note: "AI was too generous",
    });
    expect(res.status).toBe(201);
    const rows = await db
      .select()
      .from(scores)
      .where(eq(scores.response_id, aiResponse.id));
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.status).sort()).toEqual(["final", "proposed"]);
    const final = rows.find((r) => r.status === "final")!;
    expect(final.method).toBe("human");
    expect(final.points).toBe(2);
  });

  test("re-run AI adds a second proposal; refuses once a final exists", async () => {
    const { db, attempt, responseRows } = await seedQueueScenario();
    expect((await postAiScore(attempt.id)).status).toBe(200);
    const aiResponse = responseRows[2]!;

    const rerun = await postRescoreAi(aiResponse.id);
    expect(rerun.status).toBe(201);
    const rows = await db
      .select()
      .from(scores)
      .where(eq(scores.response_id, aiResponse.id));
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === "proposed")).toBe(true);

    // Finalize via approve of the latest, then re-run must 409.
    const approve = await postApprove(rows[1]!.id);
    expect(approve.status).toBe(201);
    expect((await postRescoreAi(aiResponse.id)).status).toBe(409);
  });

  test("re-run AI on a non-AI item 400s", async () => {
    const { responseRows } = await seedQueueScenario();
    const humanEssay = responseRows[1]!;
    const res = await postRescoreAi(humanEssay.id);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      "item_not_ai_scorable",
    );
  });

  test("cross-teacher actions are forbidden", async () => {
    const { attempt, responseRows } = await seedQueueScenario();
    expect((await postAiScore(attempt.id)).status).toBe(200);
    mockSub = "someone-else";
    expect(
      (await postManualScore(responseRows[1]!.id, { points: 1, max_points: 1 }))
        .status,
    ).toBe(403);
    expect((await postRescoreAi(responseRows[2]!.id)).status).toBe(403);
  });
});

// Review fix (2026-08-14, finding 4): max_points is not caller-chosen —
// rubric items require the rubric max, non-rubric items require 1.
describe("manual score max_points enforcement (review fix)", () => {
  test("non-rubric item rejects max_points != 1", async () => {
    const { responseRows } = await seedQueueScenario();
    const shortText = responseRows[3]!;
    const bad = await postManualScore(shortText.id, { points: 5, max_points: 5 });
    expect(bad.status).toBe(400);
    const body = (await bad.json()) as { error: string; expected: number };
    expect(body.error).toBe("max_points_mismatch");
    expect(body.expected).toBe(1);
    const ok = await postManualScore(shortText.id, { points: 1, max_points: 1 });
    expect(ok.status).toBe(201);
  });

  test("rubric item rejects bare points with the wrong max", async () => {
    const { responseRows } = await seedQueueScenario();
    const humanEssay = responseRows[1]!; // RUBRIC max = 3 + 2 = 5
    const bad = await postManualScore(humanEssay.id, { points: 3, max_points: 3 });
    expect(bad.status).toBe(400);
    const body = (await bad.json()) as { error: string; expected: number };
    expect(body.error).toBe("max_points_mismatch");
    expect(body.expected).toBe(5);
    const ok = await postManualScore(humanEssay.id, { points: 3, max_points: 5 });
    expect(ok.status).toBe(201);
  });
});

// E3 slice 2: a hand-scored table reaches the queue with its grid and keys,
// and the manual score is out of the table's cells — keyed cells when any,
// else every cell — the same denominator the auto path uses.
describe("review queue: table items (E3)", () => {
  async function seedTable(cellKeys: Record<string, Record<string, string>> | undefined) {
    const db = getDb();
    const [a] = await db.insert(assessments).values({ owner_sub: OWNER, name: "Tables" }).returning();
    const [item] = await db
      .insert(items)
      .values({
        assessment_id: a!.id,
        position: 0,
        type: "table",
        stem: "Chi-square",
        config: {
          columns: [{ id: "c1", label: "Observed" }, { id: "c2", label: "Expected" }],
          rows: [{ id: "r1", label: "Middle" }, { id: "r2", label: "Total" }],
          corner: "Chamber",
          ...(cellKeys ? { cell_keys: cellKeys } : {}),
          scoring_method: "human",
        },
      })
      .returning();
    const [student] = await db.insert(students).values({ owner_sub: OWNER, ssid: "889", name: "Table Student" }).returning();
    const [attempt] = await db
      .insert(attempts)
      .values({ assessment_id: a!.id, student_id: student!.id, status: "submitted", submitted_at: new Date() })
      .returning();
    const [response] = await db
      .insert(responses)
      .values({ attempt_id: attempt!.id, item_id: item!.id, response: { type: "table", cells: { r1: { c1: "12", c2: "1.50" } } } })
      .returning();
    return { assessment: a!, item: item!, response: response! };
  }

  test("the entry carries the grid, the keys, the cells and max_points = keyed cells", async () => {
    const s = await seedTable({ r1: { c1: "12", c2: "1.5" }, r2: { c1: "30" } });
    const res = await getQueue(s.assessment.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      entries: Array<{
        item: { type: string; max_points: number; table: { columns: unknown[]; rows: unknown[]; corner: string | null; cell_keys: unknown } | null };
        response: { cells: Record<string, Record<string, string>> };
      }>;
    };
    expect(body.entries).toHaveLength(1);
    const e = body.entries[0]!;
    expect(e.item.type).toBe("table");
    expect(e.item.max_points).toBe(3);
    expect(e.item.table?.columns).toHaveLength(2);
    expect(e.item.table?.corner).toBe("Chamber");
    expect(e.item.table?.cell_keys).toEqual({ r1: { c1: "12", c2: "1.5" }, r2: { c1: "30" } });
    expect(e.response.cells.r1?.c2).toBe("1.50");
  });

  test("a keyless table is worth every cell; the manual score must use that max", async () => {
    const s = await seedTable(undefined);
    const body = (await (await getQueue(s.assessment.id)).json()) as { entries: Array<{ item: { max_points: number; table: unknown } }> };
    expect(body.entries[0]!.item.max_points).toBe(4);
    expect(body.entries[0]!.item.table).not.toBeNull();

    const wrong = await postManualScore(s.response.id, { points: 1, max_points: 1 });
    expect(wrong.status).toBe(400);
    expect((await wrong.json()).error).toBe("max_points_mismatch");
    const right = await postManualScore(s.response.id, { points: 3, max_points: 4 });
    expect(right.status).toBe(201);
  });

  test("a non-table entry still says max_points 1 and no table", async () => {
    await seedQueueScenario();
    const body = (await (await getQueue((await seededAssessmentId()) ?? "")).json()) as {
      entries: Array<{ item: { stem: string; max_points: number; table: unknown } }>;
    };
    const short = body.entries.find((e) => e.item.stem === "Short human")!;
    expect(short.item.max_points).toBe(1);
    expect(short.item.table).toBeNull();
  });

  // E3-F1: with no explicit scoring_method, a keyless table's unset default
  // is human (lists in the queue) and a keyed table's is auto (skipped).
  async function seedTableNoExplicitMethod(cellKeys: Record<string, Record<string, string>> | undefined) {
    const db = getDb();
    const [a] = await db.insert(assessments).values({ owner_sub: OWNER, name: "Tables (default)" }).returning();
    const [item] = await db
      .insert(items)
      .values({
        assessment_id: a!.id,
        position: 0,
        type: "table",
        stem: "Chi-square (default)",
        config: {
          columns: [{ id: "c1", label: "Observed" }, { id: "c2", label: "Expected" }],
          rows: [{ id: "r1", label: "Middle" }, { id: "r2", label: "Total" }],
          corner: "Chamber",
          ...(cellKeys ? { cell_keys: cellKeys } : {}),
        },
      })
      .returning();
    const [student] = await db.insert(students).values({ owner_sub: OWNER, ssid: "890", name: "Table Student 2" }).returning();
    const [attempt] = await db
      .insert(attempts)
      .values({ assessment_id: a!.id, student_id: student!.id, status: "submitted", submitted_at: new Date() })
      .returning();
    await db
      .insert(responses)
      .values({ attempt_id: attempt!.id, item_id: item!.id, response: { type: "table", cells: { r1: { c1: "12", c2: "1.50" } } } });
    return { assessment: a! };
  }

  test("a keyless table with no explicit scoring_method lists itself (default human)", async () => {
    const s = await seedTableNoExplicitMethod(undefined);
    const body = (await (await getQueue(s.assessment.id)).json()) as { entries: Array<{ item: { max_points: number } }> };
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]!.item.max_points).toBe(4);
  });

  test("a keyed table with no explicit scoring_method is skipped (default auto)", async () => {
    const s = await seedTableNoExplicitMethod({ r1: { c1: "12" } });
    const body = (await (await getQueue(s.assessment.id)).json()) as { entries: unknown[] };
    expect(body.entries).toHaveLength(0);
  });
});

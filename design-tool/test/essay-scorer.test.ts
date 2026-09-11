// Slice 38: AI essay scoring — core validators, mock provider contract,
// and the score-ai route (proposed/final split, hybrid confidence gate,
// idempotency, guardrail wiring). DB parts use the items-api harness.
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { RubricSchema, type Rubric } from "@secure-test/schema";
import { closeDb, getDb } from "../db/client";
import {
  assessments,
  attempts,
  guardrail_events,
  items,
  responses,
  scores,
  students,
} from "../db/schema";
import { SESSION_COOKIE_NAME } from "../lib/auth/session";
import * as sessionMod from "../lib/auth/session";
import { mockEssayScorer } from "../lib/ai/essayScorer/mockProvider";
import {
  ESSAY_SCORE_SYSTEM_PROMPT,
  HYBRID_AUTO_FINALIZE_CONFIDENCE,
  describeLevel,
  isScorableRubricStyle,
  parseScoreResult,
  rubricMaxPoints,
  scoringView,
  validateAgainstRubric,
} from "../lib/ai/essayScorer/scoreCore";

const expectTestDb = () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("secure_test_design_tool_test")) {
    throw new Error(`essay-scorer tests require the test DB DATABASE_URL; got: ${url}`);
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

const OWNER = "essay-scorer-teacher";

beforeAll(() => {
  expectTestDb();
  originalSessionSecret = process.env.DESIGN_TOOL_SESSION_SECRET;
  process.env.DESIGN_TOOL_SESSION_SECRET = "test-session-secret-do-not-use";
  mockSub = OWNER;
});

afterEach(async () => {
  mockSub = OWNER;
  delete process.env.MOCK_ESSAY_SCORER_CONFIDENCE;
  delete process.env.GUARDRAIL_PROVIDER;
  const db = getDb();
  await db.execute(sql`truncate table assessments restart identity cascade`);
  await db.execute(sql`truncate table students restart identity cascade`);
  await db.execute(sql`truncate table guardrail_events restart identity cascade`);
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

const SINGLE_POINT: Rubric = {
  style: "single_point",
  criteria: [
    {
      id: "c1",
      name: "Focus",
      levels: [
        { id: "t", label: "Target", points: 2, descriptor: "Holds one clear claim." },
      ],
    },
    { id: "c2", name: "Evidence", levels: [{ id: "t2", label: "Target", points: 1 }] },
  ],
};

describe("scoreCore validators", () => {
  test("rubricMaxPoints sums the top level of each criterion", () => {
    expect(rubricMaxPoints(RUBRIC)).toBe(5);
  });

  test("isScorableRubricStyle: every style, single_point included (D-5)", () => {
    expect(isScorableRubricStyle(RUBRIC)).toBe(true);
    expect(isScorableRubricStyle(SINGLE_POINT)).toBe(true);
  });

  const good = {
    criterion_scores: [
      { criterion_id: "ideas", level_id: "i2", points: 2, rationale: "r" },
      { criterion_id: "org", level_id: "o2", points: 2, rationale: "r" },
    ],
    points: 4,
    max_points: 5,
    overall_rationale: "solid",
    confidence: 0.9,
  };

  test("validateAgainstRubric accepts a consistent result", () => {
    expect(validateAgainstRubric(good, RUBRIC)).toEqual({ valid: true });
  });

  test.each([
    [
      "unknown criterion",
      { ...good, criterion_scores: [{ ...good.criterion_scores[0]!, criterion_id: "nope" }, good.criterion_scores[1]!] },
    ],
    [
      "unknown level",
      { ...good, criterion_scores: [{ ...good.criterion_scores[0]!, level_id: "nope" }, good.criterion_scores[1]!] },
    ],
    [
      "points not matching the level",
      { ...good, criterion_scores: [{ ...good.criterion_scores[0]!, points: 3 }, good.criterion_scores[1]!] },
    ],
    [
      "criterion scored twice",
      { ...good, criterion_scores: [good.criterion_scores[0]!, good.criterion_scores[0]!] },
    ],
    [
      "missing a criterion",
      { ...good, criterion_scores: [good.criterion_scores[0]!], points: 2 },
    ],
    ["sum mismatch", { ...good, points: 5 }],
    ["max mismatch", { ...good, max_points: 6 }],
  ])("rejects %s", (_label, result) => {
    const verdict = validateAgainstRubric(result, RUBRIC);
    expect(verdict.valid).toBe(false);
  });

  test("parseScoreResult strips markdown fences and validates shape", () => {
    const fenced = "```json\n" + JSON.stringify(good) + "\n```";
    expect(parseScoreResult(fenced, "t").points).toBe(4);
    expect(() => parseScoreResult("not json", "t")).toThrow(/valid JSON/);
    expect(() => parseScoreResult('{"points": 1}', "t")).toThrow(/validation/);
  });
});

// Slice 4 of docs/rubric-upload-design.md (D-5): single-point rubrics score
// through a derived below/meets/exceeds ladder.
describe("scoringView (D-5)", () => {
  test("analytic and holistic pass through unchanged", () => {
    expect(scoringView(RUBRIC)).toBe(RUBRIC);
  });

  test("a single-point target becomes below / meets / exceeds", () => {
    const view = scoringView(SINGLE_POINT);
    const focus = view.criteria[0]!;
    expect(focus.levels).toEqual([
      { id: "t.below", label: "Below target", points: 0 },
      {
        id: "t.meets",
        label: "Meets target",
        points: 2,
        descriptor: "Holds one clear claim.",
      },
      { id: "t.exceeds", label: "Exceeds target", points: 2 },
    ]);
    // The view is a rubric RubricSchema accepts (single_point cardinality is
    // exactly one level, so the expansion is reported as analytic).
    expect(view.style).toBe("analytic");
    expect(RubricSchema.safeParse(view).success).toBe(true);
  });

  test("the expansion does not move the rubric maximum", () => {
    expect(rubricMaxPoints(scoringView(SINGLE_POINT))).toBe(
      rubricMaxPoints(SINGLE_POINT),
    );
    expect(rubricMaxPoints(SINGLE_POINT)).toBe(3);
    expect(rubricMaxPoints(scoringView(RUBRIC))).toBe(rubricMaxPoints(RUBRIC));
  });

  test("the view is idempotent", () => {
    const once = scoringView(SINGLE_POINT);
    expect(scoringView(once)).toEqual(once);
  });

  test("describeLevel resolves derived ids and ordinary ones", () => {
    expect(describeLevel(SINGLE_POINT, "c1", "t.meets")).toEqual({
      label: "Meets target",
      points: 2,
    });
    expect(describeLevel(SINGLE_POINT, "c1", "t.below")).toEqual({
      label: "Below target",
      points: 0,
    });
    expect(describeLevel(RUBRIC, "ideas", "i3")).toEqual({
      label: "Proficient",
      points: 3,
    });
    // The authored target id is not a scoring selection any more.
    expect(describeLevel(SINGLE_POINT, "c1", "t")).toBeNull();
    expect(describeLevel(RUBRIC, "nope", "i3")).toBeNull();
  });

  test("validateAgainstRubric rejects an analytic-style id on a single-point rubric", () => {
    const view = scoringView(SINGLE_POINT);
    const raw = {
      criterion_scores: [
        { criterion_id: "c1", level_id: "t", points: 2, rationale: "r" },
        { criterion_id: "c2", level_id: "t2.meets", points: 1, rationale: "r" },
      ],
      points: 3,
      max_points: 3,
    };
    const verdict = validateAgainstRubric(raw, view);
    expect(verdict.valid).toBe(false);
    expect((verdict as { reason: string }).reason).toContain('unknown level "t"');
  });

  test("the system prompt explains the Below / Meets / Exceeds labels", () => {
    expect(ESSAY_SCORE_SYSTEM_PROMPT).toContain("Below / Meets / Exceeds target");
  });
});

describe("mockEssayScorer", () => {
  test("returns a rubric-valid middle-level result", async () => {
    const result = await mockEssayScorer.scoreEssay({
      stem: "Discuss.",
      response_text: "An essay.",
      rubric: RUBRIC,
    });
    expect(validateAgainstRubric(result, RUBRIC)).toEqual({ valid: true });
    expect(result.confidence).toBe(0.9);
    // middle levels: ideas → i2 (2), org → o2 (index 1 of 2 → points 2)
    expect(result.points).toBe(4);
  });

  test("MOCK_ESSAY_SCORER_CONFIDENCE overrides confidence", async () => {
    process.env.MOCK_ESSAY_SCORER_CONFIDENCE = "0.4";
    const result = await mockEssayScorer.scoreEssay({
      stem: "s",
      response_text: "t",
      rubric: RUBRIC,
    });
    expect(result.confidence).toBe(0.4);
  });

  test("scores a single_point rubric through the derived ladder", async () => {
    const result = await mockEssayScorer.scoreEssay({
      stem: "s",
      response_text: "t",
      rubric: SINGLE_POINT,
    });
    // Middle of three derived levels = meets.
    expect(result.criterion_scores.map((c) => c.level_id)).toEqual([
      "t.meets",
      "t2.meets",
    ]);
    expect(result.points).toBe(3);
    expect(result.max_points).toBe(3);
    expect(validateAgainstRubric(result, scoringView(SINGLE_POINT))).toEqual({
      valid: true,
    });
  });
});

async function seedAiScenario() {
  const db = getDb();
  const [assessment] = await db
    .insert(assessments)
    .values({ owner_sub: OWNER, name: "AI score me" })
    .returning();
  const a = assessment!;
  const itemRows = await db
    .insert(items)
    .values([
      {
        assessment_id: a.id,
        position: 0,
        type: "essay",
        stem: "AI essay",
        config: { rubric: RUBRIC, scoring_method: "ai" },
      },
      {
        assessment_id: a.id,
        position: 1,
        type: "essay",
        stem: "Hybrid essay",
        config: { rubric: RUBRIC, scoring_method: "hybrid" },
      },
      // default human — must be untouched
      { assessment_id: a.id, position: 2, type: "essay", stem: "Human essay" },
    ])
    .returning();
  const [student] = await db
    .insert(students)
    .values({ owner_sub: OWNER, ssid: "777", name: "S" })
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
  await db.insert(responses).values(
    itemRows.map((item) => ({
      attempt_id: at.id,
      item_id: item.id,
      response: { type: "essay" as const, text: `Response for ${item.stem}.` },
    })),
  );
  return { db, assessment: a, attempt: at, itemRows };
}

async function postScoreAi(attemptId: string) {
  const { POST } = await import("../app/api/attempts/[attemptId]/score-ai/route");
  return POST(
    new Request(`http://localhost/api/attempts/${attemptId}/score-ai`, { method: "POST" }),
    { params: Promise.resolve({ attemptId }) },
  );
}

describe("POST /api/attempts/:id/score-ai", () => {
  test("ai → proposed; hybrid ≥ gate → final; human untouched; idempotent", async () => {
    expect(HYBRID_AUTO_FINALIZE_CONFIDENCE).toBe(0.85);
    const { db, attempt } = await seedAiScenario();
    const res = await postScoreAi(attempt.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    // mock confidence 0.9 ≥ 0.85 → hybrid finalizes, ai stays proposed
    expect(body.scored_proposed).toBe(1);
    expect(body.scored_final).toBe(1);
    expect(body.skipped_not_ai).toBe(1);
    expect(body.blocked).toBe(0);

    const rows = await db.select().from(scores);
    expect(rows).toHaveLength(2);
    for (const s of rows) {
      expect(s.method).toBe("ai");
      expect(s.scorer).toBe("mock");
      expect(s.points).toBe(4);
      expect(s.max_points).toBe(5);
      const rationale = s.rationale as { confidence: number };
      expect(rationale.confidence).toBe(0.9);
    }
    expect(rows.map((s) => s.status).sort()).toEqual(["final", "proposed"]);

    // Re-run: both AI-eligible responses already have a score row.
    const res2 = await postScoreAi(attempt.id);
    const body2 = (await res2.json()) as Record<string, unknown>;
    expect(body2.scored_proposed).toBe(0);
    expect(body2.scored_final).toBe(0);
    expect(body2.already_scored).toBe(2);
    expect(await db.select().from(scores)).toHaveLength(2);
  });

  test("hybrid below the confidence gate lands proposed", async () => {
    process.env.MOCK_ESSAY_SCORER_CONFIDENCE = "0.5";
    const { db, attempt } = await seedAiScenario();
    const res = await postScoreAi(attempt.id);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.scored_proposed).toBe(2); // ai AND hybrid both proposed
    expect(body.scored_final).toBe(0);
    const rows = await db.select().from(scores);
    expect(rows.every((s) => s.status === "proposed")).toBe(true);
  });

  test("guardrail mock blocks BLOCKME input and records telemetry", async () => {
    process.env.GUARDRAIL_PROVIDER = "mock";
    const { db, attempt, itemRows } = await seedAiScenario();
    // Poison the ai item's response with the mock guardrail sentinel.
    await db
      .update(responses)
      .set({ response: { type: "essay", text: "BLOCKME plus essay text" } })
      .where(eq(responses.item_id, itemRows[0]!.id));

    const res = await postScoreAi(attempt.id);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.blocked).toBe(1);
    expect(body.scored_final).toBe(1); // hybrid item still scored

    const blockedEvents = await db
      .select()
      .from(guardrail_events)
      .where(eq(guardrail_events.action, "block"));
    expect(blockedEvents).toHaveLength(1);
    expect(blockedEvents[0]!.surface).toBe("essay-score");
    expect(blockedEvents[0]!.stage).toBe("input");

    // The blocked response got no score row (1 hybrid final + 0 for ai).
    const rows = await db.select().from(scores);
    expect(rows).toHaveLength(1);
  });

  test("blank essay text is skipped, not sent to the model", async () => {
    const { db, attempt, itemRows } = await seedAiScenario();
    await db
      .update(responses)
      .set({ response: { type: "essay", text: "   " } })
      .where(eq(responses.item_id, itemRows[0]!.id));
    const res = await postScoreAi(attempt.id);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.skipped_unscorable).toBe(1);
    expect(body.scored_proposed).toBe(0);
    expect(body.scored_final).toBe(1);
  });

  test("403 for another teacher's attempt", async () => {
    const { attempt } = await seedAiScenario();
    mockSub = "someone-else";
    const res = await postScoreAi(attempt.id);
    expect(res.status).toBe(403);
  });
});

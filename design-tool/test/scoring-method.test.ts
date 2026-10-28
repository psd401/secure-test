// Slice 36: per-item scoring method — write-boundary validation, defaults,
// bundle round-trip, and import clamping. Same harness as items-api.test.ts.
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { asc, eq, sql } from "drizzle-orm";
import { closeDb, getDb } from "../db/client";
import { items } from "../db/schema";
import { SESSION_COOKIE_NAME } from "../lib/auth/session";
import * as headersMod from "next/headers";
import * as sessionMod from "../lib/auth/session";
import {
  DEFAULT_SCORING_METHOD,
  effectiveScoringMethod,
} from "../lib/api/items";

const expectTestDb = () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("secure_test_design_tool_test")) {
    throw new Error(`scoring-method tests require the test DB DATABASE_URL; got: ${url}`);
  }
};

let originalSessionSecret: string | undefined;
let mockSub: string | null = null;

mock.module("next/headers", () => ({
  ...headersMod,
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
  mockSub = "scoring-method-teacher";
});

afterEach(async () => {
  const db = getDb();
  await db.execute(sql`truncate table assessments restart identity cascade`);
});

afterAll(async () => {
  await closeDb();
  if (originalSessionSecret === undefined) {
    delete process.env.DESIGN_TOOL_SESSION_SECRET;
  } else {
    process.env.DESIGN_TOOL_SESSION_SECRET = originalSessionSecret;
  }
});

const RUBRIC = {
  style: "analytic",
  criteria: [
    {
      id: "c1",
      name: "Ideas",
      levels: [
        { id: "l1", label: "Emerging", points: 1 },
        { id: "l2", label: "Proficient", points: 2 },
      ],
    },
  ],
};

const MC_BODY = {
  type: "multiple_choice_single",
  stem: "Pick one",
  choices: [
    { id: "a", text: "A" },
    { id: "b", text: "B" },
  ],
  correct_choice_ids: ["a"],
};

async function createAssessment(name: string) {
  const { POST } = await import("../app/api/assessments/route");
  const res = await POST(
    new Request("http://localhost/api/assessments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    }),
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { assessment: { id: string } }).assessment.id;
}

async function postItem(assessmentId: string, body: unknown) {
  const { POST } = await import("../app/api/assessments/[id]/items/route");
  return POST(
    new Request(`http://localhost/api/assessments/${assessmentId}/items`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: assessmentId }) },
  );
}

// The teacher share/backup copy — include_hidden_rubrics=1, matching the
// "Export JSON" affordance. The default (student-safe) shape is covered in
// test/import-items-csv.test.ts (B8).
async function exportBundle(assessmentId: string) {
  const { GET } = await import("../app/api/assessments/[id]/export/route");
  const res = await GET(
    new Request(
      `http://localhost/api/assessments/${assessmentId}/export?include_hidden_rubrics=1`,
    ),
    { params: Promise.resolve({ id: assessmentId }) },
  );
  expect(res.status).toBe(200);
  return res.json();
}

async function postImport(body: unknown) {
  const { POST } = await import("../app/api/assessments/import/route");
  return POST(
    new Request("http://localhost/api/assessments/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("effectiveScoringMethod", () => {
  test("falls back to the type default when unset", () => {
    expect(effectiveScoringMethod("multiple_choice_single", {})).toBe("auto");
    expect(effectiveScoringMethod("short_text", null)).toBe("auto");
    expect(effectiveScoringMethod("essay", undefined)).toBe("human");
    expect(DEFAULT_SCORING_METHOD.multiple_choice_multi).toBe("auto");
  });

  test("stored pick wins over the default", () => {
    expect(
      effectiveScoringMethod("multiple_choice_single", { scoring_method: "human" }),
    ).toBe("human");
    expect(
      effectiveScoringMethod("essay", { scoring_method: "hybrid" }),
    ).toBe("hybrid");
  });
});

describe("POST items — scoring_method validation", () => {
  test("MC accepts human and persists it in config", async () => {
    const id = await createAssessment("A");
    const res = await postItem(id, { ...MC_BODY, scoring_method: "human" });
    expect(res.status).toBe(201);
    const db = getDb();
    const [row] = await db.select().from(items).where(eq(items.assessment_id, id));
    expect(row?.config.scoring_method).toBe("human");
  });

  test("omitting scoring_method stores no key (default applies at read)", async () => {
    const id = await createAssessment("A");
    const res = await postItem(id, MC_BODY);
    expect(res.status).toBe(201);
    const db = getDb();
    const [row] = await db.select().from(items).where(eq(items.assessment_id, id));
    expect(row?.config.scoring_method).toBeUndefined();
  });

  test.each([
    ["MC + ai", { ...MC_BODY, scoring_method: "ai" }],
    ["MC + hybrid", { ...MC_BODY, scoring_method: "hybrid" }],
    [
      "short_text + ai",
      { type: "short_text", stem: "S", correct_answer: "x", scoring_method: "ai" },
    ],
    ["essay + auto", { type: "essay", stem: "E", scoring_method: "auto" }],
    [
      "essay + ai without rubric",
      { type: "essay", stem: "E", scoring_method: "ai" },
    ],
    [
      "essay + hybrid without rubric",
      { type: "essay", stem: "E", scoring_method: "hybrid" },
    ],
    ["bogus value", { ...MC_BODY, scoring_method: "vibes" }],
  ])("rejects %s with 400", async (_label, body) => {
    const id = await createAssessment("A");
    const res = await postItem(id, body);
    expect(res.status).toBe(400);
  });

  test("essay + ai with rubric is accepted", async () => {
    const id = await createAssessment("A");
    const res = await postItem(id, {
      type: "essay",
      stem: "E",
      rubric: RUBRIC,
      scoring_method: "ai",
    });
    expect(res.status).toBe(201);
    const db = getDb();
    const [row] = await db.select().from(items).where(eq(items.assessment_id, id));
    expect(row?.config.scoring_method).toBe("ai");
    expect(row?.config.rubric).toBeTruthy();
  });
});

describe("bundle round-trip + import clamping", () => {
  test("export carries scoring_method only when set; import preserves it", async () => {
    const id = await createAssessment("Round trip");
    expect((await postItem(id, { ...MC_BODY, scoring_method: "human" })).status).toBe(201);
    expect(
      (await postItem(id, { type: "short_text", stem: "S", correct_answer: "x" }))
        .status,
    ).toBe(201);
    expect(
      (
        await postItem(id, {
          type: "essay",
          stem: "E",
          rubric: RUBRIC,
          scoring_method: "hybrid",
        })
      ).status,
    ).toBe(201);

    const bundle = (await exportBundle(id)) as {
      items: Array<{ type: string; scoring_method?: string }>;
    };
    expect(bundle.items[0]?.scoring_method).toBe("human");
    expect(bundle.items[1]?.scoring_method).toBeUndefined();
    expect(bundle.items[2]?.scoring_method).toBe("hybrid");

    const res = await postImport(bundle);
    expect(res.status).toBe(201);
    const { assessment } = (await res.json()) as { assessment: { id: string } };
    const db = getDb();
    const rows = await db
      .select()
      .from(items)
      .where(eq(items.assessment_id, assessment.id))
      .orderBy(asc(items.position));
    expect(rows[0]?.config.scoring_method).toBe("human");
    expect(rows[1]?.config.scoring_method).toBeUndefined();
    expect(rows[2]?.config.scoring_method).toBe("hybrid");
  });

  test("import clamps methods that are invalid for the type or lack a rubric", async () => {
    const bundle = {
      test_id: "clamp-test",
      title: "Clamped",
      items: [
        // Invalid for type — dropped, default applies at read time.
        {
          type: "short_text",
          id: "i1",
          stem: "S",
          correct_answer: "x",
          scoring_method: "ai",
        },
        { type: "essay", id: "i2", stem: "E1", scoring_method: "auto" },
        // ai without a rubric — dropped.
        { type: "essay", id: "i3", stem: "E2", scoring_method: "ai" },
        // Valid — kept.
        { type: "essay", id: "i4", stem: "E3", rubric: RUBRIC, scoring_method: "ai" },
      ],
    };
    const res = await postImport(bundle);
    expect(res.status).toBe(201);
    const { assessment } = (await res.json()) as { assessment: { id: string } };
    const db = getDb();
    const rows = await db
      .select()
      .from(items)
      .where(eq(items.assessment_id, assessment.id))
      .orderBy(asc(items.position));
    expect(rows).toHaveLength(4);
    expect(rows[0]?.config.scoring_method).toBeUndefined();
    expect(rows[1]?.config.scoring_method).toBeUndefined();
    expect(rows[2]?.config.scoring_method).toBeUndefined();
    expect(rows[3]?.config.scoring_method).toBe("ai");
  });
});

// AI short answer (James, 2026-10-27: D1 rubric only while AI scored, D2
// holistic with partial credit, D3 always exported).
describe("AI short answer", () => {
  const KEY = {
    style: "holistic" as const,
    criteria: [
      {
        id: "sa",
        name: "Answer",
        levels: [
          { id: "sa0", label: "No credit", points: 0 },
          { id: "sa1", label: "Partial credit", points: 1, descriptor: "Names births." },
          { id: "sa2", label: "Full credit", points: 2, descriptor: "Births per 1000 people." },
        ],
      },
    ],
  };
  const SHORT = { type: "short_text", stem: "Define birth rate." };

  async function storedConfig(id: string) {
    const [row] = await getDb().select().from(items).where(eq(items.assessment_id, id));
    return row!.config;
  }

  test("hybrid with a holistic key is stored with its rubric", async () => {
    const id = await createAssessment("A");
    const res = await postItem(id, { ...SHORT, scoring_method: "hybrid", rubric: KEY });
    expect(res.status).toBe(201);
    expect(await storedConfig(id)).toEqual({ scoring_method: "hybrid", rubric: KEY });
  });

  test.each([
    ["a rubric with auto", { ...SHORT, scoring_method: "auto", rubric: KEY }],
    ["a rubric with human", { ...SHORT, scoring_method: "human", rubric: KEY }],
    ["an analytic rubric", { ...SHORT, scoring_method: "ai", rubric: { ...KEY, style: "analytic" } }],
    [
      "a scoring level with no text",
      {
        ...SHORT,
        scoring_method: "ai",
        rubric: {
          ...KEY,
          criteria: [{ ...KEY.criteria[0], levels: [KEY.criteria[0]!.levels[0], { id: "x", label: "Full", points: 1 }] }],
        },
      },
    ],
    [
      "a 0-point rubric",
      {
        ...SHORT,
        scoring_method: "ai",
        rubric: { ...KEY, criteria: [{ ...KEY.criteria[0], levels: [{ id: "a", label: "A", points: 0 }, { id: "b", label: "B", points: 0 }] }] },
      },
    ],
  ])("rejects %s with 400", async (_label, body) => {
    const id = await createAssessment("A");
    expect((await postItem(id, body)).status).toBe(400);
  });

  test("a rubric sent with no method is not stored (the default is auto)", async () => {
    const id = await createAssessment("A");
    expect((await postItem(id, { ...SHORT, correct_answer: "x", rubric: KEY })).status).toBe(201);
    expect(await storedConfig(id)).toEqual({});
  });

  test("export always carries the key; import round-trips it", async () => {
    const id = await createAssessment("A");
    await postItem(id, { ...SHORT, scoring_method: "ai", rubric: KEY });
    // The student-safe default export too (D3), not only include_hidden_rubrics.
    const { GET } = await import("../app/api/assessments/[id]/export/route");
    const plain = await (
      await GET(new Request(`http://localhost/api/assessments/${id}/export`), { params: Promise.resolve({ id }) })
    ).json();
    expect(plain.items[0]).toMatchObject({ type: "short_text", scoring_method: "ai", rubric: KEY });
    const res = await postImport({ ...plain, title: "Copy" });
    expect(res.status).toBe(201);
    const { assessment } = (await res.json()) as { assessment: { id: string } };
    expect(await storedConfig(assessment.id)).toEqual({ scoring_method: "ai", rubric: KEY });
  });

  test("import drops a key it cannot use, and the method with it", async () => {
    const res = await postImport({
      test_id: "sa-clamp",
      title: "Clamp",
      items: [
        { type: "short_text", id: "a", stem: "A", scoring_method: "hybrid", rubric: { ...KEY, style: "analytic" } },
        { type: "short_text", id: "b", stem: "B", scoring_method: "auto", correct_answer: "x", rubric: KEY },
      ],
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { assessment: { id: string }; scoring_methods_dropped: number };
    expect(body.scoring_methods_dropped).toBe(1);
    const rows = await getDb()
      .select()
      .from(items)
      .where(eq(items.assessment_id, body.assessment.id))
      .orderBy(asc(items.position));
    expect(rows.map((r) => r.config)).toEqual([{}, { scoring_method: "auto" }]);
  });
});

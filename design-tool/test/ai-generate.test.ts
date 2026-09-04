import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { sql } from "drizzle-orm";
import { CreateItemBody } from "../lib/api/items";
import { mockProvider } from "../lib/ai/provider";
import { AI_GENERABLE_ITEM_TYPES } from "../lib/ai/types";
import { closeDb, getDb } from "../db/client";
import { assessments } from "../db/schema";
import { SESSION_COOKIE_NAME } from "../lib/auth/session";
import * as sessionMod from "../lib/auth/session";

const expectTestDb = () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("secure_test_design_tool_test")) {
    throw new Error(`ai-generate tests require the test DB; got ${url}`);
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

function asUser(sub: string | null) {
  mockSub = sub;
}

beforeAll(() => {
  expectTestDb();
  originalSessionSecret = process.env.DESIGN_TOOL_SESSION_SECRET;
  process.env.DESIGN_TOOL_SESSION_SECRET = "test-session-secret-do-not-use";
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

async function postGenerate(body: unknown) {
  const { POST } = await import("../app/api/ai/generate-item/route");
  const req = new Request("http://localhost/api/ai/generate-item", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return POST(req);
}

async function makeAssessment(opts: { allow_llm_authoring: boolean; owner_sub: string }) {
  const db = getDb();
  const [row] = await db
    .insert(assessments)
    .values({
      owner_sub: opts.owner_sub,
      name: "AI test",
      description: "",
      allow_llm_authoring: opts.allow_llm_authoring,
    })
    .returning();
  return row!;
}

describe("mockProvider", () => {
  test("single-select returns a CreateItemBody-valid item", async () => {
    const out = await mockProvider.generateItem({
      assessment_id: "00000000-0000-0000-0000-000000000000",
      item_type: "multiple_choice_single",
      prompt: "What is 7 + 5?",
    });
    expect(out.type).toBe("multiple_choice_single");
    expect(out.stem).toContain("7 + 5");
    expect(CreateItemBody.parse(out)).toBeTruthy();
  });

  test("multi-select returns a CreateItemBody-valid item", async () => {
    const out = await mockProvider.generateItem({
      assessment_id: "00000000-0000-0000-0000-000000000000",
      item_type: "multiple_choice_multi",
      prompt: "Pick the primary colors",
    });
    expect(out.type).toBe("multiple_choice_multi");
    expect(CreateItemBody.parse(out)).toBeTruthy();
    expect(out.correct_choice_ids.length).toBeGreaterThanOrEqual(1);
  });

  test("short_text returns a CreateItemBody-valid item with a non-empty answer", async () => {
    const out = await mockProvider.generateItem({
      assessment_id: "00000000-0000-0000-0000-000000000000",
      item_type: "short_text",
      prompt: "What is the capital of WA?",
    });
    expect(out.type).toBe("short_text");
    expect(out.choices.length).toBe(0);
    expect(out.correct_answer).toBeTruthy();
    expect(CreateItemBody.parse(out)).toBeTruthy();
  });

  // E18: the server enum still listed `essay` even though no provider
  // implements it. The mock fell through its short_text / MC branches and
  // returned a canned multiple_choice_multi — the caller asked for an essay
  // and got a four-option MC item.
  test("AI_GENERABLE_ITEM_TYPES excludes essay and every structural type", () => {
    expect([...AI_GENERABLE_ITEM_TYPES]).toEqual([
      "multiple_choice_single",
      "multiple_choice_multi",
      "short_text",
    ]);
  });
});

describe("POST /api/ai/generate-item", () => {
  test("401 with no session", async () => {
    asUser(null);
    const res = await postGenerate({
      assessment_id: "00000000-0000-0000-0000-000000000001",
      item_type: "multiple_choice_single",
      prompt: "x",
    });
    expect(res.status).toBe(401);
  });

  test("404 when assessment doesn't exist", async () => {
    asUser("teacher-1");
    const res = await postGenerate({
      assessment_id: "00000000-0000-0000-0000-000000000001",
      item_type: "multiple_choice_single",
      prompt: "x",
    });
    expect(res.status).toBe(404);
  });

  test("403 when caller does not own the assessment", async () => {
    asUser("teacher-1");
    const owned = await makeAssessment({
      allow_llm_authoring: true,
      owner_sub: "teacher-2",
    });
    const res = await postGenerate({
      assessment_id: owned.id,
      item_type: "multiple_choice_single",
      prompt: "x",
    });
    expect(res.status).toBe(403);
  });

  // E18: essay used to pass the enum, reach the provider, and come back as a
  // multiple_choice_multi. Structural types were never generable.
  test.each(["essay", "match", "order", "hotspot", "drawing"])(
    "400 for item_type %s (not AI-generable)",
    async (item_type) => {
      asUser("teacher-1");
      const a = await makeAssessment({
        allow_llm_authoring: true,
        owner_sub: "teacher-1",
      });
      const res = await postGenerate({
        assessment_id: a.id,
        item_type,
        prompt: "Write me one",
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("invalid_body");
    },
  );

  test("403 with explicit llm_authoring_disabled when assessment disallows it", async () => {
    asUser("teacher-1");
    const a = await makeAssessment({
      allow_llm_authoring: false,
      owner_sub: "teacher-1",
    });
    const res = await postGenerate({
      assessment_id: a.id,
      item_type: "multiple_choice_single",
      prompt: "x",
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("llm_authoring_disabled");
  });

  test("200 returns provider id + CreateItemBody-valid proposal when allowed", async () => {
    asUser("teacher-1");
    const a = await makeAssessment({
      allow_llm_authoring: true,
      owner_sub: "teacher-1",
    });
    const res = await postGenerate({
      assessment_id: a.id,
      item_type: "multiple_choice_single",
      prompt: "Draft a question about photosynthesis.",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { provider: string; proposal: unknown };
    expect(body.provider).toBe("mock");
    expect(CreateItemBody.parse(body.proposal)).toBeTruthy();
  });

  test("400 when body fails Zod validation (missing prompt)", async () => {
    asUser("teacher-1");
    const a = await makeAssessment({
      allow_llm_authoring: true,
      owner_sub: "teacher-1",
    });
    const res = await postGenerate({
      assessment_id: a.id,
      item_type: "multiple_choice_single",
    });
    expect(res.status).toBe(400);
  });
});

describe("provider selector", () => {
  test("unknown AI_PROVIDER throws a clear error pointing at the ADR", async () => {
    const original = process.env.AI_PROVIDER;
    process.env.AI_PROVIDER = "this-does-not-exist";
    try {
      const { getProvider } = await import("../lib/ai/provider");
      expect(() => getProvider()).toThrow(/0007-ai-model-selection/);
    } finally {
      if (original === undefined) delete process.env.AI_PROVIDER;
      else process.env.AI_PROVIDER = original;
    }
  });
});

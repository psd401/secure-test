// BG slice 3 (docs/batch-item-generation-design.md, D-3 … D-7): the batch
// route, driven by the mock item provider (the default — no module mocking of
// the provider, so the true path runs) and, for the blocked paths, the mock
// guardrail. Requires the test DB.
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { closeDb, getDb } from "../db/client";
import { assessments, guardrail_events, items } from "../db/schema";
import { CreateItemBody } from "../lib/api/items";
import { SESSION_COOKIE_NAME } from "../lib/auth/session";
import * as sessionMod from "../lib/auth/session";

const expectTestDb = () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("secure_test_design_tool_test")) {
    throw new Error(`ai-generate-items tests require the test DB; got ${url}`);
  }
};

const OWNER = "batch-teacher";
let originalSessionSecret: string | undefined;
let mockSession: { sub: string; role: string } | null = null;

mock.module("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({
    get: (name: string) => (mockSession && name === SESSION_COOKIE_NAME ? { value: "x" } : undefined),
  }),
}));

mock.module("../lib/auth/session", () => ({
  ...sessionMod,
  readSessionFromCookies: async () => mockSession,
}));

beforeAll(() => {
  expectTestDb();
  originalSessionSecret = process.env.DESIGN_TOOL_SESSION_SECRET;
  process.env.DESIGN_TOOL_SESSION_SECRET = "test-session-secret-do-not-use";
});

afterEach(async () => {
  mockSession = { sub: OWNER, role: "staff" };
  delete process.env.GUARDRAIL_PROVIDER;
  const db = getDb();
  await db.execute(sql`truncate table assessments, guardrail_events restart identity cascade`);
});

afterAll(async () => {
  await closeDb();
  if (originalSessionSecret === undefined) delete process.env.DESIGN_TOOL_SESSION_SECRET;
  else process.env.DESIGN_TOOL_SESSION_SECRET = originalSessionSecret;
});

async function makeAssessment(opts: { allow_llm_authoring?: boolean; owner_sub?: string } = {}) {
  const [row] = await getDb()
    .insert(assessments)
    .values({
      owner_sub: opts.owner_sub ?? OWNER,
      name: "Batch test",
      description: "",
      allow_llm_authoring: opts.allow_llm_authoring ?? true,
    })
    .returning();
  return row!;
}

async function postJson(body: unknown) {
  const { POST } = await import("../app/api/ai/generate-items/route");
  return POST(
    new Request("http://localhost/api/ai/generate-items", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

async function postMultipart(body: unknown, file: File) {
  const { POST } = await import("../app/api/ai/generate-items/route");
  const form = new FormData();
  form.append("request", JSON.stringify(body));
  form.append("file", file);
  return POST(new Request("http://localhost/api/ai/generate-items", { method: "POST", body: form }));
}

async function itemCount(assessmentId: string) {
  const rows = await getDb().select({ id: items.id }).from(items).where(eq(items.assessment_id, assessmentId));
  return rows.length;
}

interface OkBody {
  ok: true;
  proposals: Record<string, unknown>[];
  requested: number;
  dropped: number;
  provider: string;
}

describe("POST /api/ai/generate-items — access", () => {
  test("401 with no session; 403 for a student principal", async () => {
    mockSession = null;
    const body = { assessment_id: "00000000-0000-4000-8000-000000000001", count: 1, notes: "x" };
    expect((await postJson(body)).status).toBe(401);
    mockSession = { sub: "student-sub", role: "student" };
    expect((await postJson(body)).status).toBe(403);
  });

  test("404 for another teacher's assessment (access slice 1, D-3)", async () => {
    mockSession = { sub: OWNER, role: "staff" };
    const theirs = await makeAssessment({ owner_sub: "someone-else" });
    const res = await postJson({ assessment_id: theirs.id, count: 2, notes: "fractions" });
    expect(res.status).toBe(404);
  });

  test("403 llm_authoring_disabled when the assessment disallows AI authoring", async () => {
    mockSession = { sub: OWNER, role: "staff" };
    const a = await makeAssessment({ allow_llm_authoring: false });
    const res = await postJson({ assessment_id: a.id, count: 2, notes: "fractions" });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("llm_authoring_disabled");
  });
});

describe("POST /api/ai/generate-items — validation", () => {
  test.each([
    ["count > 10", { count: 11, notes: "x" }],
    ["type counts not summing to count", { count: 4, types: { essay: 1, short_text: 2 }, notes: "x" }],
    ["a structural type match does not cover", { count: 2, types: { order: 2 }, notes: "x" }],
    ["no target, resource or notes", { count: 2, target: { objective: "  " } }],
    ["more than 10 standards", { count: 1, target: { standards: Array.from({ length: 11 }, (_, i) => `t${i}`) } }],
    ["notes over 2000", { count: 1, notes: "x".repeat(2001) }],
  ])("400 invalid_body: %s", async (_label, extra) => {
    mockSession = { sub: OWNER, role: "staff" };
    const a = await makeAssessment();
    const res = await postJson({ assessment_id: a.id, ...extra });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; detail: string };
    expect(body.error).toBe("invalid_body");
    expect(body.detail.length).toBeGreaterThan(0);
  });

  test("415 for an unsupported file type", async () => {
    mockSession = { sub: OWNER, role: "staff" };
    const a = await makeAssessment();
    const res = await postMultipart(
      { assessment_id: a.id, count: 1 },
      new File([new Uint8Array([1, 2])], "slides.pptx", { type: "application/octet-stream" }),
    );
    expect(res.status).toBe(415);
  });
});

describe("POST /api/ai/generate-items — proposals", () => {
  test("200: count + types honored, every proposal carries the batch tags, nothing written", async () => {
    mockSession = { sub: OWNER, role: "staff" };
    const a = await makeAssessment();
    await getDb()
      .insert(items)
      .values({ assessment_id: a.id, position: 0, type: "short_text", stem: "An item already here" });
    const before = await itemCount(a.id);

    const res = await postJson({
      assessment_id: a.id,
      count: 5,
      types: { multiple_choice_single: 2, short_text: 1, essay: 2 },
      target: { standards: ["wa2026:M.7.R.RP.2", " My target ", "My target"] },
      difficulty: "on_level",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as OkBody;
    expect(body).toMatchObject({ ok: true, requested: 5, dropped: 0, provider: "mock" });
    expect(body.proposals.map((p) => p.type)).toEqual([
      "multiple_choice_single",
      "multiple_choice_single",
      "short_text",
      "essay",
      "essay",
    ]);
    for (const p of body.proposals) {
      expect(p.standards).toEqual(["wa2026:M.7.R.RP.2", "My target"]);
      expect(CreateItemBody.safeParse(p).success).toBe(true);
    }
    expect(await itemCount(a.id)).toBe(before);
  });

  test("BG slice 6: match by count — pairs numbered, and Add posts it through the items route", async () => {
    mockSession = { sub: OWNER, role: "staff" };
    const a = await makeAssessment();
    const res = await postJson({
      assessment_id: a.id,
      count: 3,
      types: { match: 2, short_text: 1 },
      target: { standards: ["My target"] },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as OkBody;
    expect(body.proposals.map((p) => p.type)).toEqual(["short_text", "match", "match"]);
    const match = body.proposals[1]!;
    expect((match.pairs as { id: string }[]).map((p) => p.id)).toEqual(["p1", "p2", "p3"]);
    expect(match.standards).toEqual(["My target"]);
    expect(await itemCount(a.id)).toBe(0);

    // Add: the dialog posts the proposal unchanged.
    const { POST } = await import("../app/api/assessments/[id]/items/route");
    const added = await POST(
      new Request(`http://localhost/api/assessments/${a.id}/items`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(match),
      }),
      { params: Promise.resolve({ id: a.id }) },
    );
    expect(added.status).toBe(201);
    const [row] = await getDb().select().from(items).where(eq(items.assessment_id, a.id));
    expect(row!.type).toBe("match");
    expect((row!.config as { pairs: unknown }).pairs).toEqual(match.pairs);
  });

  test("mix never yields match", async () => {
    mockSession = { sub: OWNER, role: "staff" };
    const a = await makeAssessment();
    const res = await postJson({ assessment_id: a.id, count: 10, notes: "a mix" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as OkBody;
    expect(body.proposals).toHaveLength(10);
    expect(body.proposals.some((p) => p.type === "match")).toBe(false);
  });

  test("a malformed element is dropped and counted, the rest come back", async () => {
    mockSession = { sub: OWNER, role: "staff" };
    const a = await makeAssessment();
    const res = await postJson({ assessment_id: a.id, count: 4, notes: "MOCK_MALFORMED please" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as OkBody;
    expect(body.proposals).toHaveLength(3);
    expect(body.dropped).toBe(1);
  });

  test("zero valid elements → 502 provider_failed with detail", async () => {
    mockSession = { sub: OWNER, role: "staff" };
    const a = await makeAssessment();
    const res = await postJson({ assessment_id: a.id, count: 3, notes: "MOCK_ALL_MALFORMED" });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string; detail: string };
    expect(body.error).toBe("provider_failed");
    expect(body.detail).toMatch(/provider_returned_no_valid_items/);
  });

  test("multipart: a PDF resource reaches the provider; text resource via JSON works too", async () => {
    mockSession = { sub: OWNER, role: "staff" };
    const a = await makeAssessment();
    const pdf = await postMultipart(
      { assessment_id: a.id, count: 2 },
      new File([new TextEncoder().encode("%PDF-1.4 a reading")], "reading.pdf", { type: "application/pdf" }),
    );
    expect(pdf.status).toBe(200);
    const pdfBody = (await pdf.json()) as OkBody;
    expect(pdfBody.proposals).toHaveLength(2);
    expect(String(pdfBody.proposals[0]!.stem)).toContain("the source material");

    const text = await postJson({ assessment_id: a.id, count: 1, resource: { text: "Cells divide." } });
    expect(text.status).toBe(200);
  });
});

describe("POST /api/ai/generate-items — guardrail (GUARDRAIL_PROVIDER=mock)", () => {
  test("blocked input → 422 guardrail_blocked, model not called", async () => {
    mockSession = { sub: OWNER, role: "staff" };
    process.env.GUARDRAIL_PROVIDER = "mock";
    const a = await makeAssessment();
    const res = await postJson({ assessment_id: a.id, count: 2, resource: { text: "BLOCKME text" } });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; stage: string; note: string };
    expect(body).toMatchObject({ error: "guardrail_blocked", stage: "input" });
    expect(body.note).toMatch(/safeguards/i);
    const events = await getDb().select().from(guardrail_events);
    expect(events.map((e) => [e.surface, e.stage, e.action])).toEqual([["item-gen", "input", "block"]]);
  });

  test("blocked output → 422 stage output (a custom tag the mock echoes into its stems)", async () => {
    mockSession = { sub: OWNER, role: "staff" };
    process.env.GUARDRAIL_PROVIDER = "mock";
    const a = await makeAssessment();
    const res = await postJson({ assessment_id: a.id, count: 2, target: { standards: ["BLOCKME"] } });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { stage: string }).stage).toBe("output");
    // Standards alone are not teacher prose to screen: no input event.
    const events = await getDb().select().from(guardrail_events);
    expect(events.map((e) => [e.stage, e.action])).toEqual([["output", "block"]]);
  });
});

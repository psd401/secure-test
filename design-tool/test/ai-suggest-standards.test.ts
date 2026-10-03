// BG slice 5 (docs/batch-item-generation-design.md D-2): the "Suggest
// standards" route, driven by the mock provider (the default) and, for the
// blocked paths, the mock guardrail. Requires the test DB.
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { closeDb, getDb } from "../db/client";
import { assessments, guardrail_events, items } from "../db/schema";
import { SESSION_COOKIE_NAME } from "../lib/auth/session";
import * as sessionMod from "../lib/auth/session";

const expectTestDb = () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("secure_test_design_tool_test")) {
    throw new Error(`ai-suggest-standards tests require the test DB; got ${url}`);
  }
};

const OWNER = "suggest-teacher";
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
  await getDb().execute(sql`truncate table assessments, guardrail_events restart identity cascade`);
});

afterAll(async () => {
  await closeDb();
  if (originalSessionSecret === undefined) delete process.env.DESIGN_TOOL_SESSION_SECRET;
  else process.env.DESIGN_TOOL_SESSION_SECRET = originalSessionSecret;
});

async function makeAssessment(opts: { allow_llm_authoring?: boolean; owner_sub?: string; status?: string } = {}) {
  const [row] = await getDb()
    .insert(assessments)
    .values({
      owner_sub: opts.owner_sub ?? OWNER,
      name: "Suggest test",
      description: "",
      allow_llm_authoring: opts.allow_llm_authoring ?? true,
      ...(opts.status ? { status: opts.status } : {}),
    })
    .returning();
  return row!;
}

async function addItems(assessmentId: string, stems: string[], tagged: Record<number, string[]> = {}) {
  const rows = await getDb()
    .insert(items)
    .values(
      stems.map((stem, i) => ({
        assessment_id: assessmentId,
        position: i,
        type: "short_text" as const,
        stem,
        standards: tagged[i] ?? [],
      })),
    )
    .returning();
  return rows.sort((a, b) => a.position - b.position);
}

async function post(body: unknown) {
  const { POST } = await import("../app/api/ai/suggest-standards/route");
  return POST(
    new Request("http://localhost/api/ai/suggest-standards", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

const FILTER = { subject: "math", grade_band: "7" };

interface OkBody {
  ok: true;
  suggestions: { item_id: string; tags: { tag: string; reason: string }[] }[];
  considered: number;
  left_out: number;
  provider: string;
}

describe("POST /api/ai/suggest-standards — access", () => {
  test("401 with no session; 403 for a student principal", async () => {
    mockSession = null;
    const body = { assessment_id: "00000000-0000-4000-8000-000000000001", ...FILTER };
    expect((await post(body)).status).toBe(401);
    mockSession = { sub: "student-sub", role: "student" };
    expect((await post(body)).status).toBe(403);
  });

  test("404 for another teacher's assessment", async () => {
    const theirs = await makeAssessment({ owner_sub: "someone-else" });
    expect((await post({ assessment_id: theirs.id, ...FILTER })).status).toBe(404);
  });

  test("403 llm_authoring_disabled when the assessment disallows AI authoring", async () => {
    const a = await makeAssessment({ allow_llm_authoring: false });
    const res = await post({ assessment_id: a.id, ...FILTER });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("llm_authoring_disabled");
  });
});

describe("POST /api/ai/suggest-standards — validation", () => {
  test.each([
    ["no subject", { grade_band: "7" }],
    ["no grade band", { subject: "math" }],
    ["an unknown subject", { subject: "art", grade_band: "7" }],
    ["an unknown scheme", { ...FILTER, scheme: "ngss" }],
    ["a unit list over the cap", { ...FILTER, unit_list: "x".repeat(20001) }],
  ])("400 invalid_body: %s", async (_label, extra) => {
    const a = await makeAssessment();
    const res = await post({ assessment_id: a.id, ...extra });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; detail: string };
    expect(body.error).toBe("invalid_body");
    expect(body.detail.length).toBeGreaterThan(0);
  });

  test("400 when the grade band has no standards (no free-form suggestions)", async () => {
    const a = await makeAssessment();
    await addItems(a.id, ["Q"]);
    const res = await post({ assessment_id: a.id, subject: "math", grade_band: "13" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { detail: string }).detail).toMatch(/no standards/);
  });

  test("400 when the body is not JSON", async () => {
    const { POST } = await import("../app/api/ai/suggest-standards/route");
    const res = await POST(
      new Request("http://localhost/api/ai/suggest-standards", { method: "POST", body: "not json" }),
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /api/ai/suggest-standards — suggestions", () => {
  test("200: only untagged items, catalog tags, ≤ 3 each, nothing written", async () => {
    const a = await makeAssessment();
    const rows = await addItems(a.id, ["Ratio question", "Already tagged", "Sample question"], {
      1: ["wa2026:M.7.R.RP.2"],
    });
    const res = await post({ assessment_id: a.id, ...FILTER });
    expect(res.status).toBe(200);
    const body = (await res.json()) as OkBody;
    expect(body).toMatchObject({ ok: true, considered: 2, left_out: 0, provider: "mock" });
    expect(body.suggestions.map((s) => s.item_id)).toEqual([rows[0]!.id, rows[2]!.id]);
    for (const s of body.suggestions) {
      expect(s.tags.length).toBeGreaterThan(0);
      expect(s.tags.length).toBeLessThanOrEqual(3);
      for (const t of s.tags) {
        expect(t.tag).toMatch(/^wa2026:M\.7\./);
        expect(t.reason.length).toBeGreaterThan(0);
      }
    }
    const stored = await getDb().select({ id: items.id, standards: items.standards }).from(items).where(eq(items.assessment_id, a.id));
    expect(stored.find((r) => r.id === rows[0]!.id)!.standards).toEqual([]);
  });

  test("the scheme preference picks the candidate set (2011 codes)", async () => {
    const a = await makeAssessment();
    await addItems(a.id, ["Q"]);
    const res = await post({ assessment_id: a.id, ...FILTER, scheme: "ccss2010" });
    const body = (await res.json()) as OkBody;
    expect(body.suggestions[0]!.tags.every((t) => t.tag.startsWith("ccss2010:7."))).toBe(true);
  });

  test("science suggests NGSS whatever the scheme says", async () => {
    const a = await makeAssessment();
    await addItems(a.id, ["Q"]);
    const res = await post({ assessment_id: a.id, subject: "science", grade_band: "HS", scheme: "ccss2010" });
    const body = (await res.json()) as OkBody;
    expect(body.suggestions[0]!.tags.every((t) => t.tag.startsWith("ngss:"))).toBe(true);
  });

  test("a pasted unit list narrows the candidates to the codes it names", async () => {
    const a = await makeAssessment();
    await addItems(a.id, ["One", "Two", "Three"]);
    const res = await post({ assessment_id: a.id, ...FILTER, unit_list: "Unit: M.7.R.RP.2 and M.7.DA.DS.1" });
    const body = (await res.json()) as OkBody;
    const tags = new Set(body.suggestions.flatMap((s) => s.tags.map((t) => t.tag)));
    expect([...tags].every((t) => t === "wa2026:M.7.R.RP.2" || t === "wa2026:M.7.DA.DS.1")).toBe(true);
  });

  test("a code outside the candidate set is dropped, the rest stay", async () => {
    const a = await makeAssessment();
    await addItems(a.id, ["One"]);
    const res = await post({ assessment_id: a.id, ...FILTER, unit_list: "MOCK_OUT_OF_CATALOG" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as OkBody;
    expect(body.suggestions[0]!.tags.map((t) => t.tag)).not.toContain("NOT.A.REAL.CODE");
    expect(body.suggestions[0]!.tags).toHaveLength(2);
  });

  test("zero untagged items → 200 with nothing suggested and no model call", async () => {
    const a = await makeAssessment();
    await addItems(a.id, ["A", "B"], { 0: ["x"], 1: ["y"] });
    // MOCK_MALFORMED would be a 502 if the provider were called.
    const res = await post({ assessment_id: a.id, ...FILTER, unit_list: "MOCK_MALFORMED" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, suggestions: [], considered: 0, left_out: 0 });
    // An assessment with no items at all is the same answer.
    const empty = await makeAssessment();
    expect((await post({ assessment_id: empty.id, ...FILTER })).status).toBe(200);
  });

  test("more than 40 untagged items: the first 40 in item order, the rest counted as left out", async () => {
    const a = await makeAssessment();
    const rows = await addItems(a.id, Array.from({ length: 45 }, (_, i) => `Question ${i + 1}`));
    const res = await post({ assessment_id: a.id, ...FILTER });
    const body = (await res.json()) as OkBody;
    expect(body.considered).toBe(40);
    expect(body.left_out).toBe(5);
    const ids = new Set(body.suggestions.map((s) => s.item_id));
    expect(ids.has(rows[39]!.id)).toBe(true);
    expect(ids.has(rows[40]!.id)).toBe(false);
  });

  test("works on a Published assessment (tags stay editable while Published)", async () => {
    const a = await makeAssessment({ status: "published" });
    await addItems(a.id, ["One"]);
    expect((await post({ assessment_id: a.id, ...FILTER })).status).toBe(200);
  });

  test("a reply that is not a JSON array → 502 provider_failed", async () => {
    const a = await makeAssessment();
    await addItems(a.id, ["One"]);
    const res = await post({ assessment_id: a.id, ...FILTER, unit_list: "MOCK_MALFORMED" });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string; detail: string };
    expect(body.error).toBe("provider_failed");
    expect(body.detail).toMatch(/invalid_json/);
  });
});

describe("POST /api/ai/suggest-standards — guardrail (GUARDRAIL_PROVIDER=mock)", () => {
  test("blocked unit list → 422 stage input, model not called, one event", async () => {
    process.env.GUARDRAIL_PROVIDER = "mock";
    const a = await makeAssessment();
    await addItems(a.id, ["One"]);
    const res = await post({ assessment_id: a.id, ...FILTER, unit_list: "BLOCKME MOCK_MALFORMED" });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; stage: string; note: string };
    expect(body).toMatchObject({ error: "guardrail_blocked", stage: "input" });
    expect(body.note).toMatch(/safeguards/i);
    const events = await getDb().select().from(guardrail_events);
    expect(events.map((e) => [e.surface, e.stage, e.action])).toEqual([["tag-suggest", "input", "block"]]);
  });

  test("blocked output → 422 stage output (the mock's reason echoes the stem)", async () => {
    process.env.GUARDRAIL_PROVIDER = "mock";
    const a = await makeAssessment();
    await addItems(a.id, ["BLOCKME stem"]);
    const res = await post({ assessment_id: a.id, ...FILTER });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { stage: string }).stage).toBe("output");
    // No unit list = no input stage.
    const events = await getDb().select().from(guardrail_events);
    expect(events.map((e) => [e.surface, e.stage, e.action])).toEqual([["tag-suggest", "output", "block"]]);
  });

  test("allowed run records input + output events on the tag-suggest surface", async () => {
    process.env.GUARDRAIL_PROVIDER = "mock";
    const a = await makeAssessment();
    await addItems(a.id, ["One"]);
    const res = await post({ assessment_id: a.id, ...FILTER, unit_list: "M.7.R.RP.2" });
    expect(res.status).toBe(200);
    const events = await getDb().select().from(guardrail_events);
    expect(events.map((e) => [e.surface, e.stage, e.action]).sort()).toEqual([
      ["tag-suggest", "input", "allow"],
      ["tag-suggest", "output", "allow"],
    ]);
  });
});

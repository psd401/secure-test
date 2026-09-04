// Slice 28: DB-backed end-to-end safeguarding test. Drives the real
// generate-item route with GUARDRAIL_PROVIDER=mock so the input/output
// checks run AND the real recordGuardrailEvent writes to guardrail_events.
// Requires the test DB (DATABASE_URL), like the other *-api suites.
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { closeDb, getDb } from "../db/client";
import { assessments, guardrail_events } from "../db/schema";
import { SESSION_COOKIE_NAME } from "../lib/auth/session";
import * as sessionMod from "../lib/auth/session";
import { recordGuardrailEvent } from "../lib/safeguarding/telemetry";

const expectTestDb = () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("secure_test_design_tool_test")) {
    throw new Error(`safeguarding-route tests require the test DB; got ${url}`);
  }
};

let originalSessionSecret: string | undefined;
let originalGuardrail: string | undefined;
let mockSub: string | null = null;

mock.module("next/headers", () => ({
  // Slice 58: requireSession now reads an Authorization bearer header as
  // well as the cookie, so the mocked module has to provide headers().
  headers: async () => new Headers(),
  cookies: async () => ({
    get: (name: string) =>
      mockSub && name === SESSION_COOKIE_NAME ? { value: "x" } : undefined,
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
  originalGuardrail = process.env.GUARDRAIL_PROVIDER;
  process.env.GUARDRAIL_PROVIDER = "mock";
});

afterEach(async () => {
  const db = getDb();
  await db.execute(
    sql`truncate table assessments, guardrail_events restart identity cascade`,
  );
});

afterAll(async () => {
  await closeDb();
  if (originalSessionSecret === undefined) {
    delete process.env.DESIGN_TOOL_SESSION_SECRET;
  } else {
    process.env.DESIGN_TOOL_SESSION_SECRET = originalSessionSecret;
  }
  if (originalGuardrail === undefined) delete process.env.GUARDRAIL_PROVIDER;
  else process.env.GUARDRAIL_PROVIDER = originalGuardrail;
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

async function makeAssessment(owner_sub: string) {
  const db = getDb();
  const [row] = await db
    .insert(assessments)
    .values({
      owner_sub,
      name: "Guardrail test",
      description: "",
      allow_llm_authoring: true,
    })
    .returning();
  return row!;
}

describe("recordGuardrailEvent (real recorder)", () => {
  test("round-trips an event including findings jsonb", async () => {
    await recordGuardrailEvent({
      owner_sub: "teacher-1",
      surface: "item-gen",
      stage: "output",
      action: "block",
      provider_id: "mock",
      findings: [{ type: "pii", detail: "ssn_shape" }],
      text_snippet: "contains 123-45-6789",
    });
    const db = getDb();
    const rows = await db
      .select()
      .from(guardrail_events)
      .where(eq(guardrail_events.owner_sub, "teacher-1"));
    expect(rows.length).toBe(1);
    expect(rows[0]!.action).toBe("block");
    expect(rows[0]!.findings).toEqual([{ type: "pii", detail: "ssn_shape" }]);
  });
});

describe("POST /api/ai/generate-item with GUARDRAIL_PROVIDER=mock", () => {
  test("blocked input → 422 guardrail_blocked + one input block event", async () => {
    asUser("teacher-1");
    const a = await makeAssessment("teacher-1");
    const res = await postGenerate({
      assessment_id: a.id,
      item_type: "multiple_choice_single",
      prompt: "Write a BLOCKME question",
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      error: string;
      stage: string;
      note: string;
    };
    expect(body.error).toBe("guardrail_blocked");
    expect(body.stage).toBe("input");
    expect(body.note).toMatch(/safeguards/i);

    const db = getDb();
    const events = await db.select().from(guardrail_events);
    expect(events.length).toBe(1);
    expect([events[0]!.stage, events[0]!.action]).toEqual(["input", "block"]);
  });

  test("clean prompt → 200 + two allow events (input, output)", async () => {
    asUser("teacher-1");
    const a = await makeAssessment("teacher-1");
    const res = await postGenerate({
      assessment_id: a.id,
      item_type: "multiple_choice_single",
      prompt: "Draft a question about photosynthesis.",
    });
    expect(res.status).toBe(200);

    const db = getDb();
    const events = await db
      .select()
      .from(guardrail_events)
      .orderBy(guardrail_events.created_at);
    expect(events.map((e) => [e.stage, e.action])).toEqual([
      ["input", "allow"],
      ["output", "allow"],
    ]);
    expect(events.every((e) => e.surface === "item-gen")).toBe(true);
  });
});

// Rubric upload slice 1 (docs/rubric-upload-design.md): the extract route,
// driven by the mock provider. No module mocking of the extractor — that
// leaks across files in bun — so the route runs its true path; the mock
// fails on markers in the text / file name, the way mockPdfExtractor does.
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { closeDb, getDb } from "../db/client";
import { guardrail_events, items } from "../db/schema";
import { SESSION_COOKIE_NAME } from "../lib/auth/session";
import * as sessionMod from "../lib/auth/session";

const expectTestDb = () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("secure_test_design_tool_test")) {
    throw new Error(`rubric-extract route tests require the test DB DATABASE_URL; got: ${url}`);
  }
};

let originalSessionSecret: string | undefined;
let mockSub: string | null = null;

mock.module("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({
    get: (name: string) => (mockSub && name === SESSION_COOKIE_NAME ? { value: "x" } : undefined),
  }),
}));

mock.module("../lib/auth/session", () => ({
  ...sessionMod,
  readSessionFromCookies: async () => (mockSub ? { sub: mockSub, role: "staff" } : null),
}));

const OWNER = "rubric-extract-teacher";

beforeAll(() => {
  expectTestDb();
  originalSessionSecret = process.env.DESIGN_TOOL_SESSION_SECRET;
  process.env.DESIGN_TOOL_SESSION_SECRET = "test-session-secret-do-not-use";
  mockSub = OWNER;
});

afterEach(async () => {
  mockSub = OWNER;
  delete process.env.GUARDRAIL_PROVIDER;
  delete process.env.MOCK_RUBRIC_STYLE;
  const db = getDb();
  await db.execute(sql`truncate table assessments restart identity cascade`);
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

async function createAssessment(name: string) {
  const { POST } = await import("../app/api/assessments/route");
  const res = await POST(
    new Request("http://localhost/api/assessments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    }),
  );
  return ((await res.json()) as { assessment: { id: string } }).assessment.id;
}

async function postFile(
  id: string,
  bytes: Uint8Array,
  fileName = "rubric.pdf",
  type = "application/pdf",
) {
  const { POST } = await import("../app/api/assessments/[id]/rubrics/extract/route");
  const form = new FormData();
  form.append("file", new File([bytes as BlobPart], fileName, { type }));
  return POST(
    new Request(`http://localhost/api/assessments/${id}/rubrics/extract`, {
      method: "POST",
      body: form,
    }),
    { params: Promise.resolve({ id }) },
  );
}

async function postText(id: string, text: string) {
  const { POST } = await import("../app/api/assessments/[id]/rubrics/extract/route");
  return POST(
    new Request(`http://localhost/api/assessments/${id}/rubrics/extract`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    }),
    { params: Promise.resolve({ id }) },
  );
}

const PDF_BYTES = new TextEncoder().encode("%PDF-1.4 a rubric lives here");

interface OkBody {
  ok: boolean;
  rubric: {
    style: string;
    criteria: { id: string; name: string; levels: { id: string; points: number }[] }[];
  };
  warnings: { code: string; message: string }[];
  source: { kind: string; bytes?: number; chars?: number; format?: string };
}

describe("POST assessments/[id]/rubrics/extract", () => {
  test("owner, PDF file → 200 with a validated rubric, warnings, and writes nothing", async () => {
    const id = await createAssessment("Rubric");
    const res = await postFile(id, PDF_BYTES);
    expect(res.status).toBe(200);
    const body = (await res.json()) as OkBody;
    expect(body.ok).toBe(true);
    expect(body.rubric.style).toBe("analytic");
    expect(body.rubric.criteria.map((c) => c.name)).toEqual(["Claim", "Evidence"]);
    // The fixture leaves points out on both criteria, so the ladder ran.
    expect(body.rubric.criteria[1]!.levels.map((l) => l.points)).toEqual([3, 2, 1, 0]);
    expect(body.warnings.map((w) => w.code)).toContain("points_assigned");
    expect(body.source).toEqual({ kind: "file", bytes: PDF_BYTES.byteLength, format: "pdf" });
    const db = getDb();
    expect(await db.select().from(items).where(eq(items.assessment_id, id))).toHaveLength(0);
  });

  test("JSON text path → 200; source reports the character count", async () => {
    const id = await createAssessment("Pasted");
    const res = await postText(id, "Claim | Evidence | pasted rubric table");
    expect(res.status).toBe(200);
    const body = (await res.json()) as OkBody;
    expect(body.rubric.criteria).toHaveLength(2);
    expect(body.source).toEqual({ kind: "text", chars: "Claim | Evidence | pasted rubric table".length });
  });

  test("a .md file takes the text path (format md, guardrail input stage runs)", async () => {
    process.env.GUARDRAIL_PROVIDER = "mock";
    const id = await createAssessment("Markdown");
    const res = await postFile(
      id,
      new TextEncoder().encode("| Claim | 4 | 3 |"),
      "rubric.md",
      "text/markdown",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as OkBody;
    expect(body.source.format).toBe("md");
    const events = await getDb().select().from(guardrail_events);
    expect(events.map((e) => e.stage).sort()).toEqual(["input", "output"]);
    expect(events.every((e) => e.surface === "rubric-extract")).toBe(true);
  });

  test("the document path skips the guardrail input stage; the output stage still blocks", async () => {
    process.env.GUARDRAIL_PROVIDER = "mock";
    const id = await createAssessment("Blocked");
    // The mock echoes BLOCKME from the file name into a descriptor, which
    // the mock guardrail's output check refuses.
    const res = await postFile(id, PDF_BYTES, "BLOCKME.pdf");
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; stage: string };
    expect(body.error).toBe("blocked_by_guardrail");
    expect(body.stage).toBe("output");
    const events = await getDb().select().from(guardrail_events);
    // Exactly one event, and it is the output check — no input-stage row
    // proves the pre-model check was skipped on the document path.
    expect(events).toHaveLength(1);
    expect(events[0]!.stage).toBe("output");
    expect(events[0]!.action).toBe("block");
  });

  test("MOCK_RUBRIC_STYLE knob reaches the holistic and single-point branches", async () => {
    const id = await createAssessment("Styles");
    process.env.MOCK_RUBRIC_STYLE = "holistic";
    const holistic = (await (await postFile(id, PDF_BYTES)).json()) as OkBody;
    expect(holistic.rubric.style).toBe("holistic");
    expect(holistic.rubric.criteria).toHaveLength(1);
    expect(holistic.rubric.criteria[0]!.levels.map((l) => l.points)).toEqual([3, 2, 1, 0]);

    process.env.MOCK_RUBRIC_STYLE = "single_point";
    const single = (await (await postFile(id, PDF_BYTES)).json()) as OkBody;
    expect(single.rubric.style).toBe("single_point");
    expect(single.rubric.criteria.map((c) => c.levels[0]!.points)).toEqual([1, 1]);
  });

  test("unsupported file type → 415", async () => {
    const id = await createAssessment("Wrong type");
    const res = await postFile(id, PDF_BYTES, "rubric.pages", "application/x-iwork-pages-sffpages");
    expect(res.status).toBe(415);
    const body = (await res.json()) as { error: string; allowed: string[] };
    expect(body.error).toBe("unsupported_type");
    expect(body.allowed).toEqual(["pdf", "docx", "md", "txt"]);
  });

  test("a file over 5 MiB → 413", async () => {
    const id = await createAssessment("Too big");
    const res = await postFile(id, new Uint8Array(5 * 1024 * 1024 + 1));
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: string; limit: number };
    expect(body.error).toBe("file_too_large");
    expect(body.limit).toBe(5 * 1024 * 1024);
  });

  test("an empty or oversized text body → 400", async () => {
    const id = await createAssessment("Bad body");
    expect((await postText(id, "")).status).toBe(400);
    expect((await postText(id, "x".repeat(200_001))).status).toBe(400);
  });

  test("model output no rubric can be made of → 422 rubric_extract_invalid_output with issues", async () => {
    const id = await createAssessment("Invalid");
    const res = await postText(id, "RETURN_INVALID");
    expect(res.status).toBe(422);
    const body = (await res.json()) as { ok: boolean; error: string; hint: string; issues: string[] };
    expect(body.ok).toBe(false);
    expect(body.error).toBe("rubric_extract_invalid_output");
    expect(body.hint).toMatch(/paste the rubric/);
    expect(body.issues.length).toBeGreaterThan(0);
  });

  test("truncated output → 422 rubric_extract_truncated", async () => {
    const id = await createAssessment("Truncated");
    const res = await postText(id, "THROW_TRUNCATED");
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; hint: string; detail: string };
    expect(body.error).toBe("rubric_extract_truncated");
    expect(body.detail).toMatch(/token cap/);
  });

  test("provider outage → 502 rubric_extract_failed, never an empty body", async () => {
    const id = await createAssessment("Outage");
    const res = await postText(id, "THROW_PROVIDER");
    expect(res.status).toBe(502);
    const body = (await res.json()) as { ok: boolean; error: string; detail: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe("rubric_extract_failed");
    expect(body.detail).toMatch(/simulated provider outage/);
  });

  test("published assessment → 409 (draft-locked)", async () => {
    const id = await createAssessment("Locked");
    const { PATCH } = await import("../app/api/assessments/[id]/route");
    await PATCH(
      new Request(`http://localhost/api/assessments/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "published" }),
      }),
      { params: Promise.resolve({ id }) },
    );
    expect((await postFile(id, PDF_BYTES)).status).toBe(409);
  });

  test("another teacher → 403; a missing assessment → 404", async () => {
    const id = await createAssessment("Owned");
    mockSub = "someone-else";
    expect((await postFile(id, PDF_BYTES)).status).toBe(403);
    mockSub = OWNER;
    const missing = await postFile("11111111-1111-4111-8111-111111111111", PDF_BYTES);
    expect(missing.status).toBe(404);
  });
});

// Editor redesign Phase 7 slice B (R-10): Word (.docx) item import through
// the PDF import route, flag on only. Hand-built .docx fixtures
// (test/helpers/docx.ts); the extractor is the deterministic mock provider
// (PDF_EXTRACTOR_PROVIDER unset = "mock"), so no Bedrock call is made. The
// mock reads the same segment convention as the PDF tests, out of the text
// the route read from the document.
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { closeDb, getDb } from "../db/client";
import { guardrail_events, items } from "../db/schema";
import { SESSION_COOKIE_NAME, type SessionPayload } from "../lib/auth/session";
import * as sessionMod from "../lib/auth/session";
import { setNewAuthoring } from "../lib/authoring/flag";
import { MAX_UPLOAD_BYTES } from "../lib/ai/documentUpload";
import { regionBlockRange, type WordBlock } from "../lib/docxImport/document";
import type { CandidateRegion } from "../lib/pdfImport/regions";
import { DOCX_MIME, PICTURE_RUN, makeDocx, para, run, table } from "./helpers/docx";

const expectTestDb = () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("secure_test_design_tool_test")) {
    throw new Error(`docx-import-route tests require the test DB DATABASE_URL; got: ${url}`);
  }
};

let mockSub: string | null = null;
let originalSessionSecret: string | undefined;

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

const OWNER = "docx-import-teacher";

beforeAll(() => {
  expectTestDb();
  originalSessionSecret = process.env.DESIGN_TOOL_SESSION_SECRET;
  process.env.DESIGN_TOOL_SESSION_SECRET = "test-session-secret-do-not-use";
  mockSub = OWNER;
});

afterEach(async () => {
  mockSub = OWNER;
  delete process.env.GUARDRAIL_PROVIDER;
  const db = getDb();
  await db.execute(sql`truncate table assessments restart identity cascade`);
  await db.execute(sql`truncate table guardrail_events restart identity cascade`);
  await db.execute(sql`truncate table staff_preferences`);
});

afterAll(async () => {
  await closeDb();
  if (originalSessionSecret === undefined) delete process.env.DESIGN_TOOL_SESSION_SECRET;
  else process.env.DESIGN_TOOL_SESSION_SECRET = originalSessionSecret;
});

async function flagOn() {
  await setNewAuthoring(getDb(), { sub: OWNER, role: "staff" } as SessionPayload, true);
}

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

async function postDocx(id: string, bytes: Uint8Array, fileName = "unit test.docx", type = DOCX_MIME) {
  const { POST } = await import("../app/api/assessments/[id]/items/import-pdf/route");
  const form = new FormData();
  form.append("file", new File([bytes as BlobPart], fileName, { type }));
  return POST(
    new Request(`http://localhost/api/assessments/${id}/items/import-pdf`, { method: "POST", body: form }),
    { params: Promise.resolve({ id }) },
  );
}

interface Body {
  ok: boolean;
  error?: string;
  hint?: string;
  source_kind: "pdf" | "docx";
  page_count: number;
  ocr_used: boolean;
  candidates: { type: string; stem: string }[];
  rejected_count: number;
  source_numbers: number[][];
  regions: (CandidateRegion | null)[];
  pages: unknown[];
  figures: unknown[];
  numbered_items: number | null;
  unconverted: { region: unknown }[];
  document?: { blocks: WordBlock[]; pictures: number };
}

// Auto-numbered questions, one per paragraph, in the mock's convention; the
// MC comes last because the mock reads a segment up to the next one.
const QUESTIONS = [
  para("Unit 3 check", { style: "Heading1" }),
  para([run("Answer "), run("every", { b: true }), run(" question.")]),
  para("ES: #1 Explain how plants use light, in your own words.", { num: { id: 1 } }),
  para("ST: #2 Name the capital of Washington. | Olympia", { num: { id: 1 } }),
  table([
    ["Planet", "Moons"],
    ["Mars", "2"],
  ]),
  `<w:p>${run("3. MC: #3 Which number is even? | a:3 | b:4 | *b")}${PICTURE_RUN}</w:p>`,
];

describe("POST items/import-pdf with a Word document (R-10)", () => {
  test("flag on: candidates, document blocks, regions over blocks, writes nothing", async () => {
    await flagOn();
    const id = await createAssessment("Word import");
    // Question 3 has a typed number; 1 and 2 are Word's own list numbers.
    const res = await postDocx(id, makeDocx(QUESTIONS));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Body;
    expect(body.ok).toBe(true);
    expect(body.source_kind).toBe("docx");
    expect(body.ocr_used).toBe(false);
    expect(body.figures).toEqual([]);
    expect(body.pages).toEqual([]);
    expect(body.candidates.map((c) => c.type)).toEqual(["essay", "short_text", "multiple_choice_single"]);
    expect(body.source_numbers).toEqual([[1], [2], [3]]);
    // The document's own numbering was read (list numbers written out).
    expect(body.numbered_items).toBe(3);
    // The left pane's data: 6 blocks, the picture counted.
    expect(body.document!.blocks.map((b) => b.kind)).toEqual([
      "paragraph",
      "paragraph",
      "paragraph",
      "paragraph",
      "table",
      "paragraph",
    ]);
    expect(body.document!.pictures).toBe(1);
    // Each question's region covers its own blocks; question 2 runs on
    // through the table to the next numbered paragraph.
    const ranges = body.regions.map((r) => r && regionBlockRange(r, body.document!.blocks.length));
    expect(ranges).toEqual([
      { start: 2, end: 3 },
      { start: 3, end: 5 },
      { start: 5, end: 6 },
    ]);
    expect(await getDb().select().from(items).where(eq(items.assessment_id, id))).toHaveLength(0);
  });

  test("flag off: a .docx is refused exactly as before (the PDF reader)", async () => {
    const id = await createAssessment("Flag off");
    const res = await postDocx(id, makeDocx(QUESTIONS));
    expect(res.status).toBe(400);
    expect(((await res.json()) as Body).error).toBe("pdf_parse_failed");
  });

  // (A file with no extension is recognised by its type in a browser, but
  // bun's multipart round trip drops the type of such a file, so that case
  // is a hand check, not a test.)
  test("an upper-case .DOCX extension takes the Word path", async () => {
    await flagOn();
    const id = await createAssessment("Upper case");
    const res = await postDocx(id, makeDocx(QUESTIONS), "UNIT TEST.DOCX");
    expect(res.status).toBe(200);
    expect(((await res.json()) as Body).source_kind).toBe("docx");
  });

  test("over the 5 MiB document cap → 413 with a hint", async () => {
    await flagOn();
    const id = await createAssessment("Too big");
    const big = new Uint8Array(MAX_UPLOAD_BYTES + 1);
    const res = await postDocx(id, big);
    expect(res.status).toBe(413);
    const body = (await res.json()) as Body & { limit: number };
    expect(body.error).toBe("file_too_large");
    expect(body.limit).toBe(MAX_UPLOAD_BYTES);
    expect(body.hint).toContain("5 MB");
  });

  test("not a Word document inside → 400 docx_parse_failed with a hint", async () => {
    await flagOn();
    const id = await createAssessment("Broken");
    const res = await postDocx(id, new TextEncoder().encode("this is not a zip"));
    expect(res.status).toBe(400);
    const body = (await res.json()) as Body;
    expect(body.error).toBe("docx_parse_failed");
    expect(body.hint).toContain(".docx");
  });

  test("a document with no text → 400 with a Word hint", async () => {
    await flagOn();
    const id = await createAssessment("Empty");
    const res = await postDocx(id, makeDocx([para("")]));
    expect(res.status).toBe(400);
    const body = (await res.json()) as Body;
    expect(body.error).toBe("text_too_large_or_empty");
    expect(body.hint).toContain("Word document");
  });

  test("guardrail: the document's text is screened at input (recorded), proposals blocked at output", async () => {
    process.env.GUARDRAIL_PROVIDER = "mock";
    await flagOn();
    const id = await createAssessment("Blocked");
    const res = await postDocx(
      id,
      makeDocx([para("MC: Fine | a:1 | b:2 | *a"), para("MC: BLOCKME sensitive | a:1 | b:2 | *a")]),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as Body & { stage: string };
    expect(body.error).toBe("blocked_by_guardrail");
    expect(body.stage).toBe("output");
    expect(body.hint).toContain("Word document");
    const db = getDb();
    const input = await db.select().from(guardrail_events).where(eq(guardrail_events.stage, "input"));
    expect(input).toHaveLength(1);
    expect(input[0]!.action).toBe("flag");
    expect(input[0]!.surface).toBe("pdf-import");
  });

  test("published assessment → 409; another teacher's → 404", async () => {
    await flagOn();
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
    expect((await postDocx(id, makeDocx(QUESTIONS))).status).toBe(409);
    const other = await createAssessment("Mine");
    mockSub = "someone-else";
    expect((await postDocx(other, makeDocx(QUESTIONS))).status).toBe(404);
  });

  test("a PDF with the flag on is unchanged: source_kind pdf, no document", async () => {
    await flagOn();
    const id = await createAssessment("PDF still");
    const { makeTextPdf } = await import("./helpers/pdf");
    const res = await postDocx(id, makeTextPdf(["MC: What is 2+2? | a:3 | b:4 | *b", "ES: Discuss photosynthesis at length."]), "t.pdf", "application/pdf");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Body;
    expect(body.source_kind).toBe("pdf");
    expect(body.document).toBeUndefined();
    expect(body.pages.length).toBe(1);
  });
});

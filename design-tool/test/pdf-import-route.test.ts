// Slice 42: PDF import route, driven by REAL text-layer extraction (unpdf)
// via minimal generated PDFs. No module mocking of the extractor — that
// leaks across files in bun — so the route runs its true extraction path.
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { closeDb, getDb } from "../db/client";
import { guardrail_events, items } from "../db/schema";
import { MAX_OCR_BYTES, MAX_OCR_PAGES } from "../lib/pdfImport/extractCore";
import { SESSION_COOKIE_NAME } from "../lib/auth/session";
import * as sessionMod from "../lib/auth/session";

import { makeEmptyPagesPdf, makeTextAndImagePdf, makeTextPdf } from "./helpers/pdf";

const expectTestDb = () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("secure_test_design_tool_test")) {
    throw new Error(`pdf-import-route tests require the test DB DATABASE_URL; got: ${url}`);
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

const OWNER = "pdf-import-teacher";

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

async function postPdf(id: string, bytes: Uint8Array, fileName = "test.pdf") {
  const { POST } = await import(
    "../app/api/assessments/[id]/items/import-pdf/route"
  );
  const form = new FormData();
  form.append(
    "file",
    new File([bytes as BlobPart], fileName, { type: "application/pdf" }),
  );
  return POST(
    new Request(`http://localhost/api/assessments/${id}/items/import-pdf`, {
      method: "POST",
      body: form,
    }),
    { params: Promise.resolve({ id }) },
  );
}

const GOOD_LINES = [
  "MC: What is 2+2? | a:3 | b:4 | *b",
  "ST: Capital of France? | Paris",
  "ES: Discuss photosynthesis.",
  "MC: Bad one | a:only | *a", // 1 choice → rejected by CreateItemBody
];

describe("POST items/import-pdf", () => {
  test("returns validated candidates, reports rejected, writes nothing", async () => {
    const id = await createAssessment("PDF");
    const res = await postPdf(id, makeTextPdf(GOOD_LINES));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      candidates: { type: string }[];
      rejected_count: number;
      page_count: number;
      ocr_used: boolean;
    };
    expect(body.page_count).toBe(1);
    expect(body.ocr_used).toBe(false);
    expect(body.candidates.map((c) => c.type)).toEqual([
      "multiple_choice_single",
      "short_text",
      "essay",
    ]);
    expect(body.rejected_count).toBe(1); // the 1-choice MC
    const db = getDb();
    expect(await db.select().from(items).where(eq(items.assessment_id, id))).toHaveLength(0);
  });

  // E1/E2/E8 (2026-09-01): match + drawing candidates come through, and the
  // response compares the PDF's own numbering with what was extracted.
  test("match/drawing candidates, numbering report with missing numbers, match adds", async () => {
    const id = await createAssessment("Numbered");
    const res = await postPdf(
      id,
      makeTextPdf([
        // The document numbers six questions; the mock returns a match set
        // covering 1-2, an E4-style double for 3 (typed work = essay + the
        // final answer), a graph for 4, and 5 — 6 is missing.
        "Unit test 1. 2. 3. 4. 5. 6.",
        "MA: #1-2 Match the organelle to its job | mitochondria=ATP | ribosome=protein",
        "ES: #3 Show your work: solve 2x = 4.",
        "ST: #3 Final answer: solve 2x = 4 | 2",
        "DR: #4 Graph the line y = 2x.",
        "MC: #5 What is 2+2? | a:3 | b:4 | *b",
      ]),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      candidates: { type: string; pairs?: { id: string }[] }[];
      numbered_items: number | null;
      extracted_count: number;
      missing_numbers: number[] | null;
      shortfall: boolean;
    };
    expect(body.candidates.map((c) => c.type)).toEqual([
      "match",
      "essay",
      "short_text",
      "drawing_upload",
      "multiple_choice_single",
    ]);
    expect(body.candidates[0]!.pairs!.map((p) => p.id)).toEqual(["p1", "p2"]);
    expect(body.numbered_items).toBe(6);
    expect(body.extracted_count).toBe(5);
    expect(body.missing_numbers).toEqual([6]);
    expect(body.shortfall).toBe(true);

    // The match candidate is addable as-is through the normal item path
    // (the panel posts the validated candidate unchanged).
    const { POST: createItem } = await import("../app/api/assessments/[id]/items/route");
    const add = await createItem(
      new Request(`http://localhost/api/assessments/${id}/items`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body.candidates[0]),
      }),
      { params: Promise.resolve({ id }) },
    );
    expect(add.status).toBe(201);
    const db = getDb();
    const rows = await db.select().from(items).where(eq(items.assessment_id, id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.type).toBe("match");
  });

  // E5 slice 4: figures ride the response with a page and a data URL; the
  // model's text carries [FIGURE n] where each sits (the mock ignores it).
  test("figures in the response on the text path; none on the scanned path", async () => {
    const id = await createAssessment("Figures");
    const res = await postPdf(
      id,
      makeTextAndImagePdf(
        ["1. 2. 3.", "MC: #1 What is 2+2? | a:3 | b:4 | *b", "ST: #2 Capital of France? | Paris", "ES: #3 Discuss."],
        { x: 100, y: 560, width: 120, height: 90 },
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      candidates: { type: string }[];
      figures: { n: number; page: number; width_px: number; data_url: string | null }[];
      figure_count: number;
    };
    expect(body.candidates).toHaveLength(3);
    expect(body.figure_count).toBe(1);
    expect(body.figures[0]).toMatchObject({ n: 1, page: 1, width_px: 2 });
    expect(body.figures[0]!.data_url?.startsWith("data:image/png;base64,")).toBe(true);

    const scanned = await postPdf(id, makeTextPdf([]), "scan.pdf");
    const sbody = (await scanned.json()) as { figures: unknown[]; figure_count: number };
    expect(sbody.figures).toEqual([]);
    expect(sbody.figure_count).toBe(0);
  });

  // E5 slice 3: the model's sets come back over validated indexes with their
  // figures; a figure the model did not place pairs with the question below it.
  test("proposed sets: model pairing remapped past a rejected candidate, adjacency fallback for the rest", async () => {
    const id = await createAssessment("Sets");
    // Lines sit 16 pt apart from baseline 720; the image (bottom 640, 50 tall,
    // top 690) lands between line 2 (baseline 704) and line 3 (688), i.e.
    // between the rejected MC and "2. Second" — the figure's first following
    // numbered question is 2.
    const res = await postPdf(
      id,
      makeTextAndImagePdf(
        [
          "1. First",
          "MC: #1 Bad one | a:only | *a", // 1 choice → rejected → raw 0 gone
          "2. Second",
          "ST: #2 Two | t",
          "3. Third",
          "ES: #3 Three",
          "4. Fourth",
          "ES: #4 Four",
          "SET: #3-4 | Read the passage first.",
        ],
        { x: 100, y: 640, width: 100, height: 50 },
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      candidates: { type: string }[];
      rejected_count: number;
      figure_count: number;
      proposed_sets: { id: string; stimulus: string; figures: number[]; item_indexes: number[]; source: string }[];
      rejected_sets: unknown[];
    };
    expect(body.candidates.map((c) => c.type)).toEqual(["short_text", "essay", "essay"]);
    expect(body.rejected_count).toBe(1);
    expect(body.figure_count).toBe(1);
    expect(body.rejected_sets).toEqual([]);
    // Model set over #3-4 → raw indexes 2,3 → validated 1,2.
    expect(body.proposed_sets[0], JSON.stringify(body.proposed_sets)).toMatchObject({ stimulus: "Read the passage first.", figures: [], item_indexes: [1, 2], source: "model" });
    // The figure sits above "2." → adjacency pairs it with the short_text (validated 0).
    expect(body.proposed_sets[1]).toMatchObject({ figures: [1], item_indexes: [0], source: "adjacency" });
  });

  // Multi-source stimulus slice 3 (docs/multi-source-stimulus-design.md):
  // the AP Seminar shape — one essay prompt plus labelled sources printed
  // after it. The sources ride the response with the card's layout default,
  // and the shortened check compares each against the document's own span.
  // The SET line comes FIRST so the two source headings below it bound each
  // other's span (the last source's span runs to the end of the document).
  // makeTextPdf draws Helvetica 12pt from x=72 on a 612pt page, so a line
  // past ~98 characters runs off the page and comes back clipped — every
  // line below stays well inside that.
  test("sources on a proposed set: side_by_side layout, shortened flagged against the document span", async () => {
    const id = await createAssessment("Sources");
    const SOURCE_A_LINE =
      "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike";
    const SOURCE_B_LINE = "quebec romeo sierra";
    const res = await postPdf(
      id,
      makeTextPdf([
        // Source A comes back as one word of a long paragraph → shortened;
        // Source B comes back whole → not shortened.
        `SET: #1 | Read them. | sources=Source A::alpha;;Source B::${SOURCE_B_LINE}`,
        "ES: #1 Write an essay that uses both sources.",
        "Source A",
        SOURCE_A_LINE,
        "Source B",
        SOURCE_B_LINE,
      ]),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      candidates: { type: string }[];
      proposed_sets: {
        id: string;
        stimulus: string;
        layout: string;
        item_indexes: number[];
        sources: { label: string; text: string; shortened?: boolean }[];
      }[];
    };
    expect(body.candidates.map((c) => c.type)).toEqual(["essay"]);
    expect(body.proposed_sets).toHaveLength(1);
    const set = body.proposed_sets[0]!;
    expect(set.stimulus).toBe("Read them.");
    expect(set.item_indexes).toEqual([0]);
    expect(set.layout).toBe("side_by_side");
    expect(set.sources.map((s) => s.label)).toEqual(["Source A", "Source B"]);
    expect(set.sources[0]!.shortened).toBe(true);
    expect(set.sources[1]!.text).toBe(SOURCE_B_LINE);
    expect(set.sources[1]!.shortened).toBeUndefined();
  });

  // E9 (2026-09-02): the numbering restarting at 1 splits the validated
  // candidates into forms; labels alone only announce a count.
  test("forms: numbering restarts → groups over validated indexes; labels alone → count only; neither → null", async () => {
    const id = await createAssessment("Forms");
    const two = await postPdf(
      id,
      makeTextPdf([
        "1. 2. 3. 1. 2. 3.",
        "MC: #1 A? | a:x | b:y | *a",
        "ST: #2 B? | b",
        "ES: #3 C",
        "MC: #1 A again? | a:x | b:y | *a",
        "ST: #2 B again? | b",
        "ES: #3 C again",
      ]),
    );
    const tbody = (await two.json()) as { forms: { count: number; groups: number[][] | null; source: string } | null };
    expect(tbody.forms).toEqual({ count: 2, groups: [[0, 1, 2], [3, 4, 5]], source: "numbering" });

    const labels = await postPdf(id, makeTextPdf(["Form A", "MC: #1 Q | a:x | b:y | *a", "ST: #2 R | r", "Form B", "ES: #3 S", "ES: #4 T"]));
    const lbody = (await labels.json()) as { forms: { count: number; groups: number[][] | null; source: string } | null };
    expect(lbody.forms).toEqual({ count: 2, groups: null, source: "labels" });

    const none = await postPdf(id, makeTextPdf(GOOD_LINES));
    expect(((await none.json()) as { forms: unknown }).forms).toBeNull();
  });

  test("no numbering in the text → no shortfall; scanned → numbered_items null", async () => {
    const id = await createAssessment("Unnumbered");
    const res = await postPdf(id, makeTextPdf(GOOD_LINES));
    const body = (await res.json()) as { numbered_items: number | null; shortfall: boolean };
    expect(body.numbered_items).toBe(0);
    expect(body.shortfall).toBe(false);

    const scanned = await postPdf(id, makeTextPdf([]), "scan.pdf");
    const sbody = (await scanned.json()) as { numbered_items: number | null; shortfall: boolean };
    expect(sbody.numbered_items).toBeNull();
    expect(sbody.shortfall).toBe(false);
  });

  // Slice 44 (ADR 0015): scanned PDFs flow through the OCR branch instead
  // of being rejected. The mock provider returns a deterministic fixture.
  test("scanned PDF → OCR branch: fixture candidates, ocr_used, writes nothing", async () => {
    const id = await createAssessment("Scanned");
    const res = await postPdf(id, makeTextPdf([]), "scan.pdf");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ocr_used: boolean;
      candidates: { type: string; stem: string }[];
    };
    expect(body.ocr_used).toBe(true);
    expect(body.candidates.map((c) => c.type)).toEqual([
      "multiple_choice_single",
      "short_text",
    ]);
    expect(body.candidates[0]!.stem).toContain("scan.pdf");
    const db = getDb();
    expect(await db.select().from(items).where(eq(items.assessment_id, id))).toHaveLength(0);
  });

  // E14 + row 31 + E13 (2026-09-02): the fixture's second stem carries the
  // `[FIGURE 1]` the real model invented on a scan, one set names a figure
  // that was never extracted, and one says its question needs a figure.
  // The marker and the empty set never reach the panel; the flagged set does.
  test("scanned PDF: [FIGURE n] stripped from stems, an empty set dropped, a needs_figure set kept", async () => {
    const id = await createAssessment("Scanned leak");
    const res = await postPdf(id, makeTextPdf([]), "scan.pdf");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      figure_count: number;
      candidates: { stem: string }[];
      proposed_sets: unknown[];
      rejected_sets: { index: number; reason: string }[];
    };
    expect(body.figure_count).toBe(0);
    expect(body.candidates[1]!.stem).toBe("OCR mock: What is the capital of Washington State?");
    expect(body.candidates.some((c) => /\[FIGURE \d+\]/.test(c.stem))).toBe(false);
    expect(body.proposed_sets).toEqual([
      {
        id: "s1",
        stimulus: "",
        figures: [],
        item_indexes: [0],
        source: "model",
        sources: [],
        layout: "inline",
        needs_figure: true,
      },
    ]);
    expect(body.rejected_sets).toEqual([{ index: 0, reason: "empty" }]);
  });

  test("scanned PDF over the page cap → 422 pdf_too_many_pages", async () => {
    const id = await createAssessment("Big scan");
    const res = await postPdf(id, makeEmptyPagesPdf(MAX_OCR_PAGES + 1));
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; limit: number };
    expect(body.error).toBe("pdf_too_many_pages");
    expect(body.limit).toBe(MAX_OCR_PAGES);
  });

  test("scanned PDF over the OCR byte cap → 413 pdf_too_large_for_ocr", async () => {
    const id = await createAssessment("Fat scan");
    const res = await postPdf(id, makeEmptyPagesPdf(1, MAX_OCR_BYTES));
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("pdf_too_large_for_ocr");
  });

  test("scanned branch: guardrail input stage skipped, output stage still blocks", async () => {
    process.env.GUARDRAIL_PROVIDER = "mock";
    const id = await createAssessment("OCR blocked");
    // The mock OCR fixture echoes the file name into a stem; BLOCKME in the
    // name trips the mock guardrail's output check.
    const res = await postPdf(id, makeTextPdf([]), "BLOCKME.pdf");
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; stage: string };
    expect(body.error).toBe("blocked_by_guardrail");
    expect(body.stage).toBe("output");
    const db = getDb();
    const events = await db.select().from(guardrail_events);
    // Exactly one event, and it is the output check — no input-stage row
    // proves the pre-model check was skipped on the scanned branch.
    expect(events).toHaveLength(1);
    expect(events[0]!.stage).toBe("output");
    expect(events[0]!.action).toBe("block");
  });

  test("unparseable PDF → 400", async () => {
    const id = await createAssessment("Bad");
    const res = await postPdf(id, new Uint8Array([1, 2, 3, 4, 5]));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("pdf_parse_failed");
  });

  test("guardrail blocks BLOCKME text → 422 + telemetry", async () => {
    process.env.GUARDRAIL_PROVIDER = "mock";
    const id = await createAssessment("Blocked");
    const res = await postPdf(
      id,
      makeTextPdf(["MC: Fine | a:1 | b:2 | *a", "BLOCKME sensitive content"]),
    );
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toBe("blocked_by_guardrail");
    const db = getDb();
    const events = await db
      .select()
      .from(guardrail_events)
      .where(eq(guardrail_events.action, "block"));
    expect(events).toHaveLength(1);
    expect(events[0]!.surface).toBe("pdf-import");
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
    const res = await postPdf(id, makeTextPdf(GOOD_LINES));
    expect(res.status).toBe(409);
  });

  test("403 for another teacher", async () => {
    const id = await createAssessment("Owned");
    mockSub = "someone-else";
    const res = await postPdf(id, makeTextPdf(GOOD_LINES));
    expect(res.status).toBe(403);
  });
});

// Review fix (2026-08-14): the response carries per-candidate rejection
// errors — the teacher needs to see WHY, not just a count. Since
// 2026-09-01 a MISSING KEY is no longer a rejection (keyless items import
// and get their key later), so the keyless MC is now a proposal; the
// 1-choice MC in GOOD_LINES still exercises the rejected list.
describe("rejected details in the response (review fix)", () => {
  test("keyless MC candidate is proposed with an empty key, not rejected", async () => {
    const id = await createAssessment("Keyless");
    // Mock convention: MC with no '*' marker → correct_choice_ids [] →
    // rejected by CreateItemBody (single-select needs exactly one). Line
    // padded past MIN_CHARS_PER_PAGE so the text-layer path runs.
    const res = await postPdf(
      id,
      makeTextPdf([
        "MC: This keyless question has no answer marker anywhere | a:first option | b:second option",
      ]),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      candidates: { type: string; correct_choice_ids: string[] }[];
      rejected: { index: number; errors: string[] }[];
      rejected_count: number;
    };
    expect(body.candidates).toHaveLength(1);
    expect(body.candidates[0]!.type).toBe("multiple_choice_single");
    expect(body.candidates[0]!.correct_choice_ids).toEqual([]);
    expect(body.rejected_count).toBe(0);
  });

  test("a candidate with a real shape error is still rejected with its reason", async () => {
    const id = await createAssessment("Shape");
    const res = await postPdf(
      id,
      makeTextPdf(["MC: One-choice question padded well past the scanned threshold | a:only option | *a"]),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      candidates: unknown[];
      rejected: { index: number; errors: string[] }[];
    };
    expect(body.candidates).toHaveLength(0);
    expect(body.rejected[0]!.errors.join(" ")).toMatch(/choices/);
  });
});

// 2026-09-01: a provider throw (ERAS exam: 13 pages overran the 4000-token
// output cap → unparseable JSON) escaped the handler as an empty-body 500
// and the panel showed a raw JSON-parse TypeError. Every extraction failure
// now returns a structured body with a teacher-facing hint. The mock
// provider fails on text markers so the mapping is covered end to end.
const PAD = " padded so the text layer clears the scanned-detection threshold easily";
describe("extraction failures return structured errors", () => {
  test("truncated output → 422 pdf_extract_truncated with a split hint", async () => {
    const id = await createAssessment("Truncated");
    const res = await postPdf(id, makeTextPdf([`THROW_TRUNCATED${PAD}`]));
    expect(res.status).toBe(422);
    const body = (await res.json()) as { ok: boolean; error: string; hint: string; detail: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe("pdf_extract_truncated");
    expect(body.hint).toMatch(/Split the PDF/);
    expect(body.detail).toMatch(/token cap/);
  });

  test("malformed model output → 422 pdf_extract_invalid_output", async () => {
    const id = await createAssessment("Invalid");
    const res = await postPdf(id, makeTextPdf([`THROW_INVALID_JSON${PAD}`]));
    expect(res.status).toBe(422);
    const body = (await res.json()) as { ok: boolean; error: string; hint: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe("pdf_extract_invalid_output");
    expect(body.hint).toMatch(/Try again/);
  });

  test("provider outage → 502 pdf_extract_failed, never an empty body", async () => {
    const id = await createAssessment("Outage");
    const res = await postPdf(id, makeTextPdf([`THROW_PROVIDER${PAD}`]));
    expect(res.status).toBe(502);
    const body = (await res.json()) as { ok: boolean; error: string; hint: string; detail: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe("pdf_extract_failed");
    expect(body.detail).toMatch(/simulated provider outage/);
  });
});

// E3 slice 4: a table candidate comes through the route and adds as a table.
describe("POST items/import-pdf: table candidates (E3)", () => {
  test("a TB segment is a table candidate; adding it creates a table item with its grid", async () => {
    const id = await createAssessment("Tables");
    const res = await postPdf(
      id,
      makeTextPdf(["TB: #1 Enter the counts | cols=Observed,Expected | rows=Middle,Total | corner=Chamber"]),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      candidates: { type: string; columns?: { id: string; label: string }[]; rows?: { id: string }[]; corner?: string }[];
      rejected_count: number;
    };
    expect(body.rejected_count).toBe(0);
    expect(body.candidates).toHaveLength(1);
    const cand = body.candidates[0]!;
    expect(cand.type).toBe("table");
    expect(cand.columns).toEqual([{ id: "c1", label: "Observed" }, { id: "c2", label: "Expected" }]);
    expect(cand.corner).toBe("Chamber");

    const { POST: createItem } = await import("../app/api/assessments/[id]/items/route");
    const add = await createItem(
      new Request(`http://localhost/api/assessments/${id}/items`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(cand),
      }),
      { params: Promise.resolve({ id }) },
    );
    expect(add.status).toBe(201);
    const rows = await getDb().select().from(items).where(eq(items.assessment_id, id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.type).toBe("table");
    expect(rows[0]!.config.rows?.map((r) => r.label)).toEqual(["Middle", "Total"]);
    expect(rows[0]!.config.cell_keys).toBeUndefined();
  });
});

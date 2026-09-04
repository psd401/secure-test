// Slice 41: CSV item import — pure parser (golden CSVs, every type incl.
// essay+rubric, partial-invalid, per-row errors) + the import route
// (preview vs commit, append positioning, draft guard, round-trip against
// the export bundle).
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { asc, eq, sql } from "drizzle-orm";
import { closeDb, getDb } from "../db/client";
import { items } from "../db/schema";
import { SESSION_COOKIE_NAME } from "../lib/auth/session";
import * as sessionMod from "../lib/auth/session";
import { parseItemsCsv } from "../lib/api/importItemsCsv";

const RUBRIC = {
  style: "analytic",
  criteria: [
    {
      id: "ideas",
      name: "Ideas",
      levels: [
        { id: "i1", label: "Emerging", points: 1 },
        { id: "i2", label: "Proficient", points: 2 },
      ],
    },
  ],
};

const HEADER =
  "type,stem,choices,correct,scoring_method,max_word_count,placeholder,rubric_json";

describe("parseItemsCsv (pure)", () => {
  test("parses every item type from a valid CSV", () => {
    const rubricCell = `"${JSON.stringify(RUBRIC).replace(/"/g, '""')}"`;
    const csv = [
      HEADER,
      "multiple_choice_single,What is 2+2?,a:3|b:4|c:5,b,,,,",
      "multiple_choice_multi,Pick evens,a:2|b:3|c:4,a|c,,,,",
      "short_text,Capital of France?,,Paris,,,,",
      `essay,Discuss photosynthesis,,,ai,150,Write here,${rubricCell}`,
    ].join("\n");
    const result = parseItemsCsv(csv);
    expect(result.headerError).toBeUndefined();
    expect(result.validCount).toBe(4);
    expect(result.invalidCount).toBe(0);

    const [mc1, mc2, st, essay] = result.rows.map((r) => r.item!);
    expect(mc1!.type).toBe("multiple_choice_single");
    expect((mc1 as { correct_choice_ids: string[] }).correct_choice_ids).toEqual(["b"]);
    expect((mc2 as { correct_choice_ids: string[] }).correct_choice_ids).toEqual(["a", "c"]);
    expect((st as { correct_answer: string }).correct_answer).toBe("Paris");
    expect(essay!.type).toBe("essay");
    expect((essay as { scoring_method?: string }).scoring_method).toBe("ai");
    expect((essay as { max_word_count?: number }).max_word_count).toBe(150);
    expect((essay as { rubric?: unknown }).rubric).toBeTruthy();
  });

  test("reports per-row errors without failing the whole file", () => {
    const csv = [
      HEADER,
      "short_text,Good one,,ok,,,,", // valid
      "multiple_choice_single,No choices,,a,,,,", // < 2 choices → invalid
      "essay,AI without rubric,,,ai,,,", // ai needs a rubric → invalid
      "banana,Unknown type,,,,,,", // bad type → invalid
      "essay,Bad rubric,,,,,,{not json", // rubric_json parse error → invalid
    ].join("\n");
    const result = parseItemsCsv(csv);
    expect(result.validCount).toBe(1);
    expect(result.invalidCount).toBe(4);
    const invalid = result.rows.filter((r) => r.errors.length > 0);
    expect(invalid).toHaveLength(4);
    // The rubric JSON parse error is reported as such.
    expect(invalid.some((r) => r.errors.some((e) => /rubric_json/.test(e)))).toBe(true);
    // The ai-without-rubric row cites scoring_method.
    expect(invalid.some((r) => r.errors.some((e) => /scoring_method/.test(e)))).toBe(true);
  });

  test("blank lines are skipped; header is order-independent", () => {
    const csv = [
      "stem,type,correct", // reordered, subset of columns
      "Capital of France?,short_text,Paris",
      "",
      "  ",
    ].join("\n");
    const result = parseItemsCsv(csv);
    expect(result.validCount).toBe(1);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.item!.type).toBe("short_text");
  });

  test("missing required header columns is a header error", () => {
    const result = parseItemsCsv("foo,bar\n1,2");
    expect(result.headerError).toMatch(/type.*stem|stem/);
    expect(result.rows).toHaveLength(0);
  });

  test("choices text may contain colons (first colon splits)", () => {
    const csv = [
      HEADER,
      "multiple_choice_single,Time?,a:12:00|b:1:00,a,,,,",
    ].join("\n");
    const result = parseItemsCsv(csv);
    const item = result.rows[0]!.item as { choices: { id: string; text: string }[] };
    expect(item.choices).toEqual([
      { id: "a", text: "12:00" },
      { id: "b", text: "1:00" },
    ]);
  });
});

// ---- Route integration ----
const expectTestDb = () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("secure_test_design_tool_test")) {
    throw new Error(`import-items-csv tests require the test DB DATABASE_URL; got: ${url}`);
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

beforeAll(() => {
  expectTestDb();
  originalSessionSecret = process.env.DESIGN_TOOL_SESSION_SECRET;
  process.env.DESIGN_TOOL_SESSION_SECRET = "test-session-secret-do-not-use";
  mockSub = "csv-import-teacher";
});

afterEach(async () => {
  mockSub = "csv-import-teacher";
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

async function postImport(id: string, csv: string, commit: boolean) {
  const { POST } = await import(
    "../app/api/assessments/[id]/items/import/route"
  );
  return POST(
    new Request(`http://localhost/api/assessments/${id}/items/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ csv, commit }),
    }),
    { params: Promise.resolve({ id }) },
  );
}

const VALID_CSV = [
  HEADER,
  "short_text,Q1,,alpha,,,,",
  "multiple_choice_single,Q2,a:x|b:y,b,,,,",
].join("\n");

describe("POST items/import route", () => {
  test("preview reports rows and writes nothing", async () => {
    const id = await createAssessment("Preview");
    const res = await postImport(id, VALID_CSV, false);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      committed: boolean;
      valid_count: number;
      rows: unknown[];
    };
    expect(body.committed).toBe(false);
    expect(body.valid_count).toBe(2);
    const db = getDb();
    expect(await db.select().from(items).where(eq(items.assessment_id, id))).toHaveLength(0);
  });

  test("commit inserts valid rows, appends after existing, skips invalid", async () => {
    const id = await createAssessment("Commit");
    // Seed one existing item so we can check append positioning.
    const { POST: addItem } = await import(
      "../app/api/assessments/[id]/items/route"
    );
    await addItem(
      new Request(`http://localhost/api/assessments/${id}/items`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "short_text", stem: "Existing", correct_answer: "z" }),
      }),
      { params: Promise.resolve({ id }) },
    );

    const csvWithBad = [
      HEADER,
      "short_text,Good,,alpha,,,,",
      "multiple_choice_single,Bad no choices,,a,,,,",
    ].join("\n");
    const res = await postImport(id, csvWithBad, true);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      committed: boolean;
      inserted: number;
      valid_count: number;
      invalid_count: number;
    };
    expect(body.committed).toBe(true);
    expect(body.inserted).toBe(1);
    expect(body.invalid_count).toBe(1);

    const db = getDb();
    const rows = await db
      .select()
      .from(items)
      .where(eq(items.assessment_id, id))
      .orderBy(asc(items.position));
    expect(rows).toHaveLength(2); // existing + 1 imported
    expect(rows.map((r) => r.position)).toEqual([0, 1]); // appended
    expect(rows[1]!.stem).toBe("Good");
  });

  test("header error is a 400", async () => {
    const id = await createAssessment("BadHeader");
    const res = await postImport(id, "foo,bar\n1,2", true);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("header_error");
  });

  test("published assessment is 409 (draft-locked)", async () => {
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
    const res = await postImport(id, VALID_CSV, true);
    expect(res.status).toBe(409);
  });

  test("403 for another teacher", async () => {
    const id = await createAssessment("Owned");
    mockSub = "someone-else";
    const res = await postImport(id, VALID_CSV, true);
    expect(res.status).toBe(403);
  });

  test("round-trip: imported items match on export", async () => {
    const id = await createAssessment("RoundTrip");
    const rubricCell = `"${JSON.stringify(RUBRIC).replace(/"/g, '""')}"`;
    const csv = [
      HEADER,
      "multiple_choice_single,Q1,a:x|b:y,a,human,,,",
      `essay,Q2,,,ai,,,${rubricCell}`,
    ].join("\n");
    expect((await postImport(id, csv, true)).status).toBe(200);

    const { GET } = await import("../app/api/assessments/[id]/export/route");
    const res = await GET(
      new Request(`http://localhost/api/assessments/${id}/export`),
      { params: Promise.resolve({ id }) },
    );
    const bundle = (await res.json()) as {
      items: Array<{
        type: string;
        scoring_method?: string;
        correct_choice_id?: string;
        rubric?: unknown;
      }>;
    };
    expect(bundle.items).toHaveLength(2);
    expect(bundle.items[0]!.type).toBe("multiple_choice_single");
    expect(bundle.items[0]!.correct_choice_id).toBe("a");
    expect(bundle.items[0]!.scoring_method).toBe("human");
    expect(bundle.items[1]!.type).toBe("essay");
    expect(bundle.items[1]!.scoring_method).toBe("ai");
    // B8: RUBRIC carries no student_visibility, so during_test is false and the
    // rubric is withheld from the bundle the student client downloads. The
    // scoring_method still rides along — the server needs it, the student
    // doesn't need the descriptors.
    expect(bundle.items[1]!.rubric).toBeUndefined();
  });

  // B8: the same round-trip, with the teacher opting the rubric in.
  test("round-trip: a during_test-visible rubric IS exported", async () => {
    const id = await createAssessment("RoundTripVisibleRubric");
    const visibleRubric = {
      ...RUBRIC,
      student_visibility: { during_test: true, with_feedback: false },
    };
    const rubricCell = `"${JSON.stringify(visibleRubric).replace(/"/g, '""')}"`;
    const csv = [HEADER, `essay,Q1,,,ai,,,${rubricCell}`].join("\n");
    expect((await postImport(id, csv, true)).status).toBe(200);

    const { GET } = await import("../app/api/assessments/[id]/export/route");
    const res = await GET(
      new Request(`http://localhost/api/assessments/${id}/export`),
      { params: Promise.resolve({ id }) },
    );
    const bundle = (await res.json()) as {
      items: Array<{ type: string; rubric?: { criteria?: unknown[] } }>;
    };
    expect(bundle.items).toHaveLength(1);
    expect(bundle.items[0]!.rubric).toBeTruthy();
    expect(bundle.items[0]!.rubric!.criteria).toHaveLength(1);
  });
});

// Slice 47: match is a valid item type but has no CSV representation.
describe("match rows (slice 47)", () => {
  test("rejects type match with an explicit not-supported error", () => {
    const csv = [HEADER, "match,Match these,,,,,,"].join("\n");
    const result = parseItemsCsv(csv);
    expect(result.validCount).toBe(0);
    expect(result.invalidCount).toBe(1);
    expect(result.rows[0]!.errors.join(" ")).toMatch(/not supported by CSV import/);
  });
});

// Slice 48: order rows rejected like match rows.
describe("order rows (slice 48)", () => {
  test("rejects type order with an explicit not-supported error", () => {
    const csv = [HEADER, "order,Put these in order,,,,,,"].join("\n");
    const result = parseItemsCsv(csv);
    expect(result.validCount).toBe(0);
    expect(result.invalidCount).toBe(1);
    expect(result.rows[0]!.errors.join(" ")).toMatch(/not supported by CSV import/);
  });
});

// Slice 49: hotspot rows rejected like match/order rows.
describe("hotspot rows (slice 49)", () => {
  test("rejects type hotspot with an explicit not-supported error", () => {
    const csv = [HEADER, "hotspot,Mark the region,,,,,,"].join("\n");
    const result = parseItemsCsv(csv);
    expect(result.validCount).toBe(0);
    expect(result.invalidCount).toBe(1);
    expect(result.rows[0]!.errors.join(" ")).toMatch(/not supported by CSV import/);
  });
});

// Slice 50: drawing_upload rows rejected like the other structural types.
describe("drawing_upload rows (slice 50)", () => {
  test("rejects type drawing_upload with an explicit not-supported error", () => {
    const csv = [HEADER, "drawing_upload,Draw it,,,,,,"].join("\n");
    const result = parseItemsCsv(csv);
    expect(result.validCount).toBe(0);
    expect(result.invalidCount).toBe(1);
    expect(result.rows[0]!.errors.join(" ")).toMatch(/not supported by CSV import/);
  });
});

// Review fix (2026-08-14): reported line numbers are physical source lines.
describe("physical line numbers after multi-line cells (review fix)", () => {
  test("an invalid row after a multi-line stem reports its real line", () => {
    // Header line 1; row on lines 2-3 (quoted stem with a newline); invalid
    // row physically on line 4.
    const csv = [
      HEADER,
      'essay,"stem line one\nstem line two",,,,,,',
      "banana,Bad type,,,,,,",
    ].join("\n");
    const result = parseItemsCsv(csv);
    expect(result.validCount).toBe(1);
    expect(result.invalidCount).toBe(1);
    const bad = result.rows.find((r) => r.errors.length > 0)!;
    expect(bad.line).toBe(4);
  });
});

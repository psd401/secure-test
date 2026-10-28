// Editor redesign Phase 7 slice C (R-9, D-6): the JSON-import preview.
// What it computes (counts, warnings, the questions as they will be stored),
// that it matches what the import then actually writes, that NOTHING is
// written before Create, and the flag gate on its route.
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { asc, eq, sql } from "drizzle-orm";
import { ItemBundleSchema, type ItemBundle } from "@secure-test/schema";
import { closeDb, getDb } from "../db/client";
import { assessments, items } from "../db/schema";
import { SESSION_COOKIE_NAME, type SessionPayload } from "../lib/auth/session";
import * as sessionMod from "../lib/auth/session";
import * as headersMod from "next/headers";
import { setNewAuthoring } from "../lib/authoring/flag";
import { importBundleForOwner, isImportBundleError, planImport } from "../lib/api/importBundle";
import { buildImportPreview, previewImportBundle } from "../lib/api/importPreview";
import { picturesFromFile, previewErrorCode } from "../lib/preview/importFile";
import { buildPreviewBundle, createPreviewSealer } from "../lib/preview/interactive/bundle";
import { rowToView } from "../app/dashboard/[id]/editorModel";

const expectTestDb = () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("secure_test_design_tool_test")) {
    throw new Error(`import-preview tests require the test DB DATABASE_URL; got: ${url}`);
  }
};

let mockSub: string | null = null;
let originalSessionSecret: string | undefined;

mock.module("next/headers", () => ({
  ...headersMod,
  headers: async () => new Headers(),
  cookies: async () => ({
    get: (name: string) => (mockSub && name === SESSION_COOKIE_NAME ? { value: "x" } : undefined),
  }),
}));

mock.module("../lib/auth/session", () => ({
  ...sessionMod,
  readSessionFromCookies: async () => (mockSub ? { sub: mockSub, role: "staff" } : null),
}));

const OWNER = "import-preview-teacher";
const PIC = "0a0b0c0d-0000-4000-8000-000000000001";
const MISSING_PIC = "0a0b0c0d-0000-4000-8000-000000000002";
// A 1×1 PNG.
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

/** One of most kinds the warnings look at: keyless, clamped scoring, a set, pictures. */
function bundle(over: Partial<ItemBundle> = {}): ItemBundle {
  return ItemBundleSchema.parse({
    test_id: "src",
    title: "Unit 3 check",
    student_layout: "paged",
    calculator: { mode: "scientific", preset: "full" },
    allowed_accommodations: ["expandable_items", "not_a_real_accommodation"],
    construct_altering: ["english_glossary"],
    items: [
      {
        id: "q1",
        stem: `Which is red? ![apple](asset:${PIC.toUpperCase()})`,
        choices: [
          { id: "a", text: "Apple" },
          { id: "b", text: "Sky" },
        ],
        correct_choice_id: "a",
      },
      {
        id: "q2",
        stem: "Pick both fruits",
        type: "multiple_choice_multi",
        choices: [
          { id: "a", text: "Pear" },
          { id: "b", text: `Plum ![plum](asset:${MISSING_PIC})` },
          { id: "c", text: "Rock" },
        ],
        correct_choice_ids: [],
      },
      { id: "q3", type: "short_text", stem: "Capital of WA?", correct_answer: "Olympia" },
      // ai scoring without a rubric: the import clamps it to the default.
      { id: "q4", type: "essay", stem: "Explain.", scoring_method: "ai" },
      {
        id: "q5",
        type: "order",
        stem: "Order these",
        sequence: [
          { id: "s1", label: "First" },
          { id: "s2", label: "Second" },
        ],
      },
    ],
    item_sets: [{ id: "set1", stimulus: "Read the passage.", item_ids: ["q3", "q4"] }],
    assets: { [PIC]: { content_type: "image/png", base64: PNG } },
    ...over,
  });
}

beforeAll(() => {
  expectTestDb();
  originalSessionSecret = process.env.DESIGN_TOOL_SESSION_SECRET;
  process.env.DESIGN_TOOL_SESSION_SECRET = "test-session-secret-do-not-use";
  mockSub = OWNER;
});

afterEach(async () => {
  mockSub = OWNER;
  const db = getDb();
  await db.execute(sql`truncate table assessments restart identity cascade`);
  await db.execute(sql`truncate table assets restart identity cascade`);
  await db.execute(sql`truncate table staff_preferences`);
});

afterAll(async () => {
  await closeDb();
  if (originalSessionSecret === undefined) delete process.env.DESIGN_TOOL_SESSION_SECRET;
  else process.env.DESIGN_TOOL_SESSION_SECRET = originalSessionSecret;
});

async function rowCounts() {
  const db = getDb();
  const r = await db.execute(sql`select
    (select count(*) from assessments)::int as assessments,
    (select count(*) from items)::int as items,
    (select count(*) from item_sets)::int as item_sets,
    (select count(*) from assets)::int as assets,
    (select count(*) from item_snapshots)::int as snapshots`);
  return r[0];
}

const pure = (b: ItemBundle, facts = { name: b.title, sourcesDropped: 0 }) =>
  buildImportPreview(b, planImport(b, new Map()), facts);

describe("buildImportPreview (pure)", () => {
  test("counts by type in ITEM_TYPES order, sets, pictures and settings", () => {
    const p = pure(bundle());
    expect(p.item_count).toBe(5);
    expect(p.type_counts).toEqual([
      { type: "multiple_choice_single", count: 1 },
      { type: "multiple_choice_multi", count: 1 },
      { type: "short_text", count: 1 },
      { type: "essay", count: 1 },
      { type: "order", count: 1 },
    ]);
    expect(p.set_count).toBe(1);
    expect(p.picture_count).toBe(1);
    expect(p.student_layout).toBe("paged");
    expect(p.calculator_mode).toBe("scientific");
    expect(p.accommodation_count).toBe(1);
    expect(p.error).toBeNull();
  });

  test("warnings name each thing the import changes or drops", () => {
    const p = pure(bundle(), { name: "x", sourcesDropped: 2 });
    expect(p.warnings.map((w) => w.code)).toEqual([
      "scoring_dropped",
      "accommodations_dropped",
      "sources_dropped",
      "missing_pictures",
      "no_answer_key",
    ]);
    const text = (code: string) => p.warnings.find((w) => w.code === code)!.message;
    // One bad accommodation id + a construct-altering id outside the allowed list.
    expect(text("accommodations_dropped")).toStartWith("2 accommodation settings aren't");
    expect(text("missing_pictures")).toStartWith("1 picture the questions use isn't");
    expect(text("no_answer_key")).toStartWith("1 question has no answer key");
    expect(text("sources_dropped")).toStartWith("2 passages show");
  });

  test("a clean bundle has no warnings; an empty one says so", () => {
    const clean = bundle({
      allowed_accommodations: [],
      construct_altering: [],
      items: [{ id: "q", stem: "2+2?", type: "short_text", correct_answer: "4" }],
      item_sets: [],
      assets: {},
    });
    expect(pure(clean).warnings).toEqual([]);
    const empty = pure(bundle({ items: [], item_sets: [], assets: {} }));
    expect(empty.warnings.map((w) => w.code)).toContain("no_items");
    expect(empty.items).toEqual([]);
  });

  test("an item type this server doesn't know is counted, not shown", () => {
    const b = bundle();
    const skewed = { ...b, items: [...b.items, { ...b.items[2]!, id: "q9", type: "from_the_future" }] } as unknown as ItemBundle;
    const p = pure(skewed);
    expect(p.item_count).toBe(5);
    expect(p.warnings.find((w) => w.code === "unknown_types")?.message).toStartWith("1 question uses a type");
  });

  test("the import's refusals become the preview's error (Create stays off)", () => {
    const badPic = pure(bundle({ assets: { [PIC]: { content_type: "text/html", base64: PNG } } }));
    expect(badPic.error).toBe("asset_content_type_not_allowed");
    const board = { x: [-10, 10], y: [-10, 10], grid: 1, snap: "1", tools: ["point"], max_objects: 2 };
    const graph = bundle({
      items: [{ type: "graph", id: "g", stem: "Graph it.", board, key: { objects: [{ tool: "point", points: [[0.5, 0]] }], scoring: "all" } }],
      item_sets: [],
    } as unknown as Partial<ItemBundle>);
    expect(pure(graph).error ?? "").toStartWith("schema_invalid:items.0.");
  });

  test("questions carry preview ids and the set membership the import recreates", () => {
    const p = pure(bundle());
    expect(p.items.map((i) => i.id)).toEqual([0, 1, 2, 3, 4].map((n) => `preview-item-${n}`));
    expect(p.items.map((i) => i.item_set_id ?? null)).toEqual([null, null, "preview-set-0", "preview-set-0", null]);
    expect(p.sets).toEqual([{ id: "preview-set-0", stimulus_text: "Read the passage.", sources: [], layout: "inline" }]);
    // The clamp has already run: the essay's ai scoring is gone.
    expect(p.items[3]!.config).toEqual({});
  });

  test("the student view built from the preview carries no answer key", () => {
    const p = pure(bundle());
    const { bundle: delivery } = buildPreviewBundle({
      assessment: {
        id: "import-preview",
        name: p.name,
        calculator_mode: p.calculator_mode,
        calculator_preset: p.calculator_preset,
        allow_highlighting: p.allow_highlighting,
      },
      items: p.items.map(rowToView),
      sets: p.sets,
      layout: "scroll",
      tts: false,
      assets: picturesFromFile(bundle()),
      saved: {},
      sealer: createPreviewSealer(),
    });
    const posted = JSON.stringify(delivery);
    expect(delivery.items).toHaveLength(5);
    expect(posted).not.toContain("Olympia");
    expect(posted).not.toContain("correct_");
    // The order item's steps are delivered under sealed ids, not s1/s2.
    expect(posted).not.toContain('"s1"');
    expect(Object.keys(delivery.assets ?? {})).toEqual([PIC]);
  });
});

describe("previewImportBundle (DB)", () => {
  test("writes nothing: no assessment, item, set, asset or snapshot row", async () => {
    const before = await rowCounts();
    const p = await previewImportBundle(getDb(), bundle(), OWNER);
    expect(p.item_count).toBe(5);
    expect(await rowCounts()).toEqual(before);
    expect(before).toMatchObject({ assessments: 0, items: 0, assets: 0 });
  });

  test("names the copy the way the import will", async () => {
    const db = getDb();
    await db.insert(assessments).values({ owner_sub: OWNER, name: "Unit 3 check", description: "" });
    expect((await previewImportBundle(db, bundle(), OWNER)).name).toBe("Unit 3 check (copy)");
    expect((await previewImportBundle(db, bundle(), "someone-else")).name).toBe("Unit 3 check");
  });

  test("a source link to a question this owner doesn't own is reported", async () => {
    const db = getDb();
    const [other] = await db
      .insert(assessments)
      .values({ owner_sub: "another-teacher", name: "Other", description: "" })
      .returning();
    const [q] = await db
      .insert(items)
      .values({ assessment_id: other!.id, position: 0, type: "essay", stem: "Write.", choices: [], correct_choice_ids: [] })
      .returning();
    const b = bundle({
      item_sets: [
        { id: "set1", stimulus: "x", layout: "inline", sources: [], item_ids: ["q3", "q4"], source: { assessment_id: other!.id, item_id: q!.id } },
      ],
    });
    const mine = await previewImportBundle(db, b, OWNER);
    expect(mine.warnings.map((w) => w.code)).toContain("sources_dropped");
    const theirs = await previewImportBundle(db, b, "another-teacher");
    expect(theirs.warnings.map((w) => w.code)).not.toContain("sources_dropped");
  });

  test("matches what Create then writes: counts, and every question as stored", async () => {
    const db = getDb();
    const b = bundle();
    const p = await previewImportBundle(db, b, OWNER);
    const result = await importBundleForOwner(b, OWNER);
    if (isImportBundleError(result)) throw new Error(result.error);
    expect(result.item_count).toBe(p.item_count);
    expect(result.scoring_methods_dropped).toBe(1);
    expect(p.warnings.find((w) => w.code === "scoring_dropped")).toBeDefined();
    expect(result.accommodations_dropped + result.construct_altering_dropped).toBe(2);
    expect(result.accommodations_imported).toBe(p.accommodation_count);

    const stored = await db.select().from(items).where(eq(items.assessment_id, result.assessment_id)).orderBy(asc(items.position));
    const [row] = await db.select().from(assessments).where(eq(assessments.id, result.assessment_id));
    expect(row!.name).toBe(p.name);
    // The picture was re-uploaded under a new id, so compare with refs masked.
    const mask = (s: string) => s.replace(/asset:[0-9a-f-]{36}/gi, "asset:*");
    const shape = (r: { type: string; stem: string; choices: unknown; correct_choice_ids: unknown; correct_answer: string | null; config: unknown }) => ({
      type: r.type,
      stem: mask(r.stem),
      choices: JSON.parse(mask(JSON.stringify(r.choices))),
      correct_choice_ids: r.correct_choice_ids,
      correct_answer: r.correct_answer,
      config: r.config,
    });
    expect(stored.map(shape)).toEqual(p.items.map(shape));
    const setMembers = stored.map((s) => s.item_set_id !== null);
    expect(setMembers).toEqual(p.items.map((i) => i.item_set_id != null));
  });
});

describe("POST /api/assessments/import/preview", () => {
  async function postPreview(body: string) {
    const { POST } = await import("../app/api/assessments/import/preview/route");
    const form = new FormData();
    form.append("file", new File([body], "unit.json", { type: "application/json" }));
    return POST(new Request("http://localhost/api/assessments/import/preview", { method: "POST", body: form }));
  }

  test("requires a session", async () => {
    mockSub = null;
    expect((await postPreview(JSON.stringify(bundle()))).status).toBe(401);
  });

  test("is 404 with the R-12 flag off", async () => {
    // Phase 9 cutover: the new editor is the default, so the previous editor is now an explicit choice.
    await setNewAuthoring(getDb(), { sub: OWNER, role: "staff" } as SessionPayload, false);
    expect((await postPreview(JSON.stringify(bundle()))).status).toBe(404);
  });

  test("flag on: answers the preview and writes nothing", async () => {
    await setNewAuthoring(getDb(), { sub: OWNER, role: "staff" } as SessionPayload, true);
    const before = await rowCounts();
    const res = await postPreview(JSON.stringify(bundle()));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; preview: { item_count: number; name: string } };
    expect(body.ok).toBe(true);
    expect(body.preview.item_count).toBe(5);
    expect(body.preview.name).toBe("Unit 3 check");
    expect(await rowCounts()).toEqual(before);
  });

  test("flag on: refuses a broken file with the import's own codes", async () => {
    await setNewAuthoring(getDb(), { sub: OWNER, role: "staff" } as SessionPayload, true);
    const notJson = await postPreview("{nope");
    expect(notJson.status).toBe(400);
    expect(previewErrorCode(await notJson.json())).toBe("invalid_json");
    const wrongShape = await postPreview(JSON.stringify({ title: "x" }));
    expect(wrongShape.status).toBe(400);
    expect(previewErrorCode(await wrongShape.json())).toStartWith("schema_invalid:");
  });
});

describe("page helpers", () => {
  test("previewErrorCode builds the page's schema_invalid:<path>:<message> code", () => {
    expect(previewErrorCode({ error: "schema_invalid", detail: [{ path: ["items", 0, "stem"], message: "Required" }] })).toBe(
      "schema_invalid:items.0.stem:Required",
    );
    expect(previewErrorCode({ error: "file_too_large" })).toBe("file_too_large");
    expect(previewErrorCode(null)).toBe("preview_failed");
  });

  test("picturesFromFile keys pictures by lower-cased id and skips malformed ones", () => {
    expect(
      picturesFromFile({
        assets: { [PIC.toUpperCase()]: { content_type: "image/png", base64: PNG }, bad: { content_type: 1 } },
      }),
    ).toEqual({ [PIC]: { content_type: "image/png", base64: PNG } });
    expect(picturesFromFile({})).toEqual({});
    expect(picturesFromFile(null)).toEqual({});
  });
});

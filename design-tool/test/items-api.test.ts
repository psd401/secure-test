// Integration tests for the items CRUD + reorder + export routes.
// Same harness as assessments-api.test.ts — direct route imports against
// the local test DB with the session helper mocked.
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { sql } from "drizzle-orm";
import { ItemBundleSchema } from "@secure-test/schema";
import { effectiveScoringMethod } from "../lib/api/items";
import { closeDb, getDb } from "../db/client";
import { SESSION_COOKIE_NAME } from "../lib/auth/session";
import * as sessionMod from "../lib/auth/session";

const expectTestDb = () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("secure_test_design_tool_test")) {
    throw new Error(`items-api tests require the test DB DATABASE_URL; got: ${url}`);
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

async function createAssessment(name: string) {
  const { POST } = await import("../app/api/assessments/route");
  const req = new Request("http://localhost/api/assessments", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  const res = await POST(req);
  expect(res.status).toBe(201);
  const body = (await res.json()) as { assessment: { id: string } };
  return body.assessment.id;
}

async function createItem(assessmentId: string, body: unknown) {
  const { POST } = await import("../app/api/assessments/[id]/items/route");
  const req = new Request(`http://localhost/api/assessments/${assessmentId}/items`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return POST(req, { params: Promise.resolve({ id: assessmentId }) });
}

async function listItems(assessmentId: string) {
  const { GET } = await import("../app/api/assessments/[id]/items/route");
  const req = new Request(`http://localhost/api/assessments/${assessmentId}/items`);
  return GET(req, { params: Promise.resolve({ id: assessmentId }) });
}

async function patchItem(assessmentId: string, itemId: string, body: unknown) {
  const { PATCH } = await import("../app/api/assessments/[id]/items/[itemId]/route");
  const req = new Request(
    `http://localhost/api/assessments/${assessmentId}/items/${itemId}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  return PATCH(req, { params: Promise.resolve({ id: assessmentId, itemId }) });
}

async function deleteItem(assessmentId: string, itemId: string) {
  const { DELETE } = await import("../app/api/assessments/[id]/items/[itemId]/route");
  const req = new Request(
    `http://localhost/api/assessments/${assessmentId}/items/${itemId}`,
    { method: "DELETE" },
  );
  return DELETE(req, { params: Promise.resolve({ id: assessmentId, itemId }) });
}

async function reorderItems(assessmentId: string, orderedIds: string[]) {
  const { POST } = await import("../app/api/assessments/[id]/items/reorder/route");
  const req = new Request(
    `http://localhost/api/assessments/${assessmentId}/items/reorder`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ordered_ids: orderedIds }),
    },
  );
  return POST(req, { params: Promise.resolve({ id: assessmentId }) });
}

async function exportAssessment(assessmentId: string) {
  const { GET } = await import("../app/api/assessments/[id]/export/route");
  const req = new Request(
    `http://localhost/api/assessments/${assessmentId}/export`,
  );
  return GET(req, { params: Promise.resolve({ id: assessmentId }) });
}

const SAMPLE_MC = {
  type: "multiple_choice_single",
  stem: "What is 2 + 2?",
  choices: [
    { id: "a", text: "3" },
    { id: "b", text: "4" },
  ],
  correct_choice_ids: ["b"],
};

describe("items POST /api/assessments/:id/items", () => {
  test("creates each item type with auto-incrementing position", async () => {
    asUser("teacher-1");
    const aid = await createAssessment("with-items");

    const r1 = await createItem(aid, SAMPLE_MC);
    expect(r1.status).toBe(201);
    const r2 = await createItem(aid, {
      type: "multiple_choice_multi",
      stem: "Primary colors?",
      choices: [
        { id: "r", text: "Red" },
        { id: "g", text: "Green" },
        { id: "b", text: "Blue" },
      ],
      correct_choice_ids: ["r", "b"],
    });
    expect(r2.status).toBe(201);
    const r3 = await createItem(aid, {
      type: "short_text",
      stem: "Capital of WA?",
      correct_answer: "Olympia",
    });
    expect(r3.status).toBe(201);

    const list = await listItems(aid);
    const body = (await list.json()) as { items: { type: string; position: number }[] };
    expect(body.items.map((i) => i.position)).toEqual([0, 1, 2]);
    expect(body.items.map((i) => i.type)).toEqual([
      "multiple_choice_single",
      "multiple_choice_multi",
      "short_text",
    ]);
  });

  test("rejects MC item with fewer than 2 choices", async () => {
    asUser("teacher-1");
    const aid = await createAssessment("x");
    const res = await createItem(aid, {
      type: "multiple_choice_single",
      stem: "x",
      choices: [{ id: "a", text: "only one" }],
      correct_choice_ids: ["a"],
    });
    expect(res.status).toBe(400);
  });

  test("rejects short_text with choices", async () => {
    asUser("teacher-1");
    const aid = await createAssessment("x");
    const res = await createItem(aid, {
      type: "short_text",
      stem: "x",
      choices: [{ id: "a", text: "nope" }],
      correct_answer: "y",
    });
    expect(res.status).toBe(400);
  });

  test("401 with no session", async () => {
    asUser("teacher-1");
    const aid = await createAssessment("x");
    asUser(null);
    const res = await createItem(aid, SAMPLE_MC);
    expect(res.status).toBe(401);
  });

  test("403 when creating against another user's assessment", async () => {
    asUser("teacher-1");
    const aid = await createAssessment("x");
    asUser("teacher-2");
    const res = await createItem(aid, SAMPLE_MC);
    expect(res.status).toBe(403);
  });
});

describe("items PATCH", () => {
  test("updates allowed fields", async () => {
    asUser("teacher-1");
    const aid = await createAssessment("x");
    const created = await createItem(aid, SAMPLE_MC);
    const itemId = ((await created.json()) as { item: { id: string } }).item.id;
    const res = await patchItem(aid, itemId, {
      ...SAMPLE_MC,
      stem: "Updated stem",
      correct_choice_ids: ["a"],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { item: { stem: string; correct_choice_ids: string[] } };
    expect(body.item.stem).toBe("Updated stem");
    expect(body.item.correct_choice_ids).toEqual(["a"]);
  });

  test("rejects type change", async () => {
    asUser("teacher-1");
    const aid = await createAssessment("x");
    const created = await createItem(aid, SAMPLE_MC);
    const itemId = ((await created.json()) as { item: { id: string } }).item.id;
    const res = await patchItem(aid, itemId, {
      type: "short_text",
      stem: "x",
      correct_answer: "y",
    });
    expect(res.status).toBe(400);
  });
});

describe("items DELETE collapses positions", () => {
  test("removing the middle item leaves contiguous positions", async () => {
    asUser("teacher-1");
    const aid = await createAssessment("x");
    const a = await createItem(aid, { ...SAMPLE_MC, stem: "A" });
    const b = await createItem(aid, { ...SAMPLE_MC, stem: "B" });
    const c = await createItem(aid, { ...SAMPLE_MC, stem: "C" });
    const bid = ((await b.json()) as { item: { id: string } }).item.id;

    const del = await deleteItem(aid, bid);
    expect(del.status).toBe(204);

    const list = await listItems(aid);
    const body = (await list.json()) as { items: { stem: string; position: number }[] };
    expect(body.items.map((i) => [i.stem, i.position])).toEqual([
      ["A", 0],
      ["C", 1],
    ]);
  });
});

describe("items reorder", () => {
  test("rewrites positions atomically", async () => {
    asUser("teacher-1");
    const aid = await createAssessment("x");
    const a = await createItem(aid, { ...SAMPLE_MC, stem: "A" });
    const b = await createItem(aid, { ...SAMPLE_MC, stem: "B" });
    const c = await createItem(aid, { ...SAMPLE_MC, stem: "C" });
    const ids = await Promise.all([a, b, c].map(async (r) => {
      return ((await r.json()) as { item: { id: string } }).item.id;
    }));

    const res = await reorderItems(aid, [ids[2]!, ids[0]!, ids[1]!]);
    expect(res.status).toBe(200);

    const list = await listItems(aid);
    const body = (await list.json()) as { items: { stem: string; position: number }[] };
    expect(body.items.map((i) => i.stem)).toEqual(["C", "A", "B"]);
  });

  test("rejects ordered_ids containing an unknown id", async () => {
    asUser("teacher-1");
    const aid = await createAssessment("x");
    const a = await createItem(aid, SAMPLE_MC);
    const aid_id = ((await a.json()) as { item: { id: string } }).item.id;
    const res = await reorderItems(aid, [
      aid_id,
      "00000000-0000-0000-0000-000000000001",
    ]);
    expect(res.status).toBe(400);
  });

  test("rejects wrong-length ordered_ids", async () => {
    asUser("teacher-1");
    const aid = await createAssessment("x");
    await createItem(aid, SAMPLE_MC);
    await createItem(aid, { ...SAMPLE_MC, stem: "B" });
    const res = await reorderItems(aid, [
      "00000000-0000-0000-0000-000000000001",
    ]);
    expect(res.status).toBe(400);
  });
});

describe("export route", () => {
  test("emits ItemBundleSchema-conformant JSON for single-select items", async () => {
    asUser("teacher-1");
    const aid = await createAssessment("Exportable");
    await createItem(aid, SAMPLE_MC);
    await createItem(aid, { ...SAMPLE_MC, stem: "Q2", correct_choice_ids: ["a"] });

    const res = await exportAssessment(aid);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-skipped-items")).toBe("0");
    const text = await res.text();
    const parsed = ItemBundleSchema.parse(JSON.parse(text));
    expect(parsed.items.length).toBe(2);
    const first = parsed.items[0]!;
    expect(first.type).toBe("multiple_choice_single");
    if (first.type === "multiple_choice_single") {
      expect(first.correct_choice_id).toBe("b");
    }
  });

  test("bundles referenced asset bytes inline (slice 15)", async () => {
    asUser("teacher-1");
    // Insert an asset row + storage payload first via the upload API.
    const png = new Uint8Array([
      137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82,
      0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137,
      0, 0, 0, 13, 73, 68, 65, 84, 120, 156, 99, 0, 1, 0, 0, 5,
      0, 1, 13, 10, 45, 180, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
    ]);
    const { POST: uploadPost } = await import("../app/api/uploads/image/route");
    const form = new FormData();
    form.append(
      "file",
      new Blob(
        [png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) as ArrayBuffer],
        { type: "image/png" },
      ),
      "pixel.png",
    );
    const uploadRes = await uploadPost(
      new Request("http://localhost/api/uploads/image", {
        method: "POST",
        body: form,
      }),
    );
    expect(uploadRes.status).toBe(201);
    const uploadBody = (await uploadRes.json()) as { asset: { id: string } };
    const assetId = uploadBody.asset.id;

    const aid = await createAssessment("With image");
    await createItem(aid, {
      type: "multiple_choice_single",
      stem: `See ![pixel](asset:${assetId}) below.`,
      choices: [
        { id: "a", text: "yes" },
        { id: "b", text: "no" },
      ],
      correct_choice_ids: ["a"],
    });

    const res = await exportAssessment(aid);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-bundled-asset-count")).toBe("1");
    const text = await res.text();
    const parsed = ItemBundleSchema.parse(JSON.parse(text));
    expect(parsed.assets).toBeDefined();
    const lowerId = assetId.toLowerCase();
    expect(parsed.assets![lowerId]).toBeDefined();
    expect(parsed.assets![lowerId]!.content_type).toBe("image/png");
    // base64 round-trip restores the original bytes exactly.
    const decoded = Buffer.from(parsed.assets![lowerId]!.base64, "base64");
    expect(Array.from(decoded)).toEqual(Array.from(png));
  });

  test("omits assets when there are no image refs", async () => {
    asUser("teacher-1");
    const aid = await createAssessment("No images");
    await createItem(aid, SAMPLE_MC);
    const res = await exportAssessment(aid);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-bundled-asset-count")).toBe("0");
    const parsed = ItemBundleSchema.parse(JSON.parse(await res.text()));
    expect(parsed.assets).toBeUndefined();
  });

  test("emits all three item types now that the wire format supports them (slice 8)", async () => {
    asUser("teacher-1");
    const aid = await createAssessment("Mixed");
    await createItem(aid, SAMPLE_MC);
    await createItem(aid, {
      type: "multiple_choice_multi",
      stem: "Multi",
      choices: [
        { id: "x", text: "X" },
        { id: "y", text: "Y" },
      ],
      correct_choice_ids: ["x", "y"],
    });
    await createItem(aid, {
      type: "short_text",
      stem: "Short",
      correct_answer: "ans",
    });

    const res = await exportAssessment(aid);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-skipped-items")).toBe("0");
    const parsed = ItemBundleSchema.parse(JSON.parse(await res.text()));
    expect(parsed.items.length).toBe(3);
    const types = parsed.items.map((i) => i.type).sort();
    expect(types).toEqual([
      "multiple_choice_multi",
      "multiple_choice_single",
      "short_text",
    ]);

    const multi = parsed.items.find((i) => i.type === "multiple_choice_multi");
    if (multi && multi.type === "multiple_choice_multi") {
      expect(multi.correct_choice_ids).toEqual(["x", "y"]);
    }
    const short = parsed.items.find((i) => i.type === "short_text");
    if (short && short.type === "short_text") {
      expect(short.correct_answer).toBe("ans");
    }
  });
});

describe("slice 19 — publish lock on item routes", () => {
  // Helper: publish an assessment so subsequent mutations hit the lock.
  async function publish(aid: string) {
    const { PATCH } = await import("../app/api/assessments/[id]/route");
    const req = new Request(`http://localhost/api/assessments/${aid}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "published" }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: aid }) });
    expect(res.status).toBe(200);
  }

  test("POST item is rejected with 409 when parent is published", async () => {
    asUser("teacher-1");
    const aid = await createAssessment("x");
    await publish(aid);
    const res = await createItem(aid, SAMPLE_MC);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("assessment_published_editing_locked");
  });

  test("PATCH item is rejected when parent is published", async () => {
    asUser("teacher-1");
    const aid = await createAssessment("x");
    const created = await createItem(aid, SAMPLE_MC);
    const itemId = ((await created.json()) as { item: { id: string } }).item.id;
    await publish(aid);
    const res = await patchItem(aid, itemId, {
      ...SAMPLE_MC,
      stem: "edit attempt",
    });
    expect(res.status).toBe(409);
  });

  test("DELETE item is rejected when parent is published", async () => {
    asUser("teacher-1");
    const aid = await createAssessment("x");
    const created = await createItem(aid, SAMPLE_MC);
    const itemId = ((await created.json()) as { item: { id: string } }).item.id;
    await publish(aid);
    const res = await deleteItem(aid, itemId);
    expect(res.status).toBe(409);
  });

  test("reorder is rejected when parent is published", async () => {
    asUser("teacher-1");
    const aid = await createAssessment("x");
    const a = await createItem(aid, SAMPLE_MC);
    const b = await createItem(aid, { ...SAMPLE_MC, stem: "B" });
    const aId = ((await a.json()) as { item: { id: string } }).item.id;
    const bId = ((await b.json()) as { item: { id: string } }).item.id;
    await publish(aid);
    const res = await reorderItems(aid, [bId, aId]);
    expect(res.status).toBe(409);
  });

  test("read paths (list, export) still work while published", async () => {
    asUser("teacher-1");
    const aid = await createAssessment("x");
    await createItem(aid, SAMPLE_MC);
    await publish(aid);
    const list = await listItems(aid);
    expect(list.status).toBe(200);
    const exp = await exportAssessment(aid);
    expect(exp.status).toBe(200);
  });
});

describe("slice 21 — export bundles accommodations + construct_altering", () => {
  async function createWithAccoms(
    name: string,
    allowed: string[],
    ca: string[],
  ): Promise<string> {
    const { POST } = await import("../app/api/assessments/route");
    const req = new Request("http://localhost/api/assessments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name,
        allowed_accommodations: allowed,
        construct_altering: ca,
      }),
    });
    const res = await POST(req);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { assessment: { id: string } };
    return body.assessment.id;
  }

  test("emits both arrays when present", async () => {
    asUser("teacher-1");
    const aid = await createWithAccoms(
      "with-accoms",
      ["color_contrast", "tts_for_ela_reading"],
      ["tts_for_ela_reading"],
    );
    await createItem(aid, SAMPLE_MC);
    const res = await exportAssessment(aid);
    expect(res.status).toBe(200);
    const parsed = ItemBundleSchema.parse(JSON.parse(await res.text()));
    expect(parsed.allowed_accommodations).toEqual([
      "color_contrast",
      "tts_for_ela_reading",
    ]);
    expect(parsed.construct_altering).toEqual(["tts_for_ela_reading"]);
  });

  test("omits both fields when arrays are empty (byte-stable for older bundles)", async () => {
    asUser("teacher-1");
    const aid = await createAssessment("empty-accoms");
    await createItem(aid, SAMPLE_MC);
    const res = await exportAssessment(aid);
    expect(res.status).toBe(200);
    const json = JSON.parse(await res.text()) as Record<string, unknown>;
    expect("allowed_accommodations" in json).toBe(false);
    expect("construct_altering" in json).toBe(false);
  });

  test("emits only allowed_accommodations when construct_altering is empty", async () => {
    asUser("teacher-1");
    const aid = await createWithAccoms(
      "allowed-only",
      ["color_contrast"],
      [],
    );
    await createItem(aid, SAMPLE_MC);
    const res = await exportAssessment(aid);
    const json = JSON.parse(await res.text()) as Record<string, unknown>;
    expect(json.allowed_accommodations).toEqual(["color_contrast"]);
    expect("construct_altering" in json).toBe(false);
  });
});

describe("slice 32 — essay item type", () => {
  test("creates an essay with stem only (empty config)", async () => {
    asUser("teacher-1");
    const aid = await createAssessment("essay-min");
    const res = await createItem(aid, {
      type: "essay",
      stem: "Discuss the causes of WWI.",
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as {
      item: { type: string; config: Record<string, unknown> };
    };
    expect(created.item.type).toBe("essay");
    expect(created.item.config).toEqual({});
  });

  test("persists max_word_count + placeholder into config", async () => {
    asUser("teacher-1");
    const aid = await createAssessment("essay-cfg");
    const res = await createItem(aid, {
      type: "essay",
      stem: "Explain.",
      max_word_count: 250,
      placeholder: "Write your response…",
    });
    expect(res.status).toBe(201);
    const list = await listItems(aid);
    const body = (await list.json()) as {
      items: { config: { max_word_count?: number; placeholder?: string } }[];
    };
    expect(body.items[0]!.config.max_word_count).toBe(250);
    expect(body.items[0]!.config.placeholder).toBe("Write your response…");
  });

  test("rejects an essay carrying choices", async () => {
    asUser("teacher-1");
    const aid = await createAssessment("essay-bad");
    const res = await createItem(aid, {
      type: "essay",
      stem: "x",
      choices: [{ id: "a", text: "nope" }],
    });
    expect(res.status).toBe(400);
  });

  test("rejects a non-positive max_word_count", async () => {
    asUser("teacher-1");
    const aid = await createAssessment("essay-bad2");
    const res = await createItem(aid, {
      type: "essay",
      stem: "x",
      max_word_count: 0,
    });
    expect(res.status).toBe(400);
  });

  test("export emits essay with metadata when set", async () => {
    asUser("teacher-1");
    const aid = await createAssessment("essay-export");
    await createItem(aid, {
      type: "essay",
      stem: "Prompt",
      max_word_count: 300,
      placeholder: "Go",
    });
    const res = await exportAssessment(aid);
    expect(res.status).toBe(200);
    const parsed = ItemBundleSchema.parse(JSON.parse(await res.text()));
    const essay = parsed.items.find((i) => i.type === "essay");
    expect(essay).toBeDefined();
    if (essay && essay.type === "essay") {
      expect(essay.max_word_count).toBe(300);
      expect(essay.placeholder).toBe("Go");
    }
  });

  test("export omits essay metadata keys when unset (byte-stable)", async () => {
    asUser("teacher-1");
    const aid = await createAssessment("essay-export-min");
    await createItem(aid, { type: "essay", stem: "Prompt only" });
    const res = await exportAssessment(aid);
    const json = JSON.parse(await res.text()) as {
      items: Record<string, unknown>[];
    };
    const essay = json.items.find((i) => i.type === "essay")!;
    expect("max_word_count" in essay).toBe(false);
    expect("placeholder" in essay).toBe(false);
  });
});

describe("slice 33 — essay rubric", () => {
  const analyticRubric = {
    style: "analytic",
    criteria: [
      {
        id: "c1",
        name: "Thesis",
        levels: [
          { id: "l1", label: "Weak", points: 0 },
          { id: "l2", label: "Strong", points: 2, descriptor: "Clear thesis" },
        ],
      },
    ],
    student_visibility: { during_test: true, with_feedback: false },
  };

  test("persists a rubric into config", async () => {
    asUser("teacher-1");
    const aid = await createAssessment("essay-rubric");
    const res = await createItem(aid, {
      type: "essay",
      stem: "Write.",
      rubric: analyticRubric,
    });
    expect(res.status).toBe(201);
    const list = await listItems(aid);
    const body = (await list.json()) as {
      items: { config: { rubric?: { style: string; criteria: unknown[] } } }[];
    };
    expect(body.items[0]!.config.rubric?.style).toBe("analytic");
    expect(body.items[0]!.config.rubric?.criteria.length).toBe(1);
  });

  test("rejects an invalid rubric (holistic with two criteria)", async () => {
    asUser("teacher-1");
    const aid = await createAssessment("essay-bad-rubric");
    const res = await createItem(aid, {
      type: "essay",
      stem: "x",
      rubric: {
        style: "holistic",
        criteria: [
          analyticRubric.criteria[0],
          {
            id: "c2",
            name: "B",
            levels: [
              { id: "l3", label: "a", points: 0 },
              { id: "l4", label: "b", points: 1 },
            ],
          },
        ],
      },
    });
    expect(res.status).toBe(400);
  });

  test("export round-trips the rubric", async () => {
    asUser("teacher-1");
    const aid = await createAssessment("essay-rubric-export");
    await createItem(aid, {
      type: "essay",
      stem: "Write.",
      rubric: analyticRubric,
    });
    const res = await exportAssessment(aid);
    expect(res.status).toBe(200);
    const parsed = ItemBundleSchema.parse(JSON.parse(await res.text()));
    const essay = parsed.items.find((i) => i.type === "essay");
    expect(essay).toBeDefined();
    if (essay && essay.type === "essay") {
      expect(essay.rubric?.style).toBe("analytic");
      expect(essay.rubric?.student_visibility?.during_test).toBe(true);
    }
  });
});

// Slice 46: the DB type column is plain text, so a forged/legacy row can
// carry a type the exporter doesn't know. That used to silently export as
// short_text (dropping the row's real fields); now it 500s and names the
// item instead of emitting a wrong bundle.
describe("export dispatch hardening (slice 46)", () => {
  test("unknown item type → 500 unknown_item_type naming the item", async () => {
    const aid = await createAssessment("forged-type");
    const created = await createItem(aid, {
      type: "short_text",
      stem: "Legit question",
      correct_answer: "ok",
    });
    expect(created.status).toBe(201);
    const db = getDb();
    await db.execute(
      sql`update items set type = 'banana' where assessment_id = ${aid}`,
    );
    const res = await exportAssessment(aid);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; item_id: string };
    expect(body.error).toBe("unknown_item_type");
    expect(body.item_id).toBeTruthy();
  });
});

// Slice 47: match items through the write boundary + bundle round-trip.
describe("match items (slice 47)", () => {
  const PAIRS = [
    { id: "p1", left: "Dog", right: "Woof" },
    { id: "p2", left: "Cat", right: "Meow" },
    { id: "p3", left: "Cow", right: "Moo" },
  ];

  test("create → export round-trips pairs through the bundle", async () => {
    const aid = await createAssessment("match-rt");
    const res = await createItem(aid, {
      type: "match",
      stem: "Match each animal to its sound",
      pairs: PAIRS,
    });
    expect(res.status).toBe(201);
    const exportRes = await exportAssessment(aid);
    expect(exportRes.status).toBe(200);
    const bundle = ItemBundleSchema.parse(await exportRes.json());
    const m = bundle.items.find((i) => i.type === "match");
    expect(m).toBeDefined();
    if (m && m.type === "match") {
      expect(m.pairs).toEqual(PAIRS);
    }
  });

  test("rejects fewer than two pairs", async () => {
    const aid = await createAssessment("match-min");
    const res = await createItem(aid, {
      type: "match",
      stem: "Too few",
      pairs: [PAIRS[0]],
    });
    expect(res.status).toBe(400);
  });

  test("rejects duplicate pair ids", async () => {
    const aid = await createAssessment("match-dupe");
    const res = await createItem(aid, {
      type: "match",
      stem: "Dupes",
      pairs: [
        { id: "p1", left: "A", right: "B" },
        { id: "p1", left: "C", right: "D" },
      ],
    });
    expect(res.status).toBe(400);
  });

  test("rejects scoring_method ai (match allows auto/human only)", async () => {
    const aid = await createAssessment("match-scoring");
    const res = await createItem(aid, {
      type: "match",
      stem: "Bad scoring",
      pairs: PAIRS,
      scoring_method: "ai",
    });
    expect(res.status).toBe(400);
  });
});

// Slice 48: order items through the write boundary + bundle round-trip.
describe("order items (slice 48)", () => {
  const SEQUENCE = [
    { id: "s1", label: "Wake up" },
    { id: "s2", label: "Eat breakfast" },
    { id: "s3", label: "Go to school" },
  ];

  test("create → export round-trips the sequence through the bundle", async () => {
    const aid = await createAssessment("order-rt");
    const res = await createItem(aid, {
      type: "order",
      stem: "Put the morning routine in order",
      sequence: SEQUENCE,
    });
    expect(res.status).toBe(201);
    const exportRes = await exportAssessment(aid);
    expect(exportRes.status).toBe(200);
    const bundle = ItemBundleSchema.parse(await exportRes.json());
    const o = bundle.items.find((i) => i.type === "order");
    expect(o).toBeDefined();
    if (o && o.type === "order") {
      expect(o.sequence).toEqual(SEQUENCE);
    }
  });

  test("rejects fewer than two entries", async () => {
    const aid = await createAssessment("order-min");
    const res = await createItem(aid, {
      type: "order",
      stem: "Too few",
      sequence: [SEQUENCE[0]],
    });
    expect(res.status).toBe(400);
  });

  test("rejects duplicate entry ids", async () => {
    const aid = await createAssessment("order-dupe");
    const res = await createItem(aid, {
      type: "order",
      stem: "Dupes",
      sequence: [
        { id: "s1", label: "A" },
        { id: "s1", label: "B" },
      ],
    });
    expect(res.status).toBe(400);
  });

  test("rejects scoring_method hybrid (order allows auto/human only)", async () => {
    const aid = await createAssessment("order-scoring");
    const res = await createItem(aid, {
      type: "order",
      stem: "Bad scoring",
      sequence: SEQUENCE,
      scoring_method: "hybrid",
    });
    expect(res.status).toBe(400);
  });
});

// Slice 49: hotspot items — draft create, configured round-trip, integrity.
describe("hotspot items (slice 49)", () => {
  const IMAGE_ID = "33333333-3333-3333-3333-333333333333";
  const REGIONS = [
    { id: "r1", x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
    { id: "r2", x: 0.5, y: 0.5, w: 0.3, h: 0.3 },
  ];

  test("draft create (stem only) → 201; configured PATCH → export round-trip", async () => {
    const aid = await createAssessment("hotspot-rt");
    const created = await createItem(aid, { type: "hotspot", stem: "Mark the capital" });
    expect(created.status).toBe(201);
    const { item } = (await created.json()) as { item: { id: string } };
    const patched = await patchItem(aid, item.id, {
      type: "hotspot",
      stem: "Mark the capital",
      image_asset_id: IMAGE_ID,
      regions: REGIONS,
      correct_region_ids: ["r1"],
    });
    expect(patched.status).toBe(200);
    const exportRes = await exportAssessment(aid);
    expect(exportRes.status).toBe(200);
    const bundle = ItemBundleSchema.parse(await exportRes.json());
    const h = bundle.items.find((i) => i.type === "hotspot");
    expect(h).toBeDefined();
    if (h && h.type === "hotspot") {
      expect(h.image_asset_id).toBe(IMAGE_ID);
      expect(h.regions).toEqual(REGIONS);
      expect(h.correct_region_ids).toEqual(["r1"]);
    }
  });

  test("rejects a key referencing an unknown region", async () => {
    const aid = await createAssessment("hotspot-badkey");
    const res = await createItem(aid, {
      type: "hotspot",
      stem: "Bad key",
      image_asset_id: IMAGE_ID,
      regions: REGIONS,
      correct_region_ids: ["r9"],
    });
    expect(res.status).toBe(400);
  });

  test("rejects a region overflowing the image (x+w > 1)", async () => {
    const aid = await createAssessment("hotspot-overflow");
    const res = await createItem(aid, {
      type: "hotspot",
      stem: "Overflow",
      image_asset_id: IMAGE_ID,
      regions: [{ id: "r1", x: 0.9, y: 0.1, w: 0.5, h: 0.2 }],
    });
    expect(res.status).toBe(400);
  });

  test("rejects duplicate region ids", async () => {
    const aid = await createAssessment("hotspot-dupe");
    const res = await createItem(aid, {
      type: "hotspot",
      stem: "Dupes",
      image_asset_id: IMAGE_ID,
      regions: [
        { id: "r1", x: 0.1, y: 0.1, w: 0.1, h: 0.1 },
        { id: "r1", x: 0.5, y: 0.5, w: 0.1, h: 0.1 },
      ],
    });
    expect(res.status).toBe(400);
  });
});

// Slice 50: drawing/upload items — authoring-only.
describe("drawing_upload items (slice 50)", () => {
  test("bare create → 201; configured PATCH → export round-trip", async () => {
    const aid = await createAssessment("drawing-rt");
    const created = await createItem(aid, {
      type: "drawing_upload",
      stem: "Draw the water cycle",
    });
    expect(created.status).toBe(201);
    const { item } = (await created.json()) as { item: { id: string } };
    const patched = await patchItem(aid, item.id, {
      type: "drawing_upload",
      stem: "Draw the water cycle",
      prompt_asset_id: "99999999-9999-9999-9999-999999999999",
      canvas: { width: 1024, height: 768 },
    });
    expect(patched.status).toBe(200);
    const bundle = ItemBundleSchema.parse(await (await exportAssessment(aid)).json());
    const d = bundle.items.find((i) => i.type === "drawing_upload");
    expect(d).toBeDefined();
    if (d && d.type === "drawing_upload") {
      expect(d.prompt_asset_id).toBe("99999999-9999-9999-9999-999999999999");
      expect(d.canvas).toEqual({ width: 1024, height: 768 });
    }
  });

  test("rejects scoring_method auto (human only — nothing machine-checkable)", async () => {
    const aid = await createAssessment("drawing-scoring");
    const res = await createItem(aid, {
      type: "drawing_upload",
      stem: "Bad scoring",
      scoring_method: "auto",
    });
    expect(res.status).toBe(400);
  });

  test("rejects out-of-range canvas", async () => {
    const aid = await createAssessment("drawing-canvas");
    const res = await createItem(aid, {
      type: "drawing_upload",
      stem: "Huge",
      canvas: { width: 9000, height: 600 },
    });
    expect(res.status).toBe(400);
  });

  // Drawing background (docs/drawing-background-design.md): one optional
  // value on canvas, stored in items.config whole.
  test("stores canvas.background grid and axes in config", async () => {
    const aid = await createAssessment("drawing-background");
    for (const background of ["grid", "axes"] as const) {
      const created = await createItem(aid, {
        type: "drawing_upload",
        stem: `Graph it (${background})`,
        canvas: { width: 800, height: 600, background },
      });
      expect(created.status).toBe(201);
      const { item } = (await created.json()) as { item: { id: string } };
      const db = getDb();
      const rows = (await db.execute(
        sql`select config from items where id = ${item.id}`,
      )) as unknown as { config: { canvas?: unknown } }[];
      expect(rows[0]!.config.canvas).toEqual({ width: 800, height: 600, background });

      // The teacher bundle carries it too (export passes canvas through whole
      // — this proves the wire schema does not strip the new sub-field).
      const bundle = ItemBundleSchema.parse(await (await exportAssessment(aid)).json());
      const exported = bundle.items.find((i) => i.id === item.id);
      expect(exported?.type).toBe("drawing_upload");
      if (exported && exported.type === "drawing_upload") {
        expect(exported.canvas).toEqual({ width: 800, height: 600, background });
      }

      // And a PATCH back to blank drops the field rather than storing null.
      const patched = await patchItem(aid, item.id, {
        type: "drawing_upload",
        stem: `Graph it (${background})`,
        canvas: { width: 800, height: 600 },
      });
      expect(patched.status).toBe(200);
      const after = (await db.execute(
        sql`select config from items where id = ${item.id}`,
      )) as unknown as { config: { canvas?: unknown } }[];
      expect(after[0]!.config.canvas).toEqual({ width: 800, height: 600 });
    }
  });

  test("rejects an unknown background value", async () => {
    const aid = await createAssessment("drawing-background-bad");
    const res = await createItem(aid, {
      type: "drawing_upload",
      stem: "Dots please",
      canvas: { width: 800, height: 600, background: "dots" },
    });
    expect(res.status).toBe(400);
  });

  // The editor supplies 800 × 600 when a teacher picks a background with no
  // size; the API invents nothing — width and height stay required.
  test("rejects a canvas that carries a background but no size", async () => {
    const aid = await createAssessment("drawing-background-nosize");
    const res = await createItem(aid, {
      type: "drawing_upload",
      stem: "Sizeless",
      canvas: { background: "grid" },
    });
    expect(res.status).toBe(400);
  });
});

// Code-review fix (2026-08-14): a forged/legacy non-uuid config asset ref
// must not 500 the export (Postgres 22P02 via inArray on the uuid column) —
// assetIdsFromItemConfig drops it before the query.
describe("export survives forged non-uuid config asset refs", () => {
  test("hotspot with a non-uuid image_asset_id exports 200", async () => {
    const aid = await createAssessment("forged-asset-ref");
    const created = await createItem(aid, { type: "hotspot", stem: "Draft" });
    expect(created.status).toBe(201);
    const db = getDb();
    await db.execute(
      sql`update items set config = '{"image_asset_id":"ref-1","regions":[],"correct_region_ids":[]}'::jsonb where assessment_id = ${aid}`,
    );
    const res = await exportAssessment(aid);
    expect(res.status).toBe(200);
  });
});

// Review fix (2026-08-14): a rubric whose total max is 0 is rejected at
// authoring — it could never be finalized (max_points > 0 is a DB CHECK).
describe("zero-max rubric rejection (review fix)", () => {
  test("essay with an all-zero single_point rubric → 400", async () => {
    const aid = await createAssessment("zero-rubric");
    const res = await createItem(aid, {
      type: "essay",
      stem: "Write it",
      rubric: {
        style: "single_point",
        criteria: [
          {
            id: "c1",
            name: "Target",
            levels: [{ id: "l1", label: "Target", points: 0 }],
          },
        ],
      },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { detail?: string };
    expect(String(body.detail)).toMatch(/max points must be > 0/);
  });

  test("essay with a positive-max rubric → 201", async () => {
    const aid = await createAssessment("ok-rubric");
    const res = await createItem(aid, {
      type: "essay",
      stem: "Write it",
      rubric: {
        style: "single_point",
        criteria: [
          {
            id: "c1",
            name: "Target",
            levels: [{ id: "l1", label: "Target", points: 1 }],
          },
        ],
      },
    });
    expect(res.status).toBe(201);
  });
});

// Review fix (2026-08-14, finding 8): scoring_method PATCH semantics —
// omitted preserves, explicit null clears, value sets.
describe("scoring_method PATCH semantics (review fix)", () => {
  async function createHumanMc(aid: string) {
    const res = await createItem(aid, {
      type: "multiple_choice_single",
      stem: "Q",
      choices: [
        { id: "a", text: "A" },
        { id: "b", text: "B" },
      ],
      correct_choice_ids: ["a"],
      scoring_method: "human",
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { item: { id: string } }).item.id;
  }
  const baseBody = {
    type: "multiple_choice_single",
    stem: "Q edited",
    choices: [
      { id: "a", text: "A" },
      { id: "b", text: "B" },
    ],
    correct_choice_ids: ["a"],
  };

  test("PATCH omitting scoring_method preserves the stored pick", async () => {
    const aid = await createAssessment("sm-preserve");
    const itemId = await createHumanMc(aid);
    const res = await patchItem(aid, itemId, baseBody);
    expect(res.status).toBe(200);
    const { item } = (await res.json()) as {
      item: { config: { scoring_method?: string } };
    };
    expect(item.config.scoring_method).toBe("human");
  });

  test("PATCH with explicit null clears back to the type default", async () => {
    const aid = await createAssessment("sm-clear");
    const itemId = await createHumanMc(aid);
    const res = await patchItem(aid, itemId, {
      ...baseBody,
      scoring_method: null,
    });
    expect(res.status).toBe(200);
    const { item } = (await res.json()) as {
      item: { config: { scoring_method?: string } };
    };
    expect(item.config.scoring_method).toBeUndefined();
  });

  test("PATCH with a value replaces the stored pick", async () => {
    const aid = await createAssessment("sm-set");
    const itemId = await createHumanMc(aid);
    const res = await patchItem(aid, itemId, {
      ...baseBody,
      scoring_method: "auto",
    });
    expect(res.status).toBe(200);
    const { item } = (await res.json()) as {
      item: { config: { scoring_method?: string } };
    };
    expect(item.config.scoring_method).toBe("auto");
  });
});

// 2026-09-01: answer keys are optional at write time (keyless PDF imports)
// and the publish lock admits key-only edits so a teacher can fill a key
// after publishing. Anything else on a published item still 409s.
describe("answer keys — optional to save, editable while published", () => {
  async function publishAssessment(aid: string) {
    const { PATCH } = await import("../app/api/assessments/[id]/route");
    const res = await PATCH(
      new Request(`http://localhost/api/assessments/${aid}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "published" }),
      }),
      { params: Promise.resolve({ id: aid }) },
    );
    expect(res.status).toBe(200);
  }

  test("single-select MC with no correct choice is stored keyless", async () => {
    asUser("teacher-1");
    const aid = await createAssessment("keyless");
    const res = await createItem(aid, { ...SAMPLE_MC, correct_choice_ids: [] });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { item: { correct_choice_ids: string[] } };
    expect(body.item.correct_choice_ids).toEqual([]);
  });

  test("single-select MC still allows at most one correct choice", async () => {
    asUser("teacher-1");
    const aid = await createAssessment("two keys");
    const res = await createItem(aid, { ...SAMPLE_MC, correct_choice_ids: ["a", "b"] });
    expect(res.status).toBe(400);
  });

  test("short_text with an empty correct answer is stored keyless", async () => {
    asUser("teacher-1");
    const aid = await createAssessment("keyless st");
    const res = await createItem(aid, {
      type: "short_text",
      stem: "Capital of Washington?",
      correct_answer: "",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { item: { correct_answer: string | null } };
    expect(body.item.correct_answer ?? "").toBe("");
  });

  test("while published, a PATCH that only fills the answer key is accepted", async () => {
    asUser("teacher-1");
    const aid = await createAssessment("fill key later");
    const created = await createItem(aid, { ...SAMPLE_MC, correct_choice_ids: [] });
    const itemId = ((await created.json()) as { item: { id: string } }).item.id;
    await publishAssessment(aid);
    const res = await patchItem(aid, itemId, { ...SAMPLE_MC, correct_choice_ids: ["b"] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { item: { correct_choice_ids: string[]; stem: string } };
    expect(body.item.correct_choice_ids).toEqual(["b"]);
    expect(body.item.stem).toBe(SAMPLE_MC.stem);
  });

  test("while published, a PATCH that changes the key AND the stem is still 409", async () => {
    asUser("teacher-1");
    const aid = await createAssessment("smuggle");
    const created = await createItem(aid, { ...SAMPLE_MC, correct_choice_ids: [] });
    const itemId = ((await created.json()) as { item: { id: string } }).item.id;
    await publishAssessment(aid);
    const res = await patchItem(aid, itemId, {
      ...SAMPLE_MC,
      correct_choice_ids: ["b"],
      stem: "reworded while published",
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; hint: string };
    expect(body.error).toBe("assessment_published_editing_locked");
    expect(body.hint).toMatch(/only the answer key/);
  });

  test("while published, changing a choice's text is 409 even with the key unchanged", async () => {
    asUser("teacher-1");
    const aid = await createAssessment("choice text");
    const created = await createItem(aid, SAMPLE_MC);
    const itemId = ((await created.json()) as { item: { id: string } }).item.id;
    await publishAssessment(aid);
    const res = await patchItem(aid, itemId, {
      ...SAMPLE_MC,
      choices: [
        { id: "a", text: "3" },
        { id: "b", text: "four" },
      ],
    });
    expect(res.status).toBe(409);
  });
});

// E3 slice 1: table items through the API (docs/e3-table-item-design.md).
describe("items: table (E3)", () => {
  const TABLE = {
    type: "table",
    stem: "Enter the values from your calculations in the table below.",
    columns: [
      { id: "c1", label: "End with glucose" },
      { id: "c2", label: "Middle" },
      { id: "c3", label: "Total" },
    ],
    rows: [
      { id: "r1", label: "Observed (o)" },
      { id: "r2", label: "Expected (e)" },
    ],
    corner: "Chamber positions",
    cell_keys: { r1: { c1: "12", c3: "30" }, r2: { c2: "4.5" } },
  };

  test("creates a keyed table and stores the grid + keys in config", async () => {
    asUser("teacher-1");
    const aid = await createAssessment("table");
    const res = await createItem(aid, TABLE);
    expect(res.status).toBe(201);
    const { item } = (await res.json()) as {
      item: { type: string; choices: unknown[]; correct_answer: string | null; config: Record<string, unknown> };
    };
    expect(item.type).toBe("table");
    expect(item.choices).toEqual([]);
    expect(item.correct_answer).toBeNull();
    expect(item.config.columns).toEqual(TABLE.columns);
    expect(item.config.rows).toEqual(TABLE.rows);
    expect(item.config.corner).toBe("Chamber positions");
    expect(item.config.cell_keys).toEqual(TABLE.cell_keys);
  });

  test("a keyless table is a legal draft; an empty key object stores no key", async () => {
    asUser("teacher-1");
    const aid = await createAssessment("table");
    const { cell_keys: _k, corner: _c, ...keyless } = TABLE;
    const res = await createItem(aid, keyless);
    expect(res.status).toBe(201);
    const { item } = (await res.json()) as { item: { config: Record<string, unknown> } };
    expect(item.config).not.toHaveProperty("cell_keys");
    expect(item.config).not.toHaveProperty("corner");

    const emptyKeys = await createItem(aid, { ...keyless, cell_keys: { r1: {} } });
    expect(emptyKeys.status).toBe(201);
    const { item: item2 } = (await emptyKeys.json()) as { item: { config: Record<string, unknown> } };
    expect(item2.config).not.toHaveProperty("cell_keys");
  });

  test("a blank row label is allowed (D-5); a blank column label is not", async () => {
    asUser("teacher-1");
    const aid = await createAssessment("table");
    expect(
      (await createItem(aid, { ...TABLE, cell_keys: undefined, rows: [{ id: "r1", label: "" }] })).status,
    ).toBe(201);
    expect(
      (await createItem(aid, { ...TABLE, cell_keys: undefined, columns: [{ id: "c1", label: "" }] })).status,
    ).toBe(400);
  });

  test("rejects duplicate column or row ids, and keys that name a cell that does not exist", async () => {
    asUser("teacher-1");
    const aid = await createAssessment("table");
    expect(
      (await createItem(aid, { ...TABLE, columns: [{ id: "c1", label: "A" }, { id: "c1", label: "B" }], cell_keys: undefined })).status,
    ).toBe(400);
    expect(
      (await createItem(aid, { ...TABLE, rows: [{ id: "r1", label: "A" }, { id: "r1", label: "B" }], cell_keys: undefined })).status,
    ).toBe(400);
    expect((await createItem(aid, { ...TABLE, cell_keys: { r9: { c1: "1" } } })).status).toBe(400);
    expect((await createItem(aid, { ...TABLE, cell_keys: { r1: { c9: "1" } } })).status).toBe(400);
  });

  test("rejects an empty grid and more than 8 columns", async () => {
    asUser("teacher-1");
    const aid = await createAssessment("table");
    expect((await createItem(aid, { ...TABLE, cell_keys: undefined, columns: [] })).status).toBe(400);
    expect((await createItem(aid, { ...TABLE, cell_keys: undefined, rows: [] })).status).toBe(400);
    const nine = Array.from({ length: 9 }, (_, i) => ({ id: `c${i}`, label: `Col ${i}` }));
    expect((await createItem(aid, { ...TABLE, cell_keys: undefined, columns: nine })).status).toBe(400);
  });

  test("rejects choices or a correct_answer on a table", async () => {
    asUser("teacher-1");
    const aid = await createAssessment("table");
    expect((await createItem(aid, { ...TABLE, choices: [{ id: "a", text: "nope" }] })).status).toBe(400);
    expect((await createItem(aid, { ...TABLE, correct_answer: "nope" })).status).toBe(400);
  });

  test("scoring_method auto and human are allowed; ai is not", async () => {
    asUser("teacher-1");
    const aid = await createAssessment("table");
    expect((await createItem(aid, { ...TABLE, scoring_method: "human" })).status).toBe(201);
    expect((await createItem(aid, { ...TABLE, scoring_method: "ai" })).status).toBe(400);
  });

  // E3-F1 (docs/e3-table-item-design.md §Progress): a keyless table defaults
  // to hand-scored, not auto — auto has nothing to check. Any key flips the
  // default; an explicit teacher choice always wins over the key-derived one.
  test("E3-F1: effective scoring method follows cell_keys unless the teacher chose explicitly", () => {
    expect(effectiveScoringMethod("table", null)).toBe("human");
    expect(effectiveScoringMethod("table", {})).toBe("human");
    expect(effectiveScoringMethod("table", { cell_keys: { r1: { c1: "12" } } })).toBe("auto");
    expect(
      effectiveScoringMethod("table", { cell_keys: { r1: { c1: "12" } }, scoring_method: "human" }),
    ).toBe("human");
    expect(effectiveScoringMethod("table", { scoring_method: "auto" })).toBe("auto");
  });

  test("PATCH replaces the keys; export round-trips grid, corner and keys", async () => {
    asUser("teacher-1");
    const aid = await createAssessment("table");
    const created = (await (await createItem(aid, TABLE)).json()) as { item: { id: string } };
    const patched = await patchItem(aid, created.item.id, {
      ...TABLE,
      cell_keys: { r2: { c1: "7" } },
    });
    expect(patched.status).toBe(200);
    const { item } = (await patched.json()) as { item: { config: Record<string, unknown> } };
    expect(item.config.cell_keys).toEqual({ r2: { c1: "7" } });

    const exp = await exportAssessment(aid);
    expect(exp.status).toBe(200);
    const bundle = ItemBundleSchema.parse(await exp.json());
    const exported = bundle.items[0]!;
    expect(exported.type).toBe("table");
    if (exported.type === "table") {
      expect(exported.columns).toEqual(TABLE.columns);
      expect(exported.rows).toEqual(TABLE.rows);
      expect(exported.corner).toBe("Chamber positions");
      expect(exported.cell_keys).toEqual({ r2: { c1: "7" } });
    }
  });
});

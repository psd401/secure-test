// Duplicate an assessment (2026-09-16), server half.
//
// Same harness as shares-api.test.ts — direct route imports against the local
// test DB with the session helper mocked. A tmp STORAGE_LOCAL_ROOT is set so a
// real uploaded asset can prove the copy's refs point at the copy's own asset
// rows rather than the source's.
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { closeDb, getDb } from "../db/client";
import { assessments, attempts, item_sets, items, students } from "../db/schema";
import { SESSION_COOKIE_NAME } from "../lib/auth/session";
import * as sessionMod from "../lib/auth/session";

const expectTestDb = () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("secure_test_design_tool_test")) {
    throw new Error(`duplicate-assessment tests require the test DB; got: ${url}`);
  }
};

let originalSessionSecret: string | undefined;
let originalStorageRoot: string | undefined;
let tmpRoot: string;
let mockSub: string | null = null;

mock.module("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({
    get: (name: string) => (mockSub && name === SESSION_COOKIE_NAME ? { value: "x" } : undefined),
  }),
}));

mock.module("../lib/auth/session", () => ({
  ...sessionMod,
  readSessionFromCookies: async () =>
    mockSub ? { sub: mockSub, role: "staff", email: "owner.one@psd401.net" } : null,
}));

const OWNER = "duplicate-teacher";
const OTHER = "duplicate-other-teacher";

function asUser(sub: string | null) {
  mockSub = sub;
}

beforeAll(async () => {
  expectTestDb();
  originalSessionSecret = process.env.DESIGN_TOOL_SESSION_SECRET;
  process.env.DESIGN_TOOL_SESSION_SECRET = "test-session-secret-do-not-use";
  tmpRoot = await mkdtemp(join(tmpdir(), "secure-test-duplicate-"));
  originalStorageRoot = process.env.STORAGE_LOCAL_ROOT;
  process.env.STORAGE_LOCAL_ROOT = tmpRoot;
  asUser(OWNER);
});

afterEach(async () => {
  asUser(OWNER);
  const db = getDb();
  await db.execute(sql`truncate table assessments restart identity cascade`);
  await db.execute(sql`truncate table students restart identity cascade`);
  await db.execute(sql`truncate table assets restart identity cascade`);
});

afterAll(async () => {
  await closeDb();
  if (originalSessionSecret === undefined) delete process.env.DESIGN_TOOL_SESSION_SECRET;
  else process.env.DESIGN_TOOL_SESSION_SECRET = originalSessionSecret;
  if (originalStorageRoot === undefined) delete process.env.STORAGE_LOCAL_ROOT;
  else process.env.STORAGE_LOCAL_ROOT = originalStorageRoot;
  await rm(tmpRoot, { recursive: true, force: true });
});

const json = (body: unknown) => ({
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

// Minimal valid PNG: 1x1 transparent pixel (copied from uploads-api.test.ts).
const PNG_1X1 = new Uint8Array([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1,
  0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137, 0, 0, 0, 13, 73, 68, 65, 84,
  120, 156, 99, 0, 1, 0, 0, 5, 0, 1, 13, 10, 45, 180, 0, 0, 0, 0, 73, 69,
  78, 68, 174, 66, 96, 130,
]);

async function createAssessment(name: string) {
  const { POST } = await import("../app/api/assessments/route");
  const res = await POST(new Request("http://localhost/api/assessments", { method: "POST", ...json({ name }) }));
  expect(res.status).toBe(201);
  return ((await res.json()) as { assessment: { id: string } }).assessment.id;
}

async function patchAssessment(id: string, body: unknown) {
  const { PATCH } = await import("../app/api/assessments/[id]/route");
  const res = await PATCH(
    new Request(`http://localhost/api/assessments/${id}`, { method: "PATCH", ...json(body) }),
    { params: Promise.resolve({ id }) },
  );
  expect(res.status).toBe(200);
}

async function addItem(id: string, body: unknown) {
  const { POST } = await import("../app/api/assessments/[id]/items/route");
  const res = await POST(
    new Request(`http://localhost/api/assessments/${id}/items`, { method: "POST", ...json(body) }),
    { params: Promise.resolve({ id }) },
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { item: { id: string } }).item.id;
}

async function createSet(id: string, body: unknown) {
  const { POST } = await import("../app/api/assessments/[id]/item-sets/route");
  const res = await POST(
    new Request(`http://localhost/api/assessments/${id}/item-sets`, { method: "POST", ...json(body) }),
    { params: Promise.resolve({ id }) },
  );
  expect(res.status).toBe(201);
}

async function uploadPng(): Promise<string> {
  const { POST } = await import("../app/api/uploads/image/route");
  const form = new FormData();
  const bytes = PNG_1X1;
  const blob = new Blob(
    [bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer],
    { type: "image/png" },
  );
  form.append("file", blob, "pixel.png");
  const res = await POST(new Request("http://localhost/api/uploads/image", { method: "POST", body: form }));
  expect(res.status).toBe(201);
  const body = (await res.json()) as { asset?: { id: string }; id?: string };
  return body.asset?.id ?? body.id!;
}

async function duplicate(id: string) {
  const { POST } = await import("../app/api/assessments/[id]/duplicate/route");
  return POST(new Request(`http://localhost/api/assessments/${id}/duplicate`, { method: "POST" }), {
    params: Promise.resolve({ id }),
  });
}

/** An attempt on the source, so the copy can be shown to carry none. */
async function addAttempt(assessmentId: string) {
  const db = getDb();
  const [student] = await db
    .insert(students)
    .values({ owner_sub: OWNER, ssid: `dup-${Math.random().toString(36).slice(2, 10)}`, name: "Fixture Student" })
    .returning({ id: students.id });
  await db.insert(attempts).values({ assessment_id: assessmentId, student_id: student!.id });
}

const MC = {
  type: "multiple_choice_single",
  stem: "What is 2 + 2?",
  choices: [
    { id: "a", text: "3" },
    { id: "b", text: "4" },
  ],
  correct_choice_ids: ["b"],
};

/**
 * A Published assessment carrying everything the copy has to preserve: three
 * items, a two-item set with a labelled source whose text holds an asset ref,
 * a time limit, a description and both allow flags — plus one attempt.
 */
async function buildSource(name = "Unit 5") {
  const assetId = await uploadPng();
  const aid = await createAssessment(name);
  await patchAssessment(aid, {
    description: "Covers stoichiometry.",
    time_limit_seconds: 2700,
    allow_clipboard: true,
    allow_llm_authoring: true,
    student_layout: "paged",
  });
  const first = await addItem(aid, { type: "short_text", stem: "Capital of WA?", correct_answer: "Olympia" });
  const second = await addItem(aid, MC);
  const third = await addItem(aid, { ...MC, stem: "What is 3 + 3?" });
  await createSet(aid, {
    item_ids: [second, third],
    stimulus_text: "Read the sources, then answer.",
    sources: [
      { label: "A", text: `A chart.\n\n![fig](asset:${assetId})` },
      { label: "B", text: "A short article." },
    ],
    layout: "side_by_side",
  });
  await patchAssessment(aid, { status: "published" });
  await addAttempt(aid);
  return { aid, assetId, itemIds: [first, second, third] };
}

describe("duplicateAssessment", () => {
  test("a Published source copies whole: Draft, live, (copy), settings carried, no attempts", async () => {
    const { aid, assetId } = await buildSource();
    const db = getDb();

    const res = await duplicate(aid);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { ok: boolean; assessment_id: string; name: string };
    expect(body.ok).toBe(true);
    expect(body.assessment_id).not.toBe(aid);
    expect(body.name).toBe("Unit 5 (copy)");

    const [copy] = await db.select().from(assessments).where(eq(assessments.id, body.assessment_id));
    expect(copy!.owner_sub).toBe(OWNER);
    expect(copy!.name).toBe("Unit 5 (copy)");
    expect(copy!.status).toBe("draft");
    expect(copy!.archived_at).toBeNull();
    // The four settings the bundle drops.
    expect(copy!.description).toBe("Covers stoichiometry.");
    expect(copy!.time_limit_seconds).toBe(2700);
    expect(copy!.allow_clipboard).toBe(true);
    expect(copy!.allow_llm_authoring).toBe(true);
    // Carried by the bundle itself.
    expect(copy!.student_layout).toBe("paged");

    const copiedItems = await db.select().from(items).where(eq(items.assessment_id, body.assessment_id));
    expect(copiedItems).toHaveLength(3);
    expect(copiedItems.map((i) => i.stem).sort()).toEqual([
      "Capital of WA?",
      "What is 2 + 2?",
      "What is 3 + 3?",
    ]);

    const [copiedSet] = await db.select().from(item_sets).where(eq(item_sets.assessment_id, body.assessment_id));
    expect(copiedSet!.stimulus_text).toBe("Read the sources, then answer.");
    expect(copiedSet!.layout).toBe("side_by_side");
    const sources = copiedSet!.sources as { label: string; text: string }[];
    expect(sources.map((s) => s.label)).toEqual(["A", "B"]);
    // The asset ref was remapped onto the copy's own asset row. The bytes are
    // identical, so per-owner dedup reuses the SOURCE's row rather than
    // uploading a second one — the ref still resolves, which is the point.
    const refMatch = /asset:([0-9a-f-]{36})/i.exec(sources[0]!.text);
    expect(refMatch).not.toBeNull();
    expect(refMatch![1]!.toLowerCase()).toBe(assetId.toLowerCase());
    // Two of the three items belong to that set.
    expect(copiedItems.filter((i) => i.item_set_id === copiedSet!.id)).toHaveLength(2);

    // No attempts on the copy.
    expect(await db.select().from(attempts).where(eq(attempts.assessment_id, body.assessment_id))).toHaveLength(0);

    // The source is untouched.
    const [src] = await db.select().from(assessments).where(eq(assessments.id, aid));
    expect(src!.status).toBe("published");
    expect(src!.name).toBe("Unit 5");
    expect(await db.select().from(attempts).where(eq(attempts.assessment_id, aid))).toHaveLength(1);
    expect(await db.select().from(items).where(eq(items.assessment_id, aid))).toHaveLength(3);
  });

  test("the copy reuses the owner's existing asset row rather than making a second", async () => {
    const { aid } = await buildSource();
    const { duplicateAssessment } = await import("../lib/api/duplicateAssessment");
    // Access slice 1: the lib takes the already-authorized row; the route
    // ahead of it is what decides whether the caller may read it.
    const db0 = getDb();
    const [source] = await db0.select().from(assessments).where(eq(assessments.id, aid));
    const result = await duplicateAssessment(db0, source!, OWNER);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.assets_reused).toBe(1);
    expect(result.assets_imported).toBe(0);
    expect(result.item_count).toBe(3);
  });

  test("an archived source duplicates, and the copy is live", async () => {
    const { aid } = await buildSource("Archived unit");
    await patchAssessment(aid, { archived: true });
    const db = getDb();
    const [src] = await db.select().from(assessments).where(eq(assessments.id, aid));
    expect(src!.archived_at).not.toBeNull();

    const res = await duplicate(aid);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { assessment_id: string; name: string };
    expect(body.name).toBe("Archived unit (copy)");
    const [copy] = await db.select().from(assessments).where(eq(assessments.id, body.assessment_id));
    expect(copy!.archived_at).toBeNull();
    expect(copy!.status).toBe("draft");
    // The source stays archived and published.
    const [after] = await db.select().from(assessments).where(eq(assessments.id, aid));
    expect(after!.archived_at).not.toBeNull();
    expect(after!.status).toBe("published");
  });

  test("a second duplicate is named (copy 2)", async () => {
    const { aid } = await buildSource();
    expect((await (await duplicate(aid)).json() as { name: string }).name).toBe("Unit 5 (copy)");
    expect((await (await duplicate(aid)).json() as { name: string }).name).toBe("Unit 5 (copy 2)");
    const db = getDb();
    expect(await db.select().from(assessments).where(eq(assessments.owner_sub, OWNER))).toHaveLength(3);
  });

  test("a draft source duplicates too", async () => {
    const aid = await createAssessment("Draft unit");
    await addItem(aid, MC);
    const res = await duplicate(aid);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { assessment_id: string; name: string };
    expect(body.name).toBe("Draft unit (copy)");
    const db = getDb();
    expect(await db.select().from(items).where(eq(items.assessment_id, body.assessment_id))).toHaveLength(1);
  });
});

describe("POST /api/assessments/[id]/duplicate", () => {
  test("another staff sub gets 404, and makes no copy", async () => {
    const { aid } = await buildSource();
    asUser(OTHER);
    const res = await duplicate(aid);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe("not_found");
    const db = getDb();
    expect(await db.select().from(assessments).where(eq(assessments.owner_sub, OTHER))).toHaveLength(0);
  });

  test("an unknown uuid is 404 and a non-uuid is 400", async () => {
    const missing = await duplicate("11111111-1111-4111-8111-111111111111");
    expect(missing.status).toBe(404);
    const bad = await duplicate("not-a-uuid");
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe("invalid_id");
  });

  test("no session → 401", async () => {
    const { aid } = await buildSource();
    asUser(null);
    expect((await duplicate(aid)).status).toBe(401);
  });
});

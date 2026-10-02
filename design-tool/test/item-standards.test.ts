// BG slice 2 (docs/batch-item-generation-design.md, D-1): standards tags on
// items — the write boundary's normalization and limits, the publish lock,
// the teacher bundle round trip (export → import, duplicate), and the
// delivery bundle that must never carry them (ADR 0016).
//
// Same harness as items-api.test.ts — direct route imports against the local
// test DB with the session helper mocked.
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { asc, eq, sql } from "drizzle-orm";
import { ItemBundleSchema } from "@secure-test/schema";
import { assessments, items } from "../db/schema";
import { closeDb, getDb } from "../db/client";
import { SESSION_COOKIE_NAME } from "../lib/auth/session";
import * as sessionMod from "../lib/auth/session";

const expectTestDb = () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("secure_test_design_tool_test")) {
    throw new Error(`item-standards tests require the test DB DATABASE_URL; got: ${url}`);
  }
};

let originalSessionSecret: string | undefined;
let mockSub: string | null = "standards-teacher";

mock.module("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({
    get: (name: string) => (mockSub && name === SESSION_COOKIE_NAME ? { value: "x" } : undefined),
  }),
}));

mock.module("../lib/auth/session", () => ({
  ...sessionMod,
  readSessionFromCookies: async () =>
    mockSub ? { sub: mockSub, role: "staff", email: "standards.teacher@psd401.net" } : null,
}));

const MISSING_UUID = "11111111-1111-4111-8111-111111111111";

beforeAll(() => {
  expectTestDb();
  originalSessionSecret = process.env.DESIGN_TOOL_SESSION_SECRET;
  process.env.DESIGN_TOOL_SESSION_SECRET = "test-session-secret-do-not-use";
});

afterEach(async () => {
  await getDb().execute(sql`truncate table assessments restart identity cascade`);
});

afterAll(async () => {
  await closeDb();
  if (originalSessionSecret === undefined) delete process.env.DESIGN_TOOL_SESSION_SECRET;
  else process.env.DESIGN_TOOL_SESSION_SECRET = originalSessionSecret;
});

const json = (body: unknown) => ({
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

async function createAssessment(name = "Standards fixture") {
  const { POST } = await import("../app/api/assessments/route");
  const res = await POST(new Request("http://localhost/api/assessments", { method: "POST", ...json({ name }) }));
  expect(res.status).toBe(201);
  return ((await res.json()) as { assessment: { id: string } }).assessment.id;
}

async function createItem(id: string, body: unknown) {
  const { POST } = await import("../app/api/assessments/[id]/items/route");
  return POST(
    new Request(`http://localhost/api/assessments/${id}/items`, { method: "POST", ...json(body) }),
    { params: Promise.resolve({ id }) },
  );
}

async function patchItem(id: string, itemId: string, body: unknown) {
  const { PATCH } = await import("../app/api/assessments/[id]/items/[itemId]/route");
  return PATCH(
    new Request(`http://localhost/api/assessments/${id}/items/${itemId}`, { method: "PATCH", ...json(body) }),
    { params: Promise.resolve({ id, itemId }) },
  );
}

async function setStatus(id: string, status: "published" | "draft") {
  const { PATCH } = await import("../app/api/assessments/[id]/route");
  const res = await PATCH(
    new Request(`http://localhost/api/assessments/${id}`, { method: "PATCH", ...json({ status }) }),
    { params: Promise.resolve({ id }) },
  );
  expect(res.status).toBe(200);
}

async function storedStandards(assessmentId: string): Promise<string[][]> {
  const rows = await getDb()
    .select({ standards: items.standards })
    .from(items)
    .where(eq(items.assessment_id, assessmentId))
    .orderBy(asc(items.position));
  return rows.map((r) => r.standards);
}

async function exportText(id: string) {
  const { GET } = await import("../app/api/assessments/[id]/export/route");
  const res = await GET(new Request(`http://localhost/api/assessments/${id}/export`), {
    params: Promise.resolve({ id }),
  });
  expect(res.status).toBe(200);
  return res.text();
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

const SHORT = {
  type: "short_text",
  stem: "Name the ratio.",
  correct_answer: "1/2",
};

describe("items API — standards", () => {
  test("create normalizes: trim, drop empties, dedupe keeping order; GET returns them", async () => {
    const aid = await createAssessment();
    const res = await createItem(aid, {
      ...MC,
      standards: [" wa2026:M.7.R.RP.2 ", "", "Local target 3", "wa2026:M.7.R.RP.2", "   "],
    });
    expect(res.status).toBe(201);
    const { item } = (await res.json()) as { item: { id: string; standards: string[] } };
    expect(item.standards).toEqual(["wa2026:M.7.R.RP.2", "Local target 3"]);

    const { GET } = await import("../app/api/assessments/[id]/items/route");
    const list = (await (
      await GET(new Request(`http://localhost/api/assessments/${aid}/items`), {
        params: Promise.resolve({ id: aid }),
      })
    ).json()) as { items: { standards: string[] }[] };
    expect(list.items[0]!.standards).toEqual(["wa2026:M.7.R.RP.2", "Local target 3"]);
  });

  test("an item created without the field stores []", async () => {
    const aid = await createAssessment();
    expect((await createItem(aid, MC)).status).toBe(201);
    expect(await storedStandards(aid)).toEqual([[]]);
  });

  test("unknown scheme:code and other-version codes are stored as is", async () => {
    const aid = await createAssessment();
    const tags = ["wa2026:M.99.NOPE.1", "ccss2020:X.Y.Z", "AP Seminar Skill 2.1"];
    expect((await createItem(aid, { ...SHORT, standards: tags })).status).toBe(201);
    expect(await storedStandards(aid)).toEqual([tags]);
  });

  test("more than 10 after normalization → 400; duplicates do not count", async () => {
    const aid = await createAssessment();
    const eleven = Array.from({ length: 11 }, (_, i) => `T${i}`);
    const res = await createItem(aid, { ...MC, standards: eleven });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { detail: string }).detail).toContain("at most 10");

    const tenWithDupes = [...Array.from({ length: 10 }, (_, i) => `T${i}`), "T0", " T1 "];
    expect((await createItem(aid, { ...MC, standards: tenWithDupes })).status).toBe(201);
  });

  test("an entry over 80 characters → 400", async () => {
    const aid = await createAssessment();
    const res = await createItem(aid, { ...MC, standards: ["x".repeat(81)] });
    expect(res.status).toBe(400);
    expect((await createItem(aid, { ...MC, standards: ["x".repeat(80)] })).status).toBe(201);
  });

  test("PATCH replaces, normalizes, and omission preserves", async () => {
    const aid = await createAssessment();
    const created = (await (await createItem(aid, { ...MC, standards: ["A"] })).json()) as {
      item: { id: string };
    };
    const itemId = created.item.id;

    let res = await patchItem(aid, itemId, { ...MC, standards: ["B ", "B", "C"] });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { item: { standards: string[] } }).item.standards).toEqual(["B", "C"]);

    res = await patchItem(aid, itemId, { ...MC, stem: "Edited" });
    expect(res.status).toBe(200);
    expect(await storedStandards(aid)).toEqual([["B", "C"]]);

    res = await patchItem(aid, itemId, { ...MC, standards: [] });
    expect(res.status).toBe(200);
    expect(await storedStandards(aid)).toEqual([[]]);

    res = await patchItem(aid, itemId, { ...MC, standards: Array.from({ length: 11 }, (_, i) => `${i}`) });
    expect(res.status).toBe(400);
  });

  test("publish lock: tags change while published; the stem still does not", async () => {
    const aid = await createAssessment();
    const created = (await (await createItem(aid, { ...MC, standards: ["A"] })).json()) as {
      item: { id: string };
    };
    await setStatus(aid, "published");

    const retag = await patchItem(aid, created.item.id, { ...MC, standards: ["A", "B"] });
    expect(retag.status).toBe(200);
    expect(await storedStandards(aid)).toEqual([["A", "B"]]);

    const keyAndTags = await patchItem(aid, created.item.id, {
      ...MC,
      correct_choice_ids: ["a"],
      standards: ["B"],
    });
    expect(keyAndTags.status).toBe(200);
    expect(await storedStandards(aid)).toEqual([["B"]]);

    const stemEdit = await patchItem(aid, created.item.id, {
      ...MC,
      stem: `${MC.stem} (edited)`,
      standards: ["B"],
    });
    expect(stemEdit.status).toBe(409);
  });
});

describe("bundles — standards", () => {
  test("export emits tags only when non-empty; untagged items carry no key", async () => {
    const aid = await createAssessment();
    await createItem(aid, { ...MC, standards: ["wa2026:M.7.R.RP.2", "Custom"] });
    await createItem(aid, SHORT);
    const text = await exportText(aid);
    const bundle = ItemBundleSchema.parse(JSON.parse(text));
    expect(bundle.items[0]!.standards).toEqual(["wa2026:M.7.R.RP.2", "Custom"]);
    expect("standards" in (JSON.parse(text) as { items: object[] }).items[1]!).toBe(false);
  });

  test("export → import round trip carries the tags", async () => {
    const aid = await createAssessment();
    await createItem(aid, { ...MC, standards: ["ccss2010:7.RP.A.2", "Unit 3 target"] });
    await createItem(aid, SHORT);
    const text = await exportText(aid);

    const { POST } = await import("../app/api/assessments/import/route");
    const res = await POST(
      new Request("http://localhost/api/assessments/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: text,
      }),
    );
    expect(res.status).toBe(201);
    const imported = ((await res.json()) as { assessment: { id: string } }).assessment.id;
    expect(await storedStandards(imported)).toEqual([["ccss2010:7.RP.A.2", "Unit 3 target"], []]);
  });

  test("duplicate carries the tags", async () => {
    const aid = await createAssessment();
    await createItem(aid, { ...SHORT, standards: ["ngss:MS-PS1-2"] });
    const { POST } = await import("../app/api/assessments/[id]/duplicate/route");
    const res = await POST(new Request(`http://localhost/api/assessments/${aid}/duplicate`, { method: "POST" }), {
      params: Promise.resolve({ id: aid }),
    });
    expect(res.status).toBe(201);
    const copy = ((await res.json()) as { assessment_id: string }).assessment_id;
    expect(await storedStandards(copy)).toEqual([["ngss:MS-PS1-2"]]);
  });

  test("the delivery bundle never carries standards (ADR 0016)", async () => {
    const aid = await createAssessment();
    await createItem(aid, { ...MC, standards: ["wa2026:M.7.R.RP.2", "Custom target"] });
    await createItem(aid, { ...SHORT, standards: ["ngss:MS-PS1-2"] });
    const { buildDeliveryBundle } = await import("../lib/api/buildDeliveryBundle");
    const [row] = await getDb().select().from(assessments).where(eq(assessments.id, aid)).limit(1);
    const { bundle } = await buildDeliveryBundle(
      getDb(),
      row!,
      { enabled: {}, constructAltering: [] },
      MISSING_UUID,
      MISSING_UUID,
    );
    const hasKey = (v: unknown): boolean =>
      Array.isArray(v)
        ? v.some(hasKey)
        : v !== null && typeof v === "object"
          ? Object.entries(v).some(([k, inner]) => k === "standards" || hasKey(inner))
          : false;
    expect(hasKey(bundle)).toBe(false);
    const text = JSON.stringify(bundle);
    expect(text).not.toContain("M.7.R.RP.2");
    expect(text).not.toContain("Custom target");
  });
});

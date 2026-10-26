// R-5 (docs/editor-redesign-design.md, Phase 4 slice A): item version history.
// The item PATCH keeps a copy of the content it replaces in `item_snapshots`
// (coalesced, capped); GET …/items/[itemId]/history lists them; a restore is
// an ordinary PATCH (`?restore=1`) of a version built with the editor's own
// rowToView + itemPatchBody, so this file also proves the restore path is
// lossless. Same harness as items-api.test.ts — direct route calls against
// the test DB with the session mocked.
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { item_snapshots, items } from "../db/schema";
import { closeDb, getDb } from "../db/client";
import { SESSION_COOKIE_NAME } from "../lib/auth/session";
import * as sessionMod from "../lib/auth/session";
import { SNAPSHOT_INTERVAL_MS, SNAPSHOT_KEEP, itemContent } from "../lib/authoring/itemHistory";

const expectTestDb = () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("secure_test_design_tool_test")) {
    throw new Error(`item-history tests require the test DB DATABASE_URL; got: ${url}`);
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

function asUser(sub: string | null) {
  mockSub = sub;
}

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

async function createAssessment(name: string) {
  const { POST } = await import("../app/api/assessments/route");
  const res = await POST(
    new Request("http://localhost/api/assessments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    }),
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { assessment: { id: string } }).assessment.id;
}

async function createItem(assessmentId: string, body: unknown): Promise<string> {
  const { POST } = await import("../app/api/assessments/[id]/items/route");
  const res = await POST(
    new Request(`http://localhost/api/assessments/${assessmentId}/items`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: assessmentId }) },
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { item: { id: string } }).item.id;
}

async function patchItem(assessmentId: string, itemId: string, body: unknown, query = "") {
  const { PATCH } = await import("../app/api/assessments/[id]/items/[itemId]/route");
  return PATCH(
    new Request(`http://localhost/api/assessments/${assessmentId}/items/${itemId}${query}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: assessmentId, itemId }) },
  );
}

async function getHistory(assessmentId: string, itemId: string) {
  const { GET } = await import("../app/api/assessments/[id]/items/[itemId]/history/route");
  return GET(new Request(`http://localhost/api/assessments/${assessmentId}/items/${itemId}/history`), {
    params: Promise.resolve({ id: assessmentId, itemId }),
  });
}

type Version = { id: string; saved_at: string; captured_at: string; stem_html: string; item: Record<string, unknown> & { stem: string } };

async function versions(assessmentId: string, itemId: string): Promise<Version[]> {
  const res = await getHistory(assessmentId, itemId);
  expect(res.status).toBe(200);
  return ((await res.json()) as { versions: Version[] }).versions;
}

/** Age every copy of an item past the coalescing interval. */
async function ageSnapshots(itemId: string) {
  await getDb()
    .update(item_snapshots)
    .set({ captured_at: sql`${item_snapshots.captured_at} - make_interval(secs => ${SNAPSHOT_INTERVAL_MS / 1000 + 1})` })
    .where(eq(item_snapshots.item_id, itemId));
}

async function rowOf(itemId: string) {
  const [row] = await getDb().select().from(items).where(eq(items.id, itemId));
  return row!;
}

const MC = {
  type: "multiple_choice_single",
  stem: "Version one",
  choices: [
    { id: "a", text: "3" },
    { id: "b", text: "4" },
  ],
  correct_choice_ids: ["b"],
};

describe("capture on the item PATCH", () => {
  test("the first change keeps the version it replaces; autosaves within the interval coalesce", async () => {
    asUser("teacher-1");
    const a = await createAssessment("History");
    const id = await createItem(a, MC);
    expect(await versions(a, id)).toEqual([]);

    expect((await patchItem(a, id, { ...MC, stem: "Version two" })).status).toBe(200);
    expect((await patchItem(a, id, { ...MC, stem: "Version three" })).status).toBe(200);
    expect((await patchItem(a, id, { ...MC, stem: "Version four" })).status).toBe(200);
    const v = await versions(a, id);
    expect(v.map((x) => x.item.stem)).toEqual(["Version one"]);
  });

  test("after the interval the next change keeps another copy, newest first", async () => {
    asUser("teacher-1");
    const a = await createAssessment("History");
    const id = await createItem(a, MC);
    await patchItem(a, id, { ...MC, stem: "Version two" });
    await ageSnapshots(id);
    await patchItem(a, id, { ...MC, stem: "Version three" });
    expect((await versions(a, id)).map((x) => x.item.stem)).toEqual(["Version two", "Version one"]);
  });

  test("each version carries its question rendered, not its markup", async () => {
    asUser("teacher-1");
    const a = await createAssessment("History");
    const id = await createItem(a, { ...MC, stem: "Which is **ABIOTIC**? $x^2$" });
    await patchItem(a, id, { ...MC, stem: "Version two" });
    const [v] = await versions(a, id);
    expect(v!.stem_html).toContain("<strong>ABIOTIC</strong>");
    expect(v!.stem_html).toContain("katex");
    expect(v!.stem_html).not.toContain("**");
  });

  test("a PATCH that changes nothing keeps nothing", async () => {
    asUser("teacher-1");
    const a = await createAssessment("History");
    const id = await createItem(a, MC);
    expect((await patchItem(a, id, MC)).status).toBe(200);
    expect(await versions(a, id)).toEqual([]);
  });

  test("a refused PATCH (bad body, publish lock) keeps nothing", async () => {
    asUser("teacher-1");
    const a = await createAssessment("History");
    const id = await createItem(a, MC);
    expect((await patchItem(a, id, { ...MC, choices: "nope" })).status).toBe(400);
    expect(await versions(a, id)).toEqual([]);
  });

  test("each item keeps its newest SNAPSHOT_KEEP copies", async () => {
    asUser("teacher-1");
    const a = await createAssessment("History");
    const id = await createItem(a, MC);
    const row = await rowOf(id);
    const old = new Date(Date.now() - 24 * 3600 * 1000);
    await getDb()
      .insert(item_snapshots)
      .values(
        Array.from({ length: SNAPSHOT_KEEP }, (_, i) => ({
          item_id: id,
          content: { ...itemContent(row), stem: `old ${i}` },
          saved_at: old,
          captured_at: new Date(old.getTime() + i * 1000),
        })),
      );
    await patchItem(a, id, { ...MC, stem: "Version two" });
    const [{ n }] = (await getDb()
      .select({ n: sql<number>`count(*)::int` })
      .from(item_snapshots)
      .where(eq(item_snapshots.item_id, id))) as [{ n: number }];
    expect(n).toBe(SNAPSHOT_KEEP);
    const v = await versions(a, id);
    expect(v[0]!.item.stem).toBe("Version one");
    expect(v.some((x) => x.item.stem === "old 0")).toBe(false);
  });

  test("deleting the item deletes its history", async () => {
    asUser("teacher-1");
    const a = await createAssessment("History");
    const id = await createItem(a, MC);
    await patchItem(a, id, { ...MC, stem: "Version two" });
    const { DELETE } = await import("../app/api/assessments/[id]/items/[itemId]/route");
    const res = await DELETE(new Request(`http://localhost/api/assessments/${a}/items/${id}`, { method: "DELETE" }), {
      params: Promise.resolve({ id: a, itemId: id }),
    });
    expect(res.status).toBe(204);
    const left = await getDb().select().from(item_snapshots).where(eq(item_snapshots.item_id, id));
    expect(left).toEqual([]);
  });
});

describe("restore through the editor's own update path", () => {
  // Loaded lazily: the editor module is a client component.
  async function editorHelpers() {
    return import("../app/dashboard/[id]/AssessmentEditor");
  }

  const CASES: { name: string; v1: Record<string, unknown>; v2: Record<string, unknown> }[] = [
    {
      name: "multiple choice with tags and a scoring method",
      v1: { ...MC, standards: ["Unit 3 review"], scoring_method: "auto" },
      v2: { ...MC, stem: "Changed", correct_choice_ids: ["a"], standards: [], scoring_method: null },
    },
    {
      name: "short answer with exact form",
      v1: { type: "short_text", stem: "Write 1/2 as a decimal.", choices: [], correct_choice_ids: [], correct_answer: "0.5", exact_form: true },
      v2: { type: "short_text", stem: "Changed", choices: [], correct_choice_ids: [], correct_answer: "" },
    },
    {
      name: "essay with a word limit and placeholder",
      v1: { type: "essay", stem: "Explain.", choices: [], correct_choice_ids: [], max_word_count: 200, placeholder: "Start here" },
      v2: { type: "essay", stem: "Changed", choices: [], correct_choice_ids: [] },
    },
  ];

  for (const c of CASES) {
    test(`restores a ${c.name} exactly`, async () => {
      const { rowToView, itemPatchBody } = await editorHelpers();
      asUser("teacher-1");
      const a = await createAssessment("Restore");
      const id = await createItem(a, c.v1);
      const v1Content = itemContent(await rowOf(id));
      expect((await patchItem(a, id, c.v2)).status).toBe(200);
      const v2Content = itemContent(await rowOf(id));

      const [version] = await versions(a, id);
      expect(version).toBeDefined();
      // What the History dialog hands the editor's restoreVersion.
      const view = rowToView(version!.item as unknown as Parameters<typeof rowToView>[0]);
      const res = await patchItem(a, id, itemPatchBody(view), "?restore=1");
      expect(res.status).toBe(200);
      expect(itemContent(await rowOf(id))).toEqual(v1Content);

      // The restore kept the version it replaced, inside the coalescing
      // interval, so restoring the wrong version can be undone.
      const after = await versions(a, id);
      expect(itemContent(after[0]!.item as never)).toEqual(v2Content);
    });
  }

  test("a version carries the item's current id and position", async () => {
    asUser("teacher-1");
    const a = await createAssessment("Restore");
    await createItem(a, MC);
    const id = await createItem(a, MC);
    await patchItem(a, id, { ...MC, stem: "Changed" });
    const [v] = await versions(a, id);
    expect(v!.item.id).toBe(id);
    expect(v!.item.position).toBe((await rowOf(id)).position);
  });

  test("restore is refused by the publish lock like any other edit", async () => {
    asUser("teacher-1");
    const a = await createAssessment("Restore");
    const id = await createItem(a, MC);
    await patchItem(a, id, { ...MC, stem: "Changed" });
    await getDb().execute(sql`update assessments set status = 'published' where id = ${a}`);
    const res = await patchItem(a, id, MC, "?restore=1");
    expect(res.status).toBe(409);
    expect((await rowOf(id)).stem).toBe("Changed");
  });
});

describe("history route access", () => {
  test("no session is 401", async () => {
    asUser("teacher-1");
    const a = await createAssessment("Access");
    const id = await createItem(a, MC);
    asUser(null);
    expect((await getHistory(a, id)).status).toBe(401);
  });

  test("another teacher's item is 404, and so is the history behind it", async () => {
    asUser("teacher-1");
    const a = await createAssessment("Access");
    const id = await createItem(a, MC);
    await patchItem(a, id, { ...MC, stem: "Changed" });
    asUser("teacher-2");
    expect((await getHistory(a, id)).status).toBe(404);
  });

  test("an item id from a different assessment is 404", async () => {
    asUser("teacher-1");
    const a = await createAssessment("Access A");
    const b = await createAssessment("Access B");
    const idInB = await createItem(b, MC);
    expect((await getHistory(a, idInB)).status).toBe(404);
  });

  test("a malformed id is 400", async () => {
    asUser("teacher-1");
    const a = await createAssessment("Access");
    expect((await getHistory(a, "not-a-uuid")).status).toBe(400);
  });
});

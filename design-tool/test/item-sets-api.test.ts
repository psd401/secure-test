// E5 slice 1: item sets (one stimulus shared by contiguous items). Same
// harness as items-api.test.ts — direct route imports against the test DB.
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { closeDb, getDb } from "../db/client";
import { item_sets, items } from "../db/schema";
import { SESSION_COOKIE_NAME } from "../lib/auth/session";
import * as sessionMod from "../lib/auth/session";
import { isContiguousRun, splitSetInOrder } from "../lib/api/itemSets";

const expectTestDb = () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("secure_test_design_tool_test")) {
    throw new Error(`item-sets tests require the test DB DATABASE_URL; got: ${url}`);
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
  readSessionFromCookies: async () =>
    mockSub ? { sub: mockSub, role: "staff" } : null,
}));

const OWNER = "item-sets-teacher";

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

async function createAssessment(name = "Sets") {
  const { POST } = await import("../app/api/assessments/route");
  const res = await POST(new Request("http://localhost/api/assessments", { method: "POST", ...json({ name }) }));
  expect(res.status).toBe(201);
  return ((await res.json()) as { assessment: { id: string } }).assessment.id;
}

async function addShortText(id: string, stem: string) {
  const { POST } = await import("../app/api/assessments/[id]/items/route");
  const res = await POST(
    new Request(`http://localhost/api/assessments/${id}/items`, {
      method: "POST",
      ...json({ type: "short_text", stem, correct_answer: "x" }),
    }),
    { params: Promise.resolve({ id }) },
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { item: { id: string } }).item.id;
}

async function listItems(id: string) {
  const { GET } = await import("../app/api/assessments/[id]/items/route");
  const res = await GET(new Request(`http://localhost/api/assessments/${id}/items`), {
    params: Promise.resolve({ id }),
  });
  return (await res.json()) as {
    items: { id: string; position: number; item_set_id: string | null }[];
    item_sets: { id: string; stimulus_text: string; layout: string }[];
  };
}

async function createSet(id: string, body: unknown) {
  const { POST } = await import("../app/api/assessments/[id]/item-sets/route");
  return POST(
    new Request(`http://localhost/api/assessments/${id}/item-sets`, { method: "POST", ...json(body) }),
    { params: Promise.resolve({ id }) },
  );
}

async function patchSet(id: string, setId: string, body: unknown) {
  const { PATCH } = await import("../app/api/assessments/[id]/item-sets/[setId]/route");
  return PATCH(
    new Request(`http://localhost/api/assessments/${id}/item-sets/${setId}`, { method: "PATCH", ...json(body) }),
    { params: Promise.resolve({ id, setId }) },
  );
}

async function deleteSet(id: string, setId: string) {
  const { DELETE } = await import("../app/api/assessments/[id]/item-sets/[setId]/route");
  return DELETE(new Request(`http://localhost/api/assessments/${id}/item-sets/${setId}`, { method: "DELETE" }), {
    params: Promise.resolve({ id, setId }),
  });
}

async function attach(id: string, setId: string, itemId: string) {
  const { POST } = await import("../app/api/assessments/[id]/item-sets/[setId]/items/route");
  return POST(
    new Request(`http://localhost/api/assessments/${id}/item-sets/${setId}/items`, {
      method: "POST",
      ...json({ item_id: itemId }),
    }),
    { params: Promise.resolve({ id, setId }) },
  );
}

async function detach(id: string, setId: string, itemId: string) {
  const { DELETE } = await import("../app/api/assessments/[id]/item-sets/[setId]/items/[itemId]/route");
  return DELETE(
    new Request(`http://localhost/api/assessments/${id}/item-sets/${setId}/items/${itemId}`, { method: "DELETE" }),
    { params: Promise.resolve({ id, setId, itemId }) },
  );
}

async function reorder(id: string, ordered_ids: string[]) {
  const { POST } = await import("../app/api/assessments/[id]/items/reorder/route");
  return POST(
    new Request(`http://localhost/api/assessments/${id}/items/reorder`, { method: "POST", ...json({ ordered_ids }) }),
    { params: Promise.resolve({ id }) },
  );
}

async function deleteItem(id: string, itemId: string) {
  const { DELETE } = await import("../app/api/assessments/[id]/items/[itemId]/route");
  return DELETE(new Request(`http://localhost/api/assessments/${id}/items/${itemId}`, { method: "DELETE" }), {
    params: Promise.resolve({ id, itemId }),
  });
}

async function setStatus(id: string, status: string) {
  const { PATCH } = await import("../app/api/assessments/[id]/route");
  const res = await PATCH(
    new Request(`http://localhost/api/assessments/${id}`, { method: "PATCH", ...json({ status }) }),
    { params: Promise.resolve({ id }) },
  );
  expect(res.status).toBe(200);
}

/** Four short-text questions, positions 0..3. */
async function seed() {
  const id = await createAssessment();
  const q: string[] = [];
  for (const stem of ["Q1", "Q2", "Q3", "Q4"]) q.push(await addShortText(id, stem));
  return { id, q };
}

describe("contiguity helpers", () => {
  test("isContiguousRun", () => {
    expect(isContiguousRun([2, 0, 1])).toBe(true);
    expect(isContiguousRun([0, 2])).toBe(false);
    expect(isContiguousRun([5])).toBe(true);
    expect(isContiguousRun([])).toBe(false);
  });

  test("splitSetInOrder names the set an order would split", () => {
    const setOf = new Map<string, string | null>([
      ["a", "S"], ["b", "S"], ["c", null], ["d", "T"], ["e", "T"],
    ]);
    expect(splitSetInOrder(["a", "b", "c", "d", "e"], setOf)).toBeNull();
    expect(splitSetInOrder(["c", "d", "e", "b", "a"], setOf)).toBeNull();
    expect(splitSetInOrder(["a", "c", "b", "d", "e"], setOf)).toBe("S");
    expect(splitSetInOrder(["d", "a", "b", "e", "c"], setOf)).toBe("T");
  });
});

describe("item sets — create / list", () => {
  test("groups two adjacent questions; the items list carries the set", async () => {
    const { id, q } = await seed();
    const res = await createSet(id, { item_ids: [q[2]!, q[1]!], stimulus_text: "Read the passage.", layout: "own_page" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { item_set: { id: string; layout: string }; item_ids: string[] };
    expect(body.item_set.layout).toBe("own_page");
    // Returned in assessment order regardless of the order asked.
    expect(body.item_ids).toEqual([q[1]!, q[2]!]);
    const list = await listItems(id);
    expect(list.items.map((i) => i.item_set_id)).toEqual([null, body.item_set.id, body.item_set.id, null]);
    expect(list.item_sets.map((s) => s.stimulus_text)).toEqual(["Read the passage."]);
  });

  test("a set of one is allowed; defaults are empty text + inline", async () => {
    const { id, q } = await seed();
    const res = await createSet(id, { item_ids: [q[0]] });
    expect(res.status).toBe(201);
    const { item_set } = (await res.json()) as { item_set: { stimulus_text: string; layout: string } };
    expect(item_set.stimulus_text).toBe("");
    expect(item_set.layout).toBe("inline");
  });

  test("refuses non-adjacent questions, unknown ids, and questions already in a set", async () => {
    const { id, q } = await seed();
    expect((await createSet(id, { item_ids: [q[0], q[2]] })).status).toBe(400);
    expect((await createSet(id, { item_ids: ["00000000-0000-4000-8000-000000000000"] })).status).toBe(400);
    expect((await createSet(id, { item_ids: [q[0], q[1]] })).status).toBe(201);
    const dup = await createSet(id, { item_ids: [q[1], q[2]] });
    expect(dup.status).toBe(409);
    expect(((await dup.json()) as { error: string }).error).toBe("item_already_in_set");
  });

  test("sets list in assessment order, not creation order", async () => {
    const { id, q } = await seed();
    const later = await createSet(id, { item_ids: [q[3]], stimulus_text: "second" });
    const earlier = await createSet(id, { item_ids: [q[0]], stimulus_text: "first" });
    expect(later.status).toBe(201);
    expect(earlier.status).toBe(201);
    const list = await listItems(id);
    expect(list.item_sets.map((s) => s.stimulus_text)).toEqual(["first", "second"]);
  });
});

describe("item sets — attach / detach / delete", () => {
  test("attach only the neighbour just before or after the block", async () => {
    const { id, q } = await seed();
    const { item_set } = (await (await createSet(id, { item_ids: [q[1]] })).json()) as { item_set: { id: string } };
    expect((await attach(id, item_set.id, q[3]!)).status).toBe(409); // not adjacent
    expect((await attach(id, item_set.id, q[2]!)).status).toBe(200); // just after
    expect((await attach(id, item_set.id, q[0]!)).status).toBe(200); // just before
    expect((await attach(id, item_set.id, q[3]!)).status).toBe(200); // now adjacent
    const list = await listItems(id);
    expect(list.items.every((i) => i.item_set_id === item_set.id)).toBe(true);
  });

  test("detach refuses a middle question; an end leaves; the last one deletes the set", async () => {
    const { id, q } = await seed();
    const { item_set } = (await (await createSet(id, { item_ids: [q[0], q[1], q[2]] })).json()) as { item_set: { id: string } };
    const middle = await detach(id, item_set.id, q[1]!);
    expect(middle.status).toBe(409);
    expect(((await middle.json()) as { error: string }).error).toBe("would_split_set");
    expect(((await (await detach(id, item_set.id, q[2]!)).json()) as { item_set_deleted: boolean }).item_set_deleted).toBe(false);
    expect(((await (await detach(id, item_set.id, q[0]!)).json()) as { item_set_deleted: boolean }).item_set_deleted).toBe(false);
    expect(((await (await detach(id, item_set.id, q[1]!)).json()) as { item_set_deleted: boolean }).item_set_deleted).toBe(true);
    const db = getDb();
    expect(await db.select().from(item_sets).where(eq(item_sets.id, item_set.id))).toHaveLength(0);
    expect((await listItems(id)).items.every((i) => i.item_set_id === null)).toBe(true);
  });

  test("deleting a set frees its questions; deleting a set's last question deletes the set", async () => {
    const { id, q } = await seed();
    const { item_set } = (await (await createSet(id, { item_ids: [q[0], q[1]] })).json()) as { item_set: { id: string } };
    expect((await deleteSet(id, item_set.id)).status).toBe(204);
    const list = await listItems(id);
    expect(list.items).toHaveLength(4);
    expect(list.items.every((i) => i.item_set_id === null)).toBe(true);

    const solo = (await (await createSet(id, { item_ids: [q[3]] })).json()) as { item_set: { id: string } };
    expect((await deleteItem(id, q[3]!)).status).toBe(204);
    const db = getDb();
    expect(await db.select().from(item_sets).where(eq(item_sets.id, solo.item_set.id))).toHaveLength(0);
    // Deleting a middle member keeps the block contiguous (positions collapse).
    const pair = (await (await createSet(id, { item_ids: [q[0], q[1], q[2]] })).json()) as { item_set: { id: string } };
    expect((await deleteItem(id, q[1]!)).status).toBe(204);
    const after = await listItems(id);
    expect(after.items.map((i) => [i.position, i.item_set_id])).toEqual([[0, pair.item_set.id], [1, pair.item_set.id]]);
  });

  test("PATCH updates text and layout; rejects a bad layout and an empty patch", async () => {
    const { id, q } = await seed();
    const { item_set } = (await (await createSet(id, { item_ids: [q[0]] })).json()) as { item_set: { id: string } };
    const ok = await patchSet(id, item_set.id, { stimulus_text: "Figure 1: $x^2$", layout: "own_page" });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { item_set: { stimulus_text: string; layout: string } };
    expect(body.item_set).toMatchObject({ stimulus_text: "Figure 1: $x^2$", layout: "own_page" });
    expect((await patchSet(id, item_set.id, { layout: "sideways" })).status).toBe(400);
    expect((await patchSet(id, item_set.id, {})).status).toBe(400);
  });
});

// E12 slice 1: a set may name an essay / short-text question in another
// assessment of the same owner as its source; the checks, and clearing it.
describe("item sets — source question (E12 slice 1)", () => {
  test("accepts the owner's essay elsewhere, refuses MC, this assessment, and another owner's; null clears", async () => {
    const { id, q } = await seed();
    const { item_set } = (await (await createSet(id, { item_ids: [q[0]] })).json()) as { item_set: { id: string } };
    const outline = await createAssessment("Outline");
    const { POST } = await import("../app/api/assessments/[id]/items/route");
    const essayRes = await POST(
      new Request(`http://localhost/api/assessments/${outline}/items`, { method: "POST", ...json({ type: "essay", stem: "Outline your argument" }) }),
      { params: Promise.resolve({ id: outline }) },
    );
    const essayId = ((await essayRes.json()) as { item: { id: string } }).item.id;
    const mcRes = await POST(
      new Request(`http://localhost/api/assessments/${outline}/items`, {
        method: "POST",
        ...json({ type: "multiple_choice_single", stem: "Pick", choices: [{ id: "a", text: "A" }, { id: "b", text: "B" }], correct_choice_ids: ["a"] }),
      }),
      { params: Promise.resolve({ id: outline }) },
    );
    const mcId = ((await mcRes.json()) as { item: { id: string } }).item.id;

    const ok = await patchSet(id, item_set.id, { source_item_id: essayId });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { item_set: { source_item_id: string | null } }).item_set.source_item_id).toBe(essayId);
    expect((await listItems(id)).item_sets[0]).toMatchObject({ source_item_id: essayId });

    const mc = await patchSet(id, item_set.id, { source_item_id: mcId });
    expect(mc.status).toBe(400);
    expect(((await mc.json()) as { error: string }).error).toBe("source_type_not_allowed");
    const self = await patchSet(id, item_set.id, { source_item_id: q[1] });
    expect(self.status).toBe(400);
    expect(((await self.json()) as { error: string }).error).toBe("source_in_this_assessment");
    expect((await patchSet(id, item_set.id, { source_item_id: "00000000-0000-4000-8000-000000000001" })).status).toBe(404);

    mockSub = "other-teacher";
    const foreign = await createAssessment("Theirs");
    const theirs = await POST(
      new Request(`http://localhost/api/assessments/${foreign}/items`, { method: "POST", ...json({ type: "essay", stem: "Not yours" }) }),
      { params: Promise.resolve({ id: foreign }) },
    );
    const theirId = ((await theirs.json()) as { item: { id: string } }).item.id;
    mockSub = OWNER;
    const notMine = await patchSet(id, item_set.id, { source_item_id: theirId });
    expect(notMine.status).toBe(404);

    const cleared = await patchSet(id, item_set.id, { source_item_id: null });
    expect(cleared.status).toBe(200);
    expect(((await cleared.json()) as { item_set: { source_item_id: string | null } }).item_set.source_item_id).toBeNull();
  });
});

describe("item sets — reorder keeps blocks whole", () => {
  test("an order that splits a set is refused; moving the block is fine", async () => {
    const { id, q } = await seed();
    const { item_set } = (await (await createSet(id, { item_ids: [q[1], q[2]] })).json()) as { item_set: { id: string } };
    const split = await reorder(id, [q[1]!, q[0]!, q[2]!, q[3]!]);
    expect(split.status).toBe(400);
    expect((await split.json()) as object).toMatchObject({ error: "reorder_would_split_set", item_set_id: item_set.id });
    expect((await reorder(id, [q[3]!, q[1]!, q[2]!, q[0]!])).status).toBe(200);
    const list = await listItems(id);
    expect(list.items.map((i) => i.id)).toEqual([q[3]!, q[1]!, q[2]!, q[0]!]);
  });
});

describe("item sets — locks and ownership", () => {
  test("every set write is 409 while published; reads still work", async () => {
    const { id, q } = await seed();
    const { item_set } = (await (await createSet(id, { item_ids: [q[0], q[1]] })).json()) as { item_set: { id: string } };
    await setStatus(id, "published");
    expect((await createSet(id, { item_ids: [q[2]] })).status).toBe(409);
    expect((await patchSet(id, item_set.id, { stimulus_text: "later" })).status).toBe(409);
    expect((await attach(id, item_set.id, q[2]!)).status).toBe(409);
    expect((await detach(id, item_set.id, q[1]!)).status).toBe(409);
    expect((await deleteSet(id, item_set.id)).status).toBe(409);
    expect((await listItems(id)).item_sets).toHaveLength(1);
  });

  test("another teacher gets 403 on the set routes", async () => {
    const { id, q } = await seed();
    const { item_set } = (await (await createSet(id, { item_ids: [q[0]] })).json()) as { item_set: { id: string } };
    mockSub = "someone-else";
    expect((await createSet(id, { item_ids: [q[1]] })).status).toBe(403);
    expect((await patchSet(id, item_set.id, { stimulus_text: "x" })).status).toBe(403);
    expect((await deleteSet(id, item_set.id)).status).toBe(403);
    expect((await attach(id, item_set.id, q[1]!)).status).toBe(403);
    expect((await detach(id, item_set.id, q[0]!)).status).toBe(403);
    mockSub = OWNER;
    const db = getDb();
    expect(await db.select().from(items).where(eq(items.item_set_id, item_set.id))).toHaveLength(1);
  });
});

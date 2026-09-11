// Rubric library slice 3 (docs/rubric-upload-design.md §"Rubric library and
// reuse", D-4): the /api/rubrics routes, `config.rubric_id` on essay items
// (attach / foreign / detach), and the promise that the id is EDITOR
// metadata — it never reaches the delivery bundle or the export.
//
// Same harness as items-api.test.ts: route modules imported directly against
// the local test DB with the session helper mocked.
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { sql } from "drizzle-orm";
import type { Rubric } from "@secure-test/schema";
import { closeDb, getDb } from "../db/client";
import { SESSION_COOKIE_NAME } from "../lib/auth/session";
import * as sessionMod from "../lib/auth/session";

const expectTestDb = () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("secure_test_design_tool_test")) {
    throw new Error(`rubrics-api tests require the test DB DATABASE_URL; got: ${url}`);
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
  await db.execute(sql`truncate table rubrics restart identity cascade`);
});

afterAll(async () => {
  await closeDb();
  if (originalSessionSecret === undefined) {
    delete process.env.DESIGN_TOOL_SESSION_SECRET;
  } else {
    process.env.DESIGN_TOOL_SESSION_SECRET = originalSessionSecret;
  }
});

const ANALYTIC: Rubric = {
  style: "analytic",
  criteria: [
    {
      id: "c1",
      name: "Claim",
      levels: [
        { id: "l1", label: "Strong", points: 3, descriptor: "Clear claim" },
        { id: "l2", label: "Weak", points: 0 },
      ],
    },
    {
      id: "c2",
      name: "Evidence",
      levels: [
        { id: "l3", label: "Strong", points: 2 },
        { id: "l4", label: "Weak", points: 0 },
      ],
    },
  ],
};

const MISSING_UUID = "11111111-1111-4111-8111-111111111111";

// ---------------------------------------------------------------- helpers

async function listRubrics() {
  const { GET } = await import("../app/api/rubrics/route");
  return GET();
}

async function createRubric(body: unknown) {
  const { POST } = await import("../app/api/rubrics/route");
  return POST(
    new Request("http://localhost/api/rubrics", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

async function getRubric(id: string) {
  const { GET } = await import("../app/api/rubrics/[id]/route");
  return GET(new Request(`http://localhost/api/rubrics/${id}`), {
    params: Promise.resolve({ id }),
  });
}

async function patchRubric(id: string, body: unknown) {
  const { PATCH } = await import("../app/api/rubrics/[id]/route");
  return PATCH(
    new Request(`http://localhost/api/rubrics/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
}

async function deleteRubric(id: string) {
  const { DELETE } = await import("../app/api/rubrics/[id]/route");
  return DELETE(new Request(`http://localhost/api/rubrics/${id}`, { method: "DELETE" }), {
    params: Promise.resolve({ id }),
  });
}

async function saveRubric(title: string, rubric: Rubric = ANALYTIC): Promise<string> {
  const res = await createRubric({ title, rubric });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { rubric: { id: string } };
  return body.rubric.id;
}

async function createAssessment(name: string): Promise<string> {
  const { POST } = await import("../app/api/assessments/route");
  const res = await POST(
    new Request("http://localhost/api/assessments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    }),
  );
  expect(res.status).toBe(201);
  const body = (await res.json()) as { assessment: { id: string } };
  return body.assessment.id;
}

async function createEssayItem(assessmentId: string, body: Record<string, unknown>) {
  const { POST } = await import("../app/api/assessments/[id]/items/route");
  return POST(
    new Request(`http://localhost/api/assessments/${assessmentId}/items`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "essay",
        stem: "Write an argument.",
        rubric: ANALYTIC,
        ...body,
      }),
    }),
    { params: Promise.resolve({ id: assessmentId }) },
  );
}

async function patchItem(assessmentId: string, itemId: string, body: unknown) {
  const { PATCH } = await import("../app/api/assessments/[id]/items/[itemId]/route");
  return PATCH(
    new Request(`http://localhost/api/assessments/${assessmentId}/items/${itemId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: assessmentId, itemId }) },
  );
}

type ItemConfigBody = { item: { id: string; config: Record<string, unknown> } };

async function essayWithSavedRubric(): Promise<{
  assessmentId: string;
  itemId: string;
  rubricId: string;
}> {
  const rubricId = await saveRubric("Argument rubric");
  const assessmentId = await createAssessment("Essay test");
  const res = await createEssayItem(assessmentId, { rubric_id: rubricId });
  expect(res.status).toBe(201);
  const body = (await res.json()) as ItemConfigBody;
  expect(body.item.config.rubric_id).toBe(rubricId);
  return { assessmentId, itemId: body.item.id, rubricId };
}

// ------------------------------------------------------------- the routes

describe("GET/POST /api/rubrics", () => {
  test("lists only the caller's own rubrics, newest updated first", async () => {
    asUser("teacher-a");
    const first = await saveRubric("Older");
    const second = await saveRubric("Newer");
    // updated_at defaults to now() for both inserts; make the order explicit.
    await getDb().execute(
      sql`update rubrics set updated_at = now() - interval '1 hour' where id = ${first}::uuid`,
    );
    asUser("teacher-b");
    await saveRubric("Someone else's");

    asUser("teacher-a");
    const res = await listRubrics();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rubrics: { id: string; title: string; style: string; criteria_count: number; max_points: number; source: string }[];
    };
    expect(body.rubrics.map((r) => r.title)).toEqual(["Newer", "Older"]);
    expect(body.rubrics[0]!.id).toBe(second);
    // The summary the picker renders: style, N criteria, max points, source.
    expect(body.rubrics[0]).toMatchObject({
      style: "analytic",
      criteria_count: 2,
      max_points: 5,
      source: "upload",
    });
  });

  test("POST 201 returns the row and defaults source to upload", async () => {
    asUser("teacher-a");
    const res = await createRubric({ title: "  Argument  ", rubric: ANALYTIC });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      rubric: { id: string; title: string; source: string; owner_sub: string };
    };
    expect(body.rubric.title).toBe("Argument");
    expect(body.rubric.source).toBe("upload");
    expect(body.rubric.owner_sub).toBe("teacher-a");
  });

  test("POST honours an explicit source", async () => {
    asUser("teacher-a");
    const res = await createRubric({ title: "Typed", rubric: ANALYTIC, source: "editor" });
    const body = (await res.json()) as { rubric: { source: string } };
    expect(body.rubric.source).toBe("editor");
  });

  test("POST 400 on a rubric the shared schema refuses", async () => {
    asUser("teacher-a");
    // holistic must carry exactly one criterion (RubricSchema's superRefine).
    const res = await createRubric({
      title: "Bad",
      rubric: { ...ANALYTIC, style: "holistic" },
    });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({
      error: "invalid_body",
    });
  });

  test("POST 400 on a missing title", async () => {
    asUser("teacher-a");
    const res = await createRubric({ title: "   ", rubric: ANALYTIC });
    expect(res.status).toBe(400);
  });
});

describe("GET/PATCH/DELETE /api/rubrics/[id]", () => {
  test("GET returns the owner's rubric whole", async () => {
    asUser("teacher-a");
    const id = await saveRubric("Argument rubric");
    const res = await getRubric(id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rubric: { title: string; rubric: Rubric } };
    expect(body.rubric.title).toBe("Argument rubric");
    expect(body.rubric.rubric.criteria).toHaveLength(2);
  });

  test("GET/PATCH/DELETE are 404 for another owner", async () => {
    asUser("teacher-a");
    const id = await saveRubric("Argument rubric");
    asUser("teacher-b");
    expect((await getRubric(id)).status).toBe(404);
    expect((await patchRubric(id, { title: "Mine now" })).status).toBe(404);
    expect((await deleteRubric(id)).status).toBe(404);
    // …and the row is untouched.
    asUser("teacher-a");
    const res = await getRubric(id);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { rubric: { title: string } }).rubric.title).toBe(
      "Argument rubric",
    );
  });

  test("GET 404 for an id that does not exist", async () => {
    asUser("teacher-a");
    expect((await getRubric(MISSING_UUID)).status).toBe(404);
  });

  test("PATCH updates the title, the rubric, or both", async () => {
    asUser("teacher-a");
    const id = await saveRubric("Argument rubric");
    const renamed = await patchRubric(id, { title: "Renamed" });
    expect(renamed.status).toBe(200);
    expect(((await renamed.json()) as { rubric: { title: string } }).rubric.title).toBe(
      "Renamed",
    );

    const trimmed: Rubric = { ...ANALYTIC, criteria: [ANALYTIC.criteria[0]!] };
    const res = await patchRubric(id, { rubric: trimmed });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rubric: { title: string; rubric: Rubric } };
    expect(body.rubric.rubric.criteria).toHaveLength(1);
    expect(body.rubric.title).toBe("Renamed");
  });

  test("PATCH 400 on an empty body or an invalid rubric", async () => {
    asUser("teacher-a");
    const id = await saveRubric("Argument rubric");
    expect((await patchRubric(id, {})).status).toBe(400);
    expect((await patchRubric(id, { rubric: { style: "analytic" } })).status).toBe(400);
  });

  test("DELETE 204 removes the row", async () => {
    asUser("teacher-a");
    const id = await saveRubric("Argument rubric");
    expect((await deleteRubric(id)).status).toBe(204);
    expect((await getRubric(id)).status).toBe(404);
  });

  test("DELETE detaches an item's rubric_id and leaves its rubric alone", async () => {
    asUser("teacher-a");
    const { assessmentId, itemId, rubricId } = await essayWithSavedRubric();

    expect((await deleteRubric(rubricId)).status).toBe(204);

    const { GET } = await import("../app/api/assessments/[id]/items/[itemId]/route");
    const res = await GET(
      new Request(`http://localhost/api/assessments/${assessmentId}/items/${itemId}`),
      { params: Promise.resolve({ id: assessmentId, itemId }) },
    );
    const body = (await res.json()) as ItemConfigBody;
    expect(body.item.config.rubric_id).toBeUndefined();
    // The item's COPY is untouched — students may already have been scored
    // against it (D-4: delete detaches, never edits).
    expect(body.item.config.rubric).toEqual(ANALYTIC);
  });

  test("DELETE does not touch another teacher's item that carries the same id", async () => {
    asUser("teacher-a");
    const { rubricId } = await essayWithSavedRubric();
    // Another teacher's item with the same id in its config: reachable only
    // by a direct write, but the detach UPDATE must still refuse it.
    asUser("teacher-b");
    const otherAssessment = await createAssessment("Theirs");
    const created = await createEssayItem(otherAssessment, {});
    const otherItem = ((await created.json()) as ItemConfigBody).item.id;
    await getDb().execute(
      sql`update items set config = config || jsonb_build_object('rubric_id', ${rubricId}::text) where id = ${otherItem}::uuid`,
    );

    asUser("teacher-a");
    expect((await deleteRubric(rubricId)).status).toBe(204);

    const [row] = (await getDb().execute(
      sql`select config ->> 'rubric_id' as rubric_id from items where id = ${otherItem}::uuid`,
    )) as unknown as { rubric_id: string | null }[];
    expect(row!.rubric_id).toBe(rubricId);
  });
});

// -------------------------------------------------- rubric_id on the item

describe("config.rubric_id on essay items", () => {
  test("create + PATCH accept a rubric the caller owns", async () => {
    asUser("teacher-a");
    const { assessmentId, itemId, rubricId } = await essayWithSavedRubric();
    const second = await saveRubric("Another rubric");
    const res = await patchItem(assessmentId, itemId, {
      type: "essay",
      stem: "Write an argument.",
      rubric: ANALYTIC,
      rubric_id: second,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ItemConfigBody;
    expect(body.item.config.rubric_id).toBe(second);
    expect(rubricId).not.toBe(second);
  });

  test("a rubric_id belonging to another teacher is 400 rubric_not_found", async () => {
    asUser("teacher-b");
    const foreign = await saveRubric("Theirs");
    asUser("teacher-a");
    const assessmentId = await createAssessment("Essay test");
    const created = await createEssayItem(assessmentId, {});
    const itemId = ((await created.json()) as ItemConfigBody).item.id;

    const res = await patchItem(assessmentId, itemId, {
      type: "essay",
      stem: "Write an argument.",
      rubric: ANALYTIC,
      rubric_id: foreign,
    });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({
      error: "rubric_not_found",
    });
  });

  test("a rubric_id that does not exist is 400 rubric_not_found on create", async () => {
    asUser("teacher-a");
    const assessmentId = await createAssessment("Essay test");
    const res = await createEssayItem(assessmentId, { rubric_id: MISSING_UUID });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({
      error: "rubric_not_found",
    });
  });

  test("editing the rubric without sending rubric_id detaches it", async () => {
    asUser("teacher-a");
    const { assessmentId, itemId } = await essayWithSavedRubric();
    const edited: Rubric = {
      ...ANALYTIC,
      criteria: [{ ...ANALYTIC.criteria[0]!, name: "Claim (revised)" }, ANALYTIC.criteria[1]!],
    };
    const res = await patchItem(assessmentId, itemId, {
      type: "essay",
      stem: "Write an argument.",
      rubric: edited,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ItemConfigBody;
    expect(body.item.config.rubric_id).toBeUndefined();
    expect(body.item.config.rubric).toEqual(edited);
  });

  test("a PATCH that leaves the rubric alone keeps the attachment", async () => {
    asUser("teacher-a");
    const { assessmentId, itemId, rubricId } = await essayWithSavedRubric();
    const res = await patchItem(assessmentId, itemId, {
      type: "essay",
      stem: "A different prompt entirely.",
      rubric: ANALYTIC,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ItemConfigBody;
    expect(body.item.config.rubric_id).toBe(rubricId);
  });

  test("an explicit null detaches", async () => {
    asUser("teacher-a");
    const { assessmentId, itemId } = await essayWithSavedRubric();
    const res = await patchItem(assessmentId, itemId, {
      type: "essay",
      stem: "Write an argument.",
      rubric: ANALYTIC,
      rubric_id: null,
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as ItemConfigBody).item.config.rubric_id).toBeUndefined();
  });

  test("removing the rubric removes the attachment with it", async () => {
    asUser("teacher-a");
    const { assessmentId, itemId } = await essayWithSavedRubric();
    const res = await patchItem(assessmentId, itemId, {
      type: "essay",
      stem: "Write an argument.",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ItemConfigBody;
    expect(body.item.config.rubric).toBeUndefined();
    expect(body.item.config.rubric_id).toBeUndefined();
  });
});

// ------------------------------------------------ it stays editor metadata

describe("rubric_id never leaves the editor", () => {
  test("neither the export bundle nor the delivery bundle carries it", async () => {
    asUser("teacher-a");
    const { assessmentId, rubricId } = await essayWithSavedRubric();
    // during_test so the rubric itself DOES ride the delivery bundle — the
    // id must be absent even where the rubric is present.
    await getDb().execute(
      sql`update items set config = jsonb_set(config, '{rubric,student_visibility}', '{"during_test": true}'::jsonb)
          where assessment_id = ${assessmentId}::uuid`,
    );

    const { GET: EXPORT } = await import("../app/api/assessments/[id]/export/route");
    const exported = await EXPORT(
      new Request(`http://localhost/api/assessments/${assessmentId}/export?include_hidden_rubrics=1`),
      { params: Promise.resolve({ id: assessmentId }) },
    );
    expect(exported.status).toBe(200);
    const exportText = await exported.text();
    expect(exportText).toContain('"rubric"');
    expect(exportText).not.toContain("rubric_id");
    expect(exportText).not.toContain(rubricId);

    const { buildDeliveryBundle } = await import("../lib/api/buildDeliveryBundle");
    const { assessments } = await import("../db/schema");
    const { eq } = await import("drizzle-orm");
    const [assessmentRow] = await getDb()
      .select()
      .from(assessments)
      .where(eq(assessments.id, assessmentId))
      .limit(1);
    const delivery = await buildDeliveryBundle(
      getDb(),
      assessmentRow!,
      { enabled: {}, constructAltering: [] },
      MISSING_UUID,
      MISSING_UUID,
    );
    const deliveryText = JSON.stringify(delivery);
    expect(deliveryText).toContain('"rubric"');
    expect(deliveryText).not.toContain("rubric_id");
    expect(deliveryText).not.toContain(rubricId);
  });
});

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { sql } from "drizzle-orm";
import { closeDb, getDb } from "../db/client";
import { SESSION_COOKIE_NAME } from "../lib/auth/session";
import * as sessionMod from "../lib/auth/session";

const expectTestDb = () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("secure_test_design_tool_test")) {
    throw new Error(
      `overrides-api tests require the test DB DATABASE_URL; got: ${url}`,
    );
  }
};

let originalSessionSecret: string | undefined;
let mockSub: string | null = null;

mock.module("next/headers", () => ({
  // Slice 58: requireSession now reads an Authorization bearer header as
  // well as the cookie, so the mocked module has to provide headers().
  headers: async () => new Headers(),
  cookies: async () => ({
    get: (name: string) =>
      mockSub && name === SESSION_COOKIE_NAME ? { value: "x" } : undefined,
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
  await db.execute(sql`truncate table students restart identity cascade`);
});

afterAll(async () => {
  await closeDb();
  if (originalSessionSecret === undefined) {
    delete process.env.DESIGN_TOOL_SESSION_SECRET;
  } else {
    process.env.DESIGN_TOOL_SESSION_SECRET = originalSessionSecret;
  }
});

async function createAssessment(opts: {
  name?: string;
  allowed_accommodations?: string[];
  construct_altering?: string[];
}): Promise<string> {
  const { POST } = await import("../app/api/assessments/route");
  const res = await POST(
    new Request("http://localhost/api/assessments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: opts.name ?? "Override target",
        allowed_accommodations: opts.allowed_accommodations ?? [],
        construct_altering: opts.construct_altering ?? [],
      }),
    }),
  );
  return ((await res.json()) as { assessment: { id: string } }).assessment.id;
}

async function createStudent(ssid: string): Promise<string> {
  const { POST } = await import("../app/api/students/route");
  const res = await POST(
    new Request("http://localhost/api/students", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ssid }),
    }),
  );
  return ((await res.json()) as { student: { id: string } }).student.id;
}

async function listOverrides(assessmentId: string) {
  const { GET } = await import(
    "../app/api/assessments/[id]/overrides/route"
  );
  return GET(
    new Request(`http://localhost/api/assessments/${assessmentId}/overrides`),
    { params: Promise.resolve({ id: assessmentId }) },
  );
}

async function postOverride(assessmentId: string, body: unknown) {
  const { POST } = await import(
    "../app/api/assessments/[id]/overrides/route"
  );
  return POST(
    new Request(`http://localhost/api/assessments/${assessmentId}/overrides`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: assessmentId }) },
  );
}

async function deleteOverride(assessmentId: string, overrideId: string) {
  const { DELETE } = await import(
    "../app/api/assessments/[id]/overrides/[overrideId]/route"
  );
  return DELETE(
    new Request(
      `http://localhost/api/assessments/${assessmentId}/overrides/${overrideId}`,
      { method: "DELETE" },
    ),
    { params: Promise.resolve({ id: assessmentId, overrideId }) },
  );
}

describe("POST /api/assessments/[id]/overrides (slice 23b)", () => {
  test("requires a session", async () => {
    asUser(null);
    const res = await postOverride("00000000-0000-0000-0000-000000000000", {});
    expect(res.status).toBe(401);
  });

  test("creates an override and lists it", async () => {
    asUser("teacher-1");
    const aid = await createAssessment({
      allowed_accommodations: ["color_contrast", "tts_for_ela_reading"],
    });
    const sid = await createStudent("T001");
    const res = await postOverride(aid, {
      student_id: sid,
      tool_id: "color_contrast",
      value: "Yellow on Black",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      override: { tool_id: string; value: string; created_by_sub: string };
    };
    expect(body.override.tool_id).toBe("color_contrast");
    expect(body.override.value).toBe("Yellow on Black");
    expect(body.override.created_by_sub).toBe("teacher-1");

    const list = await listOverrides(aid);
    const listBody = (await list.json()) as {
      overrides: { student_ssid: string; value: string }[];
    };
    expect(listBody.overrides.length).toBe(1);
    expect(listBody.overrides[0]!.student_ssid).toBe("T001");
    expect(listBody.overrides[0]!.value).toBe("Yellow on Black");
  });

  test("rejects a tool that's not in allowed_accommodations", async () => {
    asUser("teacher-1");
    const aid = await createAssessment({
      allowed_accommodations: ["color_contrast"], // tts NOT allowed
    });
    const sid = await createStudent("T001");
    const res = await postOverride(aid, {
      student_id: sid,
      tool_id: "tts_for_ela_reading",
      value: "On",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("tool_not_in_allowed_accommodations");
  });

  test("upserts on (assessment, student, tool) — same triple replaces value", async () => {
    asUser("teacher-1");
    const aid = await createAssessment({
      allowed_accommodations: ["color_contrast"],
    });
    const sid = await createStudent("T001");
    await postOverride(aid, {
      student_id: sid,
      tool_id: "color_contrast",
      value: "Yellow on Black",
    });
    const second = await postOverride(aid, {
      student_id: sid,
      tool_id: "color_contrast",
      value: "Red on White",
    });
    expect(second.status).toBe(201);
    const list = await listOverrides(aid);
    const body = (await list.json()) as {
      overrides: { value: string }[];
    };
    expect(body.overrides.length).toBe(1);
    expect(body.overrides[0]!.value).toBe("Red on White");
  });

  test("rejects unknown tool_id at the Zod layer", async () => {
    asUser("teacher-1");
    const aid = await createAssessment({
      allowed_accommodations: ["color_contrast"],
    });
    const sid = await createStudent("T001");
    const res = await postOverride(aid, {
      student_id: sid,
      tool_id: "totally_made_up",
      value: "On",
    });
    expect(res.status).toBe(400);
  });

  test("rejects when student belongs to another teacher", async () => {
    asUser("teacher-A");
    const aid = await createAssessment({
      allowed_accommodations: ["color_contrast"],
    });
    asUser("teacher-B");
    const sid = await createStudent("T001");
    // Teacher A is the assessment owner; the override post fires as A.
    asUser("teacher-A");
    const res = await postOverride(aid, {
      student_id: sid,
      tool_id: "color_contrast",
      value: "On",
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("student_forbidden");
  });

  test("rejects when assessment belongs to another teacher", async () => {
    asUser("teacher-A");
    const aid = await createAssessment({
      allowed_accommodations: ["color_contrast"],
    });
    asUser("teacher-B");
    const sid = await createStudent("T001");
    const res = await postOverride(aid, {
      student_id: sid,
      tool_id: "color_contrast",
      value: "On",
    });
    expect(res.status).toBe(403);
  });
});

describe("GET /api/assessments/[id]/overrides", () => {
  test("returns only this assessment's overrides (joined with student names)", async () => {
    asUser("teacher-1");
    const aid1 = await createAssessment({
      allowed_accommodations: ["color_contrast"],
    });
    const aid2 = await createAssessment({
      allowed_accommodations: ["color_contrast"],
    });
    const sid = await createStudent("T001");
    await postOverride(aid1, {
      student_id: sid,
      tool_id: "color_contrast",
      value: "X",
    });
    await postOverride(aid2, {
      student_id: sid,
      tool_id: "color_contrast",
      value: "Y",
    });
    const list = await listOverrides(aid1);
    const body = (await list.json()) as {
      overrides: { value: string; student_ssid: string }[];
    };
    expect(body.overrides.length).toBe(1);
    expect(body.overrides[0]!.value).toBe("X");
    expect(body.overrides[0]!.student_ssid).toBe("T001");
  });

  test("requires assessment ownership for read too", async () => {
    asUser("teacher-A");
    const aid = await createAssessment({
      allowed_accommodations: ["color_contrast"],
    });
    asUser("teacher-B");
    const res = await listOverrides(aid);
    expect(res.status).toBe(403);
  });
});

describe("DELETE /api/assessments/[id]/overrides/[overrideId]", () => {
  test("clears the override", async () => {
    asUser("teacher-1");
    const aid = await createAssessment({
      allowed_accommodations: ["color_contrast"],
    });
    const sid = await createStudent("T001");
    const c = await postOverride(aid, {
      student_id: sid,
      tool_id: "color_contrast",
      value: "On",
    });
    const oid = ((await c.json()) as { override: { id: string } }).override.id;
    const res = await deleteOverride(aid, oid);
    expect(res.status).toBe(204);
    const list = await listOverrides(aid);
    const body = (await list.json()) as { overrides: unknown[] };
    expect(body.overrides).toEqual([]);
  });

  test("404 when the override doesn't belong to the URL's assessment", async () => {
    asUser("teacher-1");
    const aid1 = await createAssessment({
      allowed_accommodations: ["color_contrast"],
    });
    const aid2 = await createAssessment({
      allowed_accommodations: ["color_contrast"],
    });
    const sid = await createStudent("T001");
    const c = await postOverride(aid1, {
      student_id: sid,
      tool_id: "color_contrast",
      value: "On",
    });
    const oid = ((await c.json()) as { override: { id: string } }).override.id;
    // Try to delete via aid2's path — should 404 (override is for aid1).
    const res = await deleteOverride(aid2, oid);
    expect(res.status).toBe(404);
  });

  test("403 when the assessment belongs to another teacher", async () => {
    asUser("teacher-A");
    const aid = await createAssessment({
      allowed_accommodations: ["color_contrast"],
    });
    const sid = await createStudent("T001");
    const c = await postOverride(aid, {
      student_id: sid,
      tool_id: "color_contrast",
      value: "On",
    });
    const oid = ((await c.json()) as { override: { id: string } }).override.id;
    asUser("teacher-B");
    const res = await deleteOverride(aid, oid);
    expect(res.status).toBe(403);
  });
});

// C11: the overrides panel disables its controls when the assessment is
// published, but that was a CLIENT-side affordance only — neither route called
// requireDraft, so a direct API call mutated a published assessment's
// per-student accommodations with no 409.
describe("C11 — overrides respect the publish lock", () => {
  async function publish(assessmentId: string) {
    const { PATCH } = await import("../app/api/assessments/[id]/route");
    const res = await PATCH(
      new Request(`http://localhost/api/assessments/${assessmentId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "published" }),
      }),
      { params: Promise.resolve({ id: assessmentId }) },
    );
    expect(res.status).toBe(200);
  }

  test("POST on a published assessment is rejected with 409", async () => {
    asUser("teacher-1");
    const aid = await createAssessment({
      allowed_accommodations: ["color_contrast"],
    });
    const sid = await createStudent("T001");
    await publish(aid);
    const res = await postOverride(aid, {
      student_id: sid,
      tool_id: "color_contrast",
      value: "On",
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("assessment_published_editing_locked");

    const list = await listOverrides(aid);
    expect(((await list.json()) as { overrides: unknown[] }).overrides).toEqual(
      [],
    );
  });

  test("DELETE on a published assessment is rejected with 409", async () => {
    asUser("teacher-1");
    const aid = await createAssessment({
      allowed_accommodations: ["color_contrast"],
    });
    const sid = await createStudent("T001");
    const c = await postOverride(aid, {
      student_id: sid,
      tool_id: "color_contrast",
      value: "On",
    });
    const oid = ((await c.json()) as { override: { id: string } }).override.id;
    await publish(aid);

    const res = await deleteOverride(aid, oid);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("assessment_published_editing_locked");
    // The override survived.
    const list = await listOverrides(aid);
    expect(
      ((await list.json()) as { overrides: unknown[] }).overrides.length,
    ).toBe(1);
  });

  test("GET stays readable while published", async () => {
    asUser("teacher-1");
    const aid = await createAssessment({
      allowed_accommodations: ["color_contrast"],
    });
    await publish(aid);
    expect((await listOverrides(aid)).status).toBe(200);
  });
});

// D15: PATCH auto-clamps construct_altering when allowed_accommodations
// shrinks, but left assessment_student_overrides untouched — overrides for
// now-disallowed tools survived and were still served, breaking the exact
// invariant the POST route enforces on write.
describe("D15 — shrinking allowed_accommodations clears orphaned overrides", () => {
  async function patchAllowed(assessmentId: string, allowed: string[]) {
    const { PATCH } = await import("../app/api/assessments/[id]/route");
    return PATCH(
      new Request(`http://localhost/api/assessments/${assessmentId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ allowed_accommodations: allowed }),
      }),
      { params: Promise.resolve({ id: assessmentId }) },
    );
  }

  async function currentOverrideTools(assessmentId: string) {
    const list = await listOverrides(assessmentId);
    const body = (await list.json()) as { overrides: { tool_id: string }[] };
    return body.overrides.map((o) => o.tool_id).sort();
  }

  test("drops overrides whose tool is no longer allowed, keeps the rest", async () => {
    asUser("teacher-1");
    const aid = await createAssessment({
      allowed_accommodations: ["color_contrast", "highlighter"],
    });
    const sid = await createStudent("T001");
    expect(
      (
        await postOverride(aid, {
          student_id: sid,
          tool_id: "color_contrast",
          value: "Yellow on Black",
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await postOverride(aid, {
          student_id: sid,
          tool_id: "highlighter",
          value: "On",
        })
      ).status,
    ).toBe(201);
    expect(await currentOverrideTools(aid)).toEqual([
      "color_contrast",
      "highlighter",
    ]);

    // Shrink: highlighter is no longer allowed.
    expect((await patchAllowed(aid, ["color_contrast"])).status).toBe(200);
    expect(await currentOverrideTools(aid)).toEqual(["color_contrast"]);
  });

  test("clearing allowed_accommodations entirely drops every override", async () => {
    asUser("teacher-1");
    const aid = await createAssessment({
      allowed_accommodations: ["color_contrast"],
    });
    const sid = await createStudent("T001");
    await postOverride(aid, {
      student_id: sid,
      tool_id: "color_contrast",
      value: "On",
    });
    expect((await patchAllowed(aid, [])).status).toBe(200);
    expect(await currentOverrideTools(aid)).toEqual([]);
  });

  test("a PATCH that doesn't touch allowed_accommodations leaves overrides alone", async () => {
    asUser("teacher-1");
    const aid = await createAssessment({
      allowed_accommodations: ["color_contrast"],
    });
    const sid = await createStudent("T001");
    await postOverride(aid, {
      student_id: sid,
      tool_id: "color_contrast",
      value: "On",
    });
    const { PATCH } = await import("../app/api/assessments/[id]/route");
    const res = await PATCH(
      new Request(`http://localhost/api/assessments/${aid}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "renamed" }),
      }),
      { params: Promise.resolve({ id: aid }) },
    );
    expect(res.status).toBe(200);
    expect(await currentOverrideTools(aid)).toEqual(["color_contrast"]);
  });

  test("widening allowed_accommodations keeps existing overrides", async () => {
    asUser("teacher-1");
    const aid = await createAssessment({
      allowed_accommodations: ["color_contrast"],
    });
    const sid = await createStudent("T001");
    await postOverride(aid, {
      student_id: sid,
      tool_id: "color_contrast",
      value: "On",
    });
    expect(
      (await patchAllowed(aid, ["color_contrast", "highlighter"])).status,
    ).toBe(200);
    expect(await currentOverrideTools(aid)).toEqual(["color_contrast"]);
  });
});

describe("cascade behavior", () => {
  test("deleting the assessment removes its overrides", async () => {
    asUser("teacher-1");
    const aid = await createAssessment({
      allowed_accommodations: ["color_contrast"],
    });
    const sid = await createStudent("T001");
    await postOverride(aid, {
      student_id: sid,
      tool_id: "color_contrast",
      value: "On",
    });
    const { DELETE } = await import("../app/api/assessments/[id]/route");
    const del = await DELETE(
      new Request(`http://localhost/api/assessments/${aid}`, {
        method: "DELETE",
      }),
      { params: Promise.resolve({ id: aid }) },
    );
    expect(del.status).toBe(204);
    // Override row should be gone via FK cascade.
    const db = getDb();
    const remaining = await db.execute(
      sql`select count(*)::int as n from assessment_student_overrides`,
    );
    expect(Number(remaining[0]!.n)).toBe(0);
  });

  test("deleting the student removes the override too", async () => {
    asUser("teacher-1");
    const aid = await createAssessment({
      allowed_accommodations: ["color_contrast"],
    });
    const sid = await createStudent("T001");
    await postOverride(aid, {
      student_id: sid,
      tool_id: "color_contrast",
      value: "On",
    });
    const { DELETE } = await import("../app/api/students/[id]/route");
    const del = await DELETE(
      new Request(`http://localhost/api/students/${sid}`, {
        method: "DELETE",
      }),
      { params: Promise.resolve({ id: sid }) },
    );
    expect(del.status).toBe(204);
    const list = await listOverrides(aid);
    const body = (await list.json()) as { overrides: unknown[] };
    expect(body.overrides).toEqual([]);
  });
});

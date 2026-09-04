// Integration tests for the assessments CRUD API. Hits the real route
// handlers and the local Postgres test database (DATABASE_URL must point
// at secure_test_design_tool_test before this suite is invoked).
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { closeDb, getDb } from "../db/client";
import { mintSessionJWT, SESSION_COOKIE_NAME } from "../lib/auth/session";

const expectTestDb = () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("secure_test_design_tool_test")) {
    throw new Error(
      `assessments-api tests require DATABASE_URL pointing at the test DB; got: ${url}`,
    );
  }
};

let originalSessionSecret: string | undefined;

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

async function sessionCookieHeader(sub: string): Promise<string> {
  const jwt = await mintSessionJWT({ sub, role: "staff" });
  return `${SESSION_COOKIE_NAME}=${jwt}`;
}

async function callList(cookie?: string) {
  const { GET } = await import("../app/api/assessments/route");
  const req = new Request("http://localhost/api/assessments", {
    headers: cookie ? { cookie } : {},
  });
  return GET();
}

async function callCreate(body: unknown, cookie?: string) {
  const { POST } = await import("../app/api/assessments/route");
  const req = new Request("http://localhost/api/assessments", {
    method: "POST",
    headers: {
      ...(cookie ? { cookie } : {}),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return POST(req);
}

async function callGetById(id: string, cookie?: string) {
  const { GET } = await import("../app/api/assessments/[id]/route");
  const req = new Request(`http://localhost/api/assessments/${id}`, {
    headers: cookie ? { cookie } : {},
  });
  return GET(req, { params: Promise.resolve({ id }) });
}

async function callPatch(id: string, body: unknown, cookie?: string) {
  const { PATCH } = await import("../app/api/assessments/[id]/route");
  const req = new Request(`http://localhost/api/assessments/${id}`, {
    method: "PATCH",
    headers: {
      ...(cookie ? { cookie } : {}),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return PATCH(req, { params: Promise.resolve({ id }) });
}

async function callDelete(id: string, cookie?: string) {
  const { DELETE } = await import("../app/api/assessments/[id]/route");
  const req = new Request(`http://localhost/api/assessments/${id}`, {
    method: "DELETE",
    headers: cookie ? { cookie } : {},
  });
  return DELETE(req, { params: Promise.resolve({ id }) });
}

// next/headers' cookies() reads via AsyncLocalStorage in Next.js. In the
// test environment we don't have a Next request scope, so the session
// helper falls back to whichever cookie store is exposed. To make this
// simple, we mock readSessionFromCookies by stuffing the cookie into a
// global override before each call.
import { mock } from "bun:test";
import * as sessionMod from "../lib/auth/session";

let mockSub: string | null = null;

mock.module("next/headers", () => ({
  // Slice 58: requireSession now reads an Authorization bearer header as
  // well as the cookie, so the mocked module has to provide headers().
  headers: async () => new Headers(),
  cookies: async () => ({
    get: (name: string) => {
      if (mockSub && name === sessionMod.SESSION_COOKIE_NAME) {
        return { value: "fake-token-cookie-value" };
      }
      return undefined;
    },
  }),
}));

mock.module("../lib/auth/session", () => ({
  ...sessionMod,
  readSessionFromCookies: async () =>
    mockSub
      ? { sub: mockSub, role: "staff" }
      : null,
}));

function asUser(sub: string | null) {
  mockSub = sub;
}

describe("POST /api/assessments", () => {
  test("requires a session", async () => {
    asUser(null);
    const res = await callCreate({ name: "x" });
    expect(res.status).toBe(401);
  });

  test("creates a row owned by the session sub", async () => {
    asUser("teacher-1");
    const res = await callCreate({ name: "MVP smoke test" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { assessment: { id: string; name: string; owner_sub: string } };
    expect(body.assessment.name).toBe("MVP smoke test");
    expect(body.assessment.owner_sub).toBe("teacher-1");
    expect(body.assessment.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  test("rejects an invalid body", async () => {
    asUser("teacher-1");
    const res = await callCreate({ name: "" });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/assessments (list)", () => {
  test("returns only the session sub's rows", async () => {
    asUser("teacher-1");
    await callCreate({ name: "mine A" });
    await callCreate({ name: "mine B" });
    asUser("teacher-2");
    await callCreate({ name: "theirs" });

    asUser("teacher-1");
    const res = await callList();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { assessments: { name: string; owner_sub: string }[] };
    const names = body.assessments.map((a) => a.name).sort();
    expect(names).toEqual(["mine A", "mine B"]);
    expect(body.assessments.every((a) => a.owner_sub === "teacher-1")).toBe(true);
  });

  test("requires a session", async () => {
    asUser(null);
    const res = await callList();
    expect(res.status).toBe(401);
  });
});

describe("GET /api/assessments/[id]", () => {
  test("returns the row + empty items array", async () => {
    asUser("teacher-1");
    const createRes = await callCreate({ name: "with-items" });
    const created = (await createRes.json()) as { assessment: { id: string } };

    const res = await callGetById(created.assessment.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { assessment: { name: string }; items: unknown[] };
    expect(body.assessment.name).toBe("with-items");
    expect(body.items).toEqual([]);
  });

  test("404 for an unknown but valid uuid", async () => {
    asUser("teacher-1");
    const res = await callGetById("00000000-0000-0000-0000-000000000000");
    expect(res.status).toBe(404);
  });

  test("403 when another user tries to read", async () => {
    asUser("teacher-1");
    const createRes = await callCreate({ name: "private" });
    const created = (await createRes.json()) as { assessment: { id: string } };
    asUser("teacher-2");
    const res = await callGetById(created.assessment.id);
    expect(res.status).toBe(403);
  });

  test("400 for malformed id", async () => {
    asUser("teacher-1");
    const res = await callGetById("not-a-uuid");
    expect(res.status).toBe(400);
  });
});

describe("PATCH /api/assessments/[id]", () => {
  test("updates allowed fields", async () => {
    asUser("teacher-1");
    const createRes = await callCreate({ name: "old" });
    const created = (await createRes.json()) as { assessment: { id: string } };

    const res = await callPatch(created.assessment.id, {
      name: "new",
      status: "published",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { assessment: { name: string; status: string } };
    expect(body.assessment.name).toBe("new");
    expect(body.assessment.status).toBe("published");
  });

  test("rejects an invalid status value", async () => {
    asUser("teacher-1");
    const createRes = await callCreate({ name: "x" });
    const created = (await createRes.json()) as { assessment: { id: string } };
    const res = await callPatch(created.assessment.id, { status: "bogus" });
    expect(res.status).toBe(400);
  });
});

describe("DELETE /api/assessments/[id]", () => {
  test("removes the row and returns 204", async () => {
    asUser("teacher-1");
    const createRes = await callCreate({ name: "delete-me" });
    const created = (await createRes.json()) as { assessment: { id: string } };

    const res = await callDelete(created.assessment.id);
    expect(res.status).toBe(204);

    const fetch = await callGetById(created.assessment.id);
    expect(fetch.status).toBe(404);
  });

  test("403 when another user tries to delete", async () => {
    asUser("teacher-1");
    const createRes = await callCreate({ name: "private-delete" });
    const created = (await createRes.json()) as { assessment: { id: string } };
    asUser("teacher-2");
    const res = await callDelete(created.assessment.id);
    expect(res.status).toBe(403);
  });
});

describe("slice 20 — allowed_accommodations round-trip", () => {
  test("create defaults to an empty array", async () => {
    asUser("teacher-1");
    const res = await callCreate({ name: "no-accoms" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      assessment: { allowed_accommodations: string[] };
    };
    expect(body.assessment.allowed_accommodations).toEqual([]);
  });

  test("create + GET round-trip with multiple ids", async () => {
    asUser("teacher-1");
    const createRes = await callCreate({
      name: "with-accoms",
      allowed_accommodations: ["color_contrast", "zoom", "highlighter"],
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as {
      assessment: { id: string; allowed_accommodations: string[] };
    };
    expect([...created.assessment.allowed_accommodations].sort()).toEqual([
      "color_contrast",
      "highlighter",
      "zoom",
    ]);

    const getRes = await callGetById(created.assessment.id);
    const fetched = (await getRes.json()) as {
      assessment: { allowed_accommodations: string[] };
    };
    expect([...fetched.assessment.allowed_accommodations].sort()).toEqual([
      "color_contrast",
      "highlighter",
      "zoom",
    ]);
  });

  test("PATCH updates allowed_accommodations", async () => {
    asUser("teacher-1");
    const createRes = await callCreate({ name: "patch-target" });
    const id = ((await createRes.json()) as { assessment: { id: string } })
      .assessment.id;
    const patchRes = await callPatch(id, {
      allowed_accommodations: ["permissive_mode", "tts_test_content"],
    });
    expect(patchRes.status).toBe(200);
    const patched = (await patchRes.json()) as {
      assessment: { allowed_accommodations: string[] };
    };
    expect([...patched.assessment.allowed_accommodations].sort()).toEqual([
      "permissive_mode",
      "tts_test_content",
    ]);
  });

  test("create rejects an unknown accommodation id", async () => {
    asUser("teacher-1");
    const res = await callCreate({
      name: "bogus",
      allowed_accommodations: ["color_contrast", "not_a_real_tool"],
    });
    expect(res.status).toBe(400);
  });

  test("PATCH rejects an unknown accommodation id", async () => {
    asUser("teacher-1");
    const createRes = await callCreate({ name: "valid" });
    const id = ((await createRes.json()) as { assessment: { id: string } })
      .assessment.id;
    const patchRes = await callPatch(id, {
      allowed_accommodations: ["totally_made_up"],
    });
    expect(patchRes.status).toBe(400);
  });
});

describe("slice 21 — construct_altering opt-in", () => {
  test("create defaults to an empty array", async () => {
    asUser("teacher-1");
    const res = await callCreate({ name: "no-ca" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      assessment: { construct_altering: string[] };
    };
    expect(body.assessment.construct_altering).toEqual([]);
  });

  test("create round-trips both arrays", async () => {
    asUser("teacher-1");
    const res = await callCreate({
      name: "with-ca",
      allowed_accommodations: ["tts_for_ela_reading", "color_contrast"],
      construct_altering: ["tts_for_ela_reading"],
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      assessment: {
        id: string;
        allowed_accommodations: string[];
        construct_altering: string[];
      };
    };
    expect([...body.assessment.allowed_accommodations].sort()).toEqual([
      "color_contrast",
      "tts_for_ela_reading",
    ]);
    expect(body.assessment.construct_altering).toEqual([
      "tts_for_ela_reading",
    ]);
  });

  test("create rejects construct_altering not in allowed_accommodations", async () => {
    asUser("teacher-1");
    const res = await callCreate({
      name: "subset-violation",
      allowed_accommodations: ["color_contrast"],
      construct_altering: ["tts_for_ela_reading"],
    });
    expect(res.status).toBe(400);
  });

  test("PATCH both arrays at once is enforced by Zod", async () => {
    asUser("teacher-1");
    const createRes = await callCreate({ name: "patch-both" });
    const id = ((await createRes.json()) as { assessment: { id: string } })
      .assessment.id;
    const ok = await callPatch(id, {
      allowed_accommodations: ["color_contrast", "tts_for_ela_reading"],
      construct_altering: ["tts_for_ela_reading"],
    });
    expect(ok.status).toBe(200);
    const bad = await callPatch(id, {
      allowed_accommodations: ["color_contrast"],
      construct_altering: ["tts_for_ela_reading"],
    });
    expect(bad.status).toBe(400);
  });

  test("PATCH construct_altering alone is checked against current row", async () => {
    asUser("teacher-1");
    const createRes = await callCreate({
      name: "ca-only-patch",
      allowed_accommodations: ["color_contrast", "tts_for_ela_reading"],
    });
    const id = ((await createRes.json()) as { assessment: { id: string } })
      .assessment.id;
    // OK: tts_for_ela_reading IS currently in allowed_accommodations.
    const ok = await callPatch(id, {
      construct_altering: ["tts_for_ela_reading"],
    });
    expect(ok.status).toBe(200);
    // Bad: highlighter is NOT in the row's allowed_accommodations.
    const bad = await callPatch(id, {
      construct_altering: ["highlighter"],
    });
    expect(bad.status).toBe(400);
    const errBody = (await bad.json()) as {
      error: string;
      orphan_id: string;
    };
    expect(errBody.error).toBe("construct_altering_must_be_subset");
    expect(errBody.orphan_id).toBe("highlighter");
  });

  test("PATCH that shrinks allowed_accommodations auto-clamps construct_altering", async () => {
    asUser("teacher-1");
    const createRes = await callCreate({
      name: "auto-clamp",
      allowed_accommodations: ["color_contrast", "tts_for_ela_reading"],
      construct_altering: ["tts_for_ela_reading"],
    });
    const id = ((await createRes.json()) as { assessment: { id: string } })
      .assessment.id;
    // Drop tts_for_ela_reading from allowed; server must drop it from
    // construct_altering too rather than leaving an orphan or 400ing.
    const patch = await callPatch(id, {
      allowed_accommodations: ["color_contrast"],
    });
    expect(patch.status).toBe(200);
    const patched = (await patch.json()) as {
      assessment: {
        allowed_accommodations: string[];
        construct_altering: string[];
      };
    };
    expect(patched.assessment.allowed_accommodations).toEqual([
      "color_contrast",
    ]);
    expect(patched.assessment.construct_altering).toEqual([]);
  });
});

describe("slice 19 — time_limit_seconds round-trip", () => {
  test("create accepts time_limit_seconds and round-trips", async () => {
    asUser("teacher-1");
    const createRes = await callCreate({
      name: "timed",
      time_limit_seconds: 1800,
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as {
      assessment: { id: string; time_limit_seconds: number | null };
    };
    expect(created.assessment.time_limit_seconds).toBe(1800);

    const getRes = await callGetById(created.assessment.id);
    const body = (await getRes.json()) as {
      assessment: { time_limit_seconds: number | null };
    };
    expect(body.assessment.time_limit_seconds).toBe(1800);
  });

  test("create accepts null for time_limit_seconds (untimed)", async () => {
    asUser("teacher-1");
    const createRes = await callCreate({
      name: "untimed",
      time_limit_seconds: null,
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as {
      assessment: { time_limit_seconds: number | null };
    };
    expect(created.assessment.time_limit_seconds).toBeNull();
  });

  test("PATCH updates time_limit_seconds", async () => {
    asUser("teacher-1");
    const createRes = await callCreate({ name: "to-be-timed" });
    const id = ((await createRes.json()) as { assessment: { id: string } })
      .assessment.id;
    const patchRes = await callPatch(id, { time_limit_seconds: 600 });
    expect(patchRes.status).toBe(200);
    const patched = (await patchRes.json()) as {
      assessment: { time_limit_seconds: number | null };
    };
    expect(patched.assessment.time_limit_seconds).toBe(600);
  });
});

describe("slice 19 — publish lock", () => {
  test("metadata PATCH while published is rejected with 409", async () => {
    asUser("teacher-1");
    const createRes = await callCreate({ name: "lock-me" });
    const id = ((await createRes.json()) as { assessment: { id: string } })
      .assessment.id;
    // Publish it first.
    expect((await callPatch(id, { status: "published" })).status).toBe(200);
    // Now any non-unlock PATCH should bounce.
    const res = await callPatch(id, { name: "rename attempt" });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("assessment_published_editing_locked");
  });

  test("PATCH status: 'draft' while published is the unlock path", async () => {
    asUser("teacher-1");
    const createRes = await callCreate({ name: "unlock-me" });
    const id = ((await createRes.json()) as { assessment: { id: string } })
      .assessment.id;
    await callPatch(id, { status: "published" });
    const unlock = await callPatch(id, { status: "draft" });
    expect(unlock.status).toBe(200);
    // After unlock, regular edits work again.
    const rename = await callPatch(id, { name: "renamed after unlock" });
    expect(rename.status).toBe(200);
  });

  // C10: DELETE had no publish guard, so the published assessment and all its
  // items hard-deleted with a 204 while every edit path 409'd.
  test("DELETE on a published assessment is rejected with 409", async () => {
    asUser("teacher-1");
    const createRes = await callCreate({ name: "delete-published" });
    const id = ((await createRes.json()) as { assessment: { id: string } })
      .assessment.id;
    await callPatch(id, { status: "published" });
    const del = await callDelete(id);
    expect(del.status).toBe(409);
    const body = (await del.json()) as { error: string };
    expect(body.error).toBe("assessment_published_editing_locked");
    // The row is still there.
    expect((await callGetById(id)).status).toBe(200);
  });

  test("unlock to draft, then DELETE succeeds", async () => {
    asUser("teacher-1");
    const createRes = await callCreate({ name: "unlock-then-delete" });
    const id = ((await createRes.json()) as { assessment: { id: string } })
      .assessment.id;
    await callPatch(id, { status: "published" });
    expect((await callPatch(id, { status: "draft" })).status).toBe(200);
    expect((await callDelete(id)).status).toBe(204);
  });
});

// C9: the unlock check required a body with exactly ONE key, but the editor's
// saveMetadata always sends all six metadata fields — so following the lock
// banner's own instructions 409'd every time and the assessment could never be
// unlocked from the UI. The check now keys on CHANGED fields, not present ones.
describe("C9 — unlock with a full metadata body", () => {
  const FULL_METADATA = {
    name: "c9-subject",
    description: "original description",
    time_limit_seconds: 1800,
    allowed_accommodations: [],
    construct_altering: [],
  };

  async function publishedSubject() {
    asUser("teacher-1");
    const createRes = await callCreate(FULL_METADATA);
    const id = ((await createRes.json()) as { assessment: { id: string } })
      .assessment.id;
    expect((await callPatch(id, { status: "published" })).status).toBe(200);
    return id;
  }

  test("full-body PATCH that only changes status→draft unlocks (editor shape)", async () => {
    const id = await publishedSubject();
    // Exactly what AssessmentEditor.saveMetadata sends.
    const res = await callPatch(id, { ...FULL_METADATA, status: "draft" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { assessment: { status: string } };
    expect(body.assessment.status).toBe("draft");
  });

  test("full-body PATCH that also changes another field is still locked out", async () => {
    const id = await publishedSubject();
    const res = await callPatch(id, {
      ...FULL_METADATA,
      name: "sneaky rename",
      status: "draft",
    });
    expect(res.status).toBe(409);
    // Still published, still named as before — nothing smuggled through.
    const after = (await (await callGetById(id)).json()) as {
      assessment: { status: string; name: string };
    };
    expect(after.assessment.status).toBe("published");
    expect(after.assessment.name).toBe("c9-subject");
  });

  test("a full-body PATCH with no status change is still locked out", async () => {
    const id = await publishedSubject();
    const res = await callPatch(id, FULL_METADATA);
    expect(res.status).toBe(409);
  });
});

// Client paging (docs/client-paging-design.md, D-1): a per-assessment
// setting, default scroll, validated on create and patch.
describe("student_layout (client paging)", () => {
  test("defaults to scroll, accepts paged on create and on patch, rejects anything else", async () => {
    mockSub = "layout-teacher";
    const created = await callCreate({ name: "Paged?" });
    expect(created.status).toBe(201);
    const { assessment } = (await created.json()) as { assessment: { id: string; student_layout: string } };
    expect(assessment.student_layout).toBe("scroll");

    const paged = await callCreate({ name: "Paged", student_layout: "paged" });
    expect(paged.status).toBe(201);
    expect(((await paged.json()) as { assessment: { student_layout: string } }).assessment.student_layout).toBe("paged");

    const patched = await callPatch(assessment.id, { student_layout: "paged" });
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as { assessment: { student_layout: string } }).assessment.student_layout).toBe("paged");

    expect((await callCreate({ name: "x", student_layout: "sideways" })).status).toBe(400);
    expect((await callPatch(assessment.id, { student_layout: "sideways" })).status).toBe(400);
  });
});

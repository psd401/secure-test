// The grants API (docs/access-model-design.md, D-1/D-2/D-3), access slice 2.
//
// Two surfaces with deliberately different gates, and the tests below are mostly
// about the gates rather than the happy path:
//
//   POST/GET/DELETE /api/assessments/[id]/grants — the OWNER's, `own`-level,
//     scope fixed to this assessment so a teacher can never write a
//     teacher-scoped grant over a colleague.
//   GET/POST /api/grants — the ADMIN's, and 404 (not 403) for everyone else, so
//     a status code never tells a teacher that an admin API exists.
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
import { access_grants, assessments } from "../db/schema";
import { SESSION_COOKIE_NAME } from "../lib/auth/session";
import * as sessionMod from "../lib/auth/session";

const OWNER = { sub: "grant-api-owner", email: "lead@psd401.net" };
const OTHER = { sub: "grant-api-other", email: "other@psd401.net" };
const ADMIN = { sub: "grant-api-admin", email: "sysadmin@psd401.net" };
const CO_EMAIL = "coteacher@psd401.net";

let current: { sub: string; email: string } | null = null;

mock.module("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({
    get: (name: string) =>
      current && name === SESSION_COOKIE_NAME ? { value: "x" } : undefined,
  }),
}));

mock.module("../lib/auth/session", () => ({
  ...sessionMod,
  readSessionFromCookies: async () =>
    current ? { sub: current.sub, role: "staff", email: current.email } : null,
}));

function asUser(user: typeof OWNER | null) {
  current = user;
}

const UUID = "11111111-1111-4111-8111-111111111111";

beforeAll(() => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("secure_test_design_tool_test")) {
    throw new Error(`grants-api tests require the test DB; got: ${url}`);
  }
  process.env.DESIGN_TOOL_SESSION_SECRET = "test-session-secret-do-not-use";
});

afterEach(async () => {
  const db = getDb();
  await db.execute(sql`truncate table access_grants restart identity cascade`);
  await db.execute(sql`truncate table assessments restart identity cascade`);
  delete process.env.ADMIN_EMAILS;
  asUser(null);
});

afterAll(async () => {
  await closeDb();
});

async function makeAssessment(owner = OWNER) {
  const [row] = await getDb()
    .insert(assessments)
    .values({
      owner_sub: owner.sub,
      owner_email: owner.email,
      name: "Grants API fixture",
    })
    .returning();
  return row!;
}

function ctx<T extends Record<string, string>>(params: T) {
  return { params: Promise.resolve(params) };
}

async function assessmentGrantsRoute() {
  return import("../app/api/assessments/[id]/grants/route");
}
async function assessmentGrantRoute() {
  return import("../app/api/assessments/[id]/grants/[grantId]/route");
}
async function adminGrantsRoute() {
  return import("../app/api/grants/route");
}

function post(url: string, body: unknown) {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/assessments/[id]/grants", () => {
  test("the owner can grant edit to a colleague", async () => {
    const a = await makeAssessment();
    asUser(OWNER);
    const { POST } = await assessmentGrantsRoute();
    const res = await POST(
      post(`http://localhost/api/assessments/${a.id}/grants`, {
        grantee_email: ` ${CO_EMAIL.toUpperCase()} `,
        level: "edit",
        note: "co-teacher",
      }),
      ctx({ id: a.id }),
    );
    expect(res.status).toBe(201);
    const payload = (await res.json()) as { grant: Record<string, unknown> };
    expect(payload.grant.grantee_email).toBe(CO_EMAIL);
    expect(payload.grant.scope_kind).toBe("assessment");
    expect(payload.grant.scope_id).toBe(a.id);
    expect(payload.grant.level).toBe("edit");
    expect(payload.grant.granted_by_email).toBe(OWNER.email);
  });

  test("a second live grant on the same colleague is 409 already_granted", async () => {
    const a = await makeAssessment();
    asUser(OWNER);
    const { POST } = await assessmentGrantsRoute();
    const body = { grantee_email: CO_EMAIL, level: "edit" };
    expect(
      (await POST(post(`http://localhost/x`, body), ctx({ id: a.id }))).status,
    ).toBe(201);
    const again = await POST(post(`http://localhost/x`, body), ctx({ id: a.id }));
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ ok: false, error: "already_granted" });
  });

  test("a student address, an outside address and yourself are all 400", async () => {
    const a = await makeAssessment();
    asUser(OWNER);
    const { POST } = await assessmentGrantsRoute();
    const cases: [unknown, string][] = [
      [{ grantee_email: "kid@edtools.psd401.net", level: "edit" }, "grantee_not_staff"],
      [{ grantee_email: "someone@example.com", level: "edit" }, "grantee_not_staff"],
      [{ grantee_email: OWNER.email, level: "edit" }, "self_grant"],
      // `own` can share, archive, delete and grant again — admin-only (D-2).
      [{ grantee_email: CO_EMAIL, level: "own" }, "level_not_allowed"],
    ];
    for (const [body, error] of cases) {
      const res = await POST(post("http://localhost/x", body), ctx({ id: a.id }));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ ok: false, error });
    }
    expect(await getDb().select().from(access_grants)).toEqual([]);
  });

  test("an admin may grant own", async () => {
    process.env.ADMIN_EMAILS = ADMIN.email;
    const a = await makeAssessment(ADMIN);
    asUser(ADMIN);
    const { POST } = await assessmentGrantsRoute();
    const res = await POST(
      post("http://localhost/x", { grantee_email: CO_EMAIL, level: "own" }),
      ctx({ id: a.id }),
    );
    expect(res.status).toBe(201);
  });

  test("a colleague with an edit grant cannot grant further, and gets the same 404 as a stranger", async () => {
    const a = await makeAssessment();
    asUser(OWNER);
    const { POST, GET } = await assessmentGrantsRoute();
    await POST(
      post("http://localhost/x", { grantee_email: OTHER.email, level: "edit" }),
      ctx({ id: a.id }),
    );

    // The co-teacher may edit the assessment but grants are `own`.
    asUser(OTHER);
    const refused = await POST(
      post("http://localhost/x", { grantee_email: CO_EMAIL, level: "view" }),
      ctx({ id: a.id }),
    );
    expect(refused.status).toBe(404);
    expect(await refused.json()).toEqual({ ok: false, error: "not_found" });
    expect((await GET(new Request("http://localhost/x"), ctx({ id: a.id }))).status).toBe(
      404,
    );
  });

  test("an unknown assessment is the same 404, and a malformed id is 400", async () => {
    asUser(OWNER);
    const { POST } = await assessmentGrantsRoute();
    expect(
      (
        await POST(
          post("http://localhost/x", { grantee_email: CO_EMAIL, level: "edit" }),
          ctx({ id: UUID }),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await POST(
          post("http://localhost/x", { grantee_email: CO_EMAIL, level: "edit" }),
          ctx({ id: "nope" }),
        )
      ).status,
    ).toBe(400);
  });
});

describe("GET + DELETE /api/assessments/[id]/grants", () => {
  test("the owner lists live grants and revokes one", async () => {
    const a = await makeAssessment();
    asUser(OWNER);
    const { POST, GET } = await assessmentGrantsRoute();
    const created = (await (
      await POST(
        post("http://localhost/x", { grantee_email: CO_EMAIL, level: "edit" }),
        ctx({ id: a.id }),
      )
    ).json()) as { grant: { id: string } };

    const listed = (await (
      await GET(new Request("http://localhost/x"), ctx({ id: a.id }))
    ).json()) as { grants: unknown[] };
    expect(listed.grants).toHaveLength(1);

    const { DELETE } = await assessmentGrantRoute();
    const gone = await DELETE(
      new Request("http://localhost/x", { method: "DELETE" }),
      ctx({ id: a.id, grantId: created.grant.id }),
    );
    expect(gone.status).toBe(200);

    // Soft revoke: out of the live list, still in the table as the record.
    const after = (await (
      await GET(new Request("http://localhost/x"), ctx({ id: a.id }))
    ).json()) as { grants: unknown[] };
    expect(after.grants).toHaveLength(0);
    expect(await getDb().select().from(access_grants)).toHaveLength(1);

    // Revoking it again is the same 404 as a grant that never existed.
    const twice = await DELETE(
      new Request("http://localhost/x", { method: "DELETE" }),
      ctx({ id: a.id, grantId: created.grant.id }),
    );
    expect(twice.status).toBe(404);
  });

  test("a grant on ANOTHER assessment cannot be revoked through this one's id", async () => {
    const mine = await makeAssessment();
    const theirs = await makeAssessment(OTHER);
    asUser(OTHER);
    const { POST } = await assessmentGrantsRoute();
    const created = (await (
      await POST(
        post("http://localhost/x", { grantee_email: CO_EMAIL, level: "edit" }),
        ctx({ id: theirs.id }),
      )
    ).json()) as { grant: { id: string } };

    asUser(OWNER);
    const { DELETE } = await assessmentGrantRoute();
    const res = await DELETE(
      new Request("http://localhost/x", { method: "DELETE" }),
      ctx({ id: mine.id, grantId: created.grant.id }),
    );
    expect(res.status).toBe(404);
    const [still] = await getDb().select().from(access_grants);
    expect(still!.revoked_at).toBeNull();
  });
});

describe("/api/grants is the admin surface", () => {
  test("a non-admin teacher gets 404 on both methods, never 403", async () => {
    asUser(OWNER);
    const { GET, POST } = await adminGrantsRoute();
    const get = await GET(new Request("http://localhost/api/grants?grantee=x@psd401.net"));
    expect(get.status).toBe(404);
    expect(await get.json()).toEqual({ ok: false, error: "not_found" });
    const created = await POST(
      post("http://localhost/api/grants", {
        grantee_email: CO_EMAIL,
        scope_kind: "teacher",
        scope_id: OWNER.email,
        level: "run",
      }),
    );
    expect(created.status).toBe(404);
    expect(await getDb().select().from(access_grants)).toEqual([]);
  });

  test("an admin creates a teacher-scoped run grant and reads it back", async () => {
    process.env.ADMIN_EMAILS = `someone.else@psd401.net,${ADMIN.email}`;
    asUser(ADMIN);
    const { GET, POST } = await adminGrantsRoute();
    const ends = new Date(Date.now() + 86_400_000).toISOString();
    const res = await POST(
      post("http://localhost/api/grants", {
        grantee_email: CO_EMAIL,
        scope_kind: "teacher",
        scope_id: ` ${OWNER.email!.toUpperCase()} `,
        level: "run",
        ends_at: ends,
        note: "sub for tomorrow",
      }),
    );
    expect(res.status).toBe(201);
    const payload = (await res.json()) as { grant: Record<string, unknown> };
    // The teacher scope is normalised on the way in, or resolution would miss it.
    expect(payload.grant.scope_id).toBe(OWNER.email);
    expect(payload.grant.level).toBe("run");

    const byGrantee = (await (
      await GET(new Request(`http://localhost/api/grants?grantee=${CO_EMAIL}`))
    ).json()) as { grants: unknown[] };
    expect(byGrantee.grants).toHaveLength(1);

    const byScope = (await (
      await GET(
        new Request(
          `http://localhost/api/grants?scope_kind=teacher&scope_id=${OWNER.email}`,
        ),
      )
    ).json()) as { grants: unknown[] };
    expect(byScope.grants).toHaveLength(1);
  });

  test("an admin GET with no query is 400 rather than the whole district", async () => {
    process.env.ADMIN_EMAILS = ADMIN.email;
    asUser(ADMIN);
    const { GET } = await adminGrantsRoute();
    const res = await GET(new Request("http://localhost/api/grants"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: "query_required" });
  });

  test("a school-scoped grant is accepted and stored — and still confers nothing (D-7)", async () => {
    process.env.ADMIN_EMAILS = ADMIN.email;
    const a = await makeAssessment();
    asUser(ADMIN);
    const { POST } = await adminGrantsRoute();
    expect(
      (
        await POST(
          post("http://localhost/api/grants", {
            grantee_email: CO_EMAIL,
            scope_kind: "school",
            scope_id: "1000",
            level: "view",
          }),
        )
      ).status,
    ).toBe(201);

    const { authorizeAssessment } = await import("../lib/api/access");
    const access = await authorizeAssessment(
      getDb(),
      { sub: "co", role: "staff", email: CO_EMAIL } as sessionMod.SessionPayload,
      a.id,
      "view",
    );
    expect(access.ok).toBe(false);
  });

  test("an unauthenticated caller is 401 on both surfaces", async () => {
    asUser(null);
    const { GET } = await adminGrantsRoute();
    expect((await GET(new Request("http://localhost/api/grants"))).status).toBe(401);
    const { GET: assessmentGet } = await assessmentGrantsRoute();
    expect(
      (await assessmentGet(new Request("http://localhost/x"), ctx({ id: UUID }))).status,
    ).toBe(401);
  });
});

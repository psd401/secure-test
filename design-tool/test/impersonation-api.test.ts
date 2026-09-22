// Access slice 5 (docs/access-model-design.md, D-8): act-as, end to end.
//
// Three things this file is really guarding:
//
//   1. **The refusals are all 404.** Non-admin, already-impersonating, not
//      staff, yourself, and a stop with nothing to stop all answer the same
//      way the grants API does (D-3) — a status code never tells a caller that
//      an impersonation API exists and that they may not use it.
//   2. **Act-as narrows, never widens.** The minted session IS the target:
//      `authorize*` resolves it through "owner" on the target's own rows and
//      404s on a third teacher's, because `isAdmin` is false while `actor_sub`
//      is set.
//   3. **Every start and stop leaves an audit row**, which is the only record
//      that separates the admin from the teacher — D-8 deliberately leaves
//      every feature table recording the TARGET.
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { desc, sql } from "drizzle-orm";
import { closeDb, getDb } from "../db/client";
import { assessments, impersonation_sessions, test_sessions } from "../db/schema";
import {
  SESSION_COOKIE_NAME,
  verifySessionJWT,
  type SessionPayload,
} from "../lib/auth/session";
import * as sessionMod from "../lib/auth/session";
import { authorizeAssessment } from "../lib/api/access";

const ADMIN = { sub: "imp-admin", email: "sysadmin@psd401.net" };
const TEACHER = { sub: "imp-teacher", email: "lead@psd401.net" };
const OTHER = { sub: "imp-other", email: "other@psd401.net" };

let current: Partial<SessionPayload> | null = null;

mock.module("next/headers", () => ({
  headers: async () => new Headers({ "x-request-id": "req-imp-1" }),
  cookies: async () => ({
    get: (name: string) =>
      current && name === SESSION_COOKIE_NAME ? { value: "x" } : undefined,
  }),
}));

mock.module("../lib/auth/session", () => ({
  ...sessionMod,
  readSessionFromCookies: async () =>
    current ? { role: "staff", ...current } : null,
}));

function asUser(user: Partial<SessionPayload> | null) {
  current = user;
}

const { POST: impersonate } = await import("../app/api/admin/impersonate/route");
const { POST: stop } = await import("../app/api/admin/impersonate/stop/route");

function startRequest(body: unknown): Request {
  return new Request("http://localhost/api/admin/impersonate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function stopRequest(): Request {
  return new Request("http://localhost/api/admin/impersonate/stop", {
    method: "POST",
  });
}

/** The session cookie a response set, decoded. */
async function cookiePayload(res: Response): Promise<SessionPayload | null> {
  const raw = res.headers.getSetCookie?.() ?? [];
  const line = raw.find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`));
  if (!line) return null;
  const value = line.slice(SESSION_COOKIE_NAME.length + 1).split(";")[0]!;
  return verifySessionJWT(decodeURIComponent(value));
}

beforeAll(() => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("secure_test_design_tool_test")) {
    throw new Error(`impersonation tests require the test DB; got: ${url}`);
  }
  process.env.DESIGN_TOOL_SESSION_SECRET = "test-session-secret-do-not-use";
});

afterEach(async () => {
  const db = getDb();
  await db.execute(sql`truncate table impersonation_sessions restart identity cascade`);
  await db.execute(sql`truncate table assessments restart identity cascade`);
  delete process.env.ADMIN_EMAILS;
  asUser(null);
});

afterAll(async () => {
  await closeDb();
});

async function makeAssessment(
  owner: { sub: string; email: string },
  name = "Impersonation fixture",
) {
  const [row] = await getDb()
    .insert(assessments)
    .values({ owner_sub: owner.sub, owner_email: owner.email, name })
    .returning();
  return row!;
}

async function auditRows() {
  return getDb()
    .select()
    .from(impersonation_sessions)
    .orderBy(desc(impersonation_sessions.started_at));
}

describe("POST /api/admin/impersonate", () => {
  test("an admin acts as a teacher who owns an assessment", async () => {
    process.env.ADMIN_EMAILS = ADMIN.email;
    await makeAssessment(TEACHER);
    asUser(ADMIN);

    const res = await impersonate(startRequest({ email: TEACHER.email }));
    expect(res.status).toBe(200);

    const payload = await cookiePayload(res);
    expect(payload?.sub).toBe(TEACHER.sub);
    expect(payload?.email).toBe(TEACHER.email);
    expect(payload?.role).toBe("staff");
    expect(payload?.actor_sub).toBe(ADMIN.sub);
    expect(payload?.actor_email).toBe(ADMIN.email);

    const rows = await auditRows();
    expect(rows.length).toBe(1);
    expect(rows[0]!.actor_sub).toBe(ADMIN.sub);
    expect(rows[0]!.actor_email).toBe(ADMIN.email);
    expect(rows[0]!.target_sub).toBe(TEACHER.sub);
    expect(rows[0]!.target_email).toBe(TEACHER.email);
    expect(rows[0]!.stopped_at).toBeNull();
    expect(rows[0]!.request_id).toBe("req-imp-1");
  });

  test("the address is matched case-insensitively", async () => {
    process.env.ADMIN_EMAILS = ADMIN.email;
    await makeAssessment(TEACHER);
    asUser(ADMIN);
    const res = await impersonate(
      startRequest({ email: `  ${TEACHER.email.toUpperCase()} ` }),
    );
    expect(res.status).toBe(200);
    expect((await cookiePayload(res))?.sub).toBe(TEACHER.sub);
  });

  test("a teacher with only a SITTING resolves through it", async () => {
    process.env.ADMIN_EMAILS = ADMIN.email;
    // An assessment owned by somebody else, with the target only ever having
    // run a sitting on their own copy: the 0038 backfill gap the design note
    // records, and the reason the fallback exists.
    const other = await makeAssessment(OTHER);
    await getDb().insert(test_sessions).values({
      assessment_id: other.id,
      owner_sub: TEACHER.sub,
      owner_email: TEACHER.email,
      code: "IMPSIT",
      expires_at: new Date(Date.now() + 3_600_000),
    });
    asUser(ADMIN);
    const res = await impersonate(startRequest({ email: TEACHER.email }));
    expect(res.status).toBe(200);
    expect((await cookiePayload(res))?.sub).toBe(TEACHER.sub);
  });

  test("a non-admin gets 404, not 403, and writes no row", async () => {
    await makeAssessment(TEACHER);
    asUser(OTHER);
    const res = await impersonate(startRequest({ email: TEACHER.email }));
    expect(res.status).toBe(404);
    expect(await cookiePayload(res)).toBeNull();
    expect((await auditRows()).length).toBe(0);
  });

  test("an already-impersonated session cannot chain a second act-as", async () => {
    process.env.ADMIN_EMAILS = ADMIN.email;
    await makeAssessment(OTHER);
    // The session is the teacher, with the admin as actor — exactly what the
    // first impersonation minted. `isAdmin` is false for it, so the route's
    // own gate refuses.
    asUser({ ...TEACHER, actor_sub: ADMIN.sub, actor_email: ADMIN.email });
    const res = await impersonate(startRequest({ email: OTHER.email }));
    expect(res.status).toBe(404);
    expect((await auditRows()).length).toBe(0);
  });

  test("a staff address with no rows at all → 404 no_account_rows", async () => {
    process.env.ADMIN_EMAILS = ADMIN.email;
    asUser(ADMIN);
    const res = await impersonate(startRequest({ email: TEACHER.email }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ ok: false, error: "no_account_rows" });
  });

  test("acting as yourself is refused", async () => {
    process.env.ADMIN_EMAILS = ADMIN.email;
    await makeAssessment(ADMIN);
    asUser(ADMIN);
    const res = await impersonate(startRequest({ email: ADMIN.email }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ ok: false, error: "self" });
  });

  test("a non-staff address is refused before any lookup", async () => {
    process.env.ADMIN_EMAILS = ADMIN.email;
    asUser(ADMIN);
    for (const email of [
      "student@edtools.psd401.net",
      "someone@example.com",
      "not-an-address",
    ]) {
      const res = await impersonate(startRequest({ email }));
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ ok: false, error: "not_staff" });
    }
  });

  test("a missing or non-string email is a 400", async () => {
    process.env.ADMIN_EMAILS = ADMIN.email;
    asUser(ADMIN);
    const res = await impersonate(startRequest({}));
    expect(res.status).toBe(400);
    const notJson = await impersonate(
      new Request("http://localhost/api/admin/impersonate", { method: "POST" }),
    );
    expect(notJson.status).toBe(400);
  });

  test("no session at all is a 401 (the role gate, not the admin gate)", async () => {
    asUser(null);
    const res = await impersonate(startRequest({ email: TEACHER.email }));
    expect(res.status).toBe(401);
  });
});

describe("POST /api/admin/impersonate/stop", () => {
  test("restores the admin's own session and closes the audit row", async () => {
    process.env.ADMIN_EMAILS = ADMIN.email;
    await makeAssessment(TEACHER);
    asUser(ADMIN);
    await impersonate(startRequest({ email: TEACHER.email }));

    asUser({ ...TEACHER, actor_sub: ADMIN.sub, actor_email: ADMIN.email });
    const res = await stop(stopRequest());
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain("/dashboard");

    const payload = await cookiePayload(res);
    expect(payload?.sub).toBe(ADMIN.sub);
    expect(payload?.email).toBe(ADMIN.email);
    expect(payload?.role).toBe("staff");
    expect(payload?.actor_sub).toBeUndefined();
    expect(payload?.actor_email).toBeUndefined();

    const rows = await auditRows();
    expect(rows.length).toBe(1);
    expect(rows[0]!.stopped_at).not.toBeNull();
    // The START's request id is kept — that is the one a log line has to be
    // lined up with.
    expect(rows[0]!.request_id).toBe("req-imp-1");
  });

  test("a session with no actor has nothing to stop → 404", async () => {
    asUser(TEACHER);
    expect((await stop(stopRequest())).status).toBe(404);
    process.env.ADMIN_EMAILS = ADMIN.email;
    asUser(ADMIN);
    expect((await stop(stopRequest())).status).toBe(404);
  });

  test("stopping with no open audit row still restores the session", async () => {
    // A row can be missing (an 8 h cookie outliving a truncated table, a
    // manually minted session): handing the admin their identity back must
    // not depend on the audit trail.
    asUser({ ...TEACHER, actor_sub: ADMIN.sub, actor_email: ADMIN.email });
    const res = await stop(stopRequest());
    expect(res.status).toBe(303);
    expect((await cookiePayload(res))?.sub).toBe(ADMIN.sub);
  });

  test("only the newest open row for the pair is closed", async () => {
    process.env.ADMIN_EMAILS = ADMIN.email;
    await makeAssessment(TEACHER);
    asUser(ADMIN);
    await impersonate(startRequest({ email: TEACHER.email }));
    await new Promise((r) => setTimeout(r, 5));
    await impersonate(startRequest({ email: TEACHER.email }));

    asUser({ ...TEACHER, actor_sub: ADMIN.sub, actor_email: ADMIN.email });
    await stop(stopRequest());

    const rows = await auditRows();
    expect(rows.length).toBe(2);
    expect(rows[0]!.stopped_at).not.toBeNull();
    expect(rows[1]!.stopped_at).toBeNull();
  });
});

describe("an impersonated session resolves as the target, not as an admin", () => {
  test("owner on the target's assessment, 404 on a third teacher's", async () => {
    process.env.ADMIN_EMAILS = ADMIN.email;
    const theirs = await makeAssessment(TEACHER, "The target's own");
    const foreign = await makeAssessment(OTHER, "Somebody else's");
    const acting = {
      sub: TEACHER.sub,
      role: "staff",
      email: TEACHER.email,
      actor_sub: ADMIN.sub,
      actor_email: ADMIN.email,
    } as SessionPayload;

    const own = await authorizeAssessment(getDb(), acting, theirs.id, "own");
    expect(own.ok).toBe(true);
    if (own.ok) expect(own.via).toBe("owner");

    // The admin's own session would resolve this one via "admin"; the act-as
    // session must not.
    const denied = await authorizeAssessment(getDb(), acting, foreign.id, "view");
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.response.status).toBe(404);
  });
});

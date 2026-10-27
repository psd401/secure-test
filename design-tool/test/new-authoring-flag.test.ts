// R-12 (docs/editor-redesign-design.md): the one flag for the new authoring
// experience. Default off; a staff member opts in for their own account only;
// an act-as session reads but cannot change it.
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { sql } from "drizzle-orm";
import { closeDb, getDb } from "../db/client";
import { SESSION_COOKIE_NAME } from "../lib/auth/session";
import * as headersMod from "next/headers";
import * as sessionMod from "../lib/auth/session";
import {
  NEW_AUTHORING_DEFAULT,
  isNewAuthoringEnabled,
  setNewAuthoring,
} from "../lib/authoring/flag";
import { staffPrincipal, studentPrincipal, type TestPrincipal } from "./helpers/roster";

const expectTestDb = () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("secure_test_design_tool_test")) {
    throw new Error(`new-authoring flag tests require the test DB; got: ${url}`);
  }
};

let principal: TestPrincipal | null = null;

mock.module("next/headers", () => ({
  ...headersMod,
  headers: async () => new Headers(),
  cookies: async () => ({
    get: (name: string) =>
      principal && name === SESSION_COOKIE_NAME ? { value: "x" } : undefined,
  }),
}));

mock.module("../lib/auth/session", () => ({
  ...sessionMod,
  readSessionFromCookies: async () => principal,
}));

const TEACHER = staffPrincipal("flag-teacher-1", "teacher-one@example.test");
const OTHER = staffPrincipal("flag-teacher-2", "teacher-two@example.test");
const ACTING_AS: TestPrincipal = {
  ...TEACHER,
  actor_sub: "flag-admin-1",
  actor_email: "admin@example.test",
};

beforeAll(() => {
  expectTestDb();
});

afterEach(async () => {
  principal = null;
  await getDb().execute(sql`truncate table staff_preferences`);
});

afterAll(async () => {
  await closeDb();
});

async function route() {
  return import("../app/api/me/preferences/route");
}

function jsonPost(body: unknown) {
  return new Request("http://localhost/api/me/preferences", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function formPost(value: string) {
  return new Request("http://localhost/api/me/preferences", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `new_authoring=${encodeURIComponent(value)}`,
  });
}

describe("isNewAuthoringEnabled", () => {
  test("defaults off, with no row written", async () => {
    expect(NEW_AUTHORING_DEFAULT).toBe(false);
    expect(await isNewAuthoringEnabled(getDb(), TEACHER)).toBe(false);
    const rows = await getDb().execute(sql`select count(*)::int as n from staff_preferences`);
    expect((rows as unknown as Array<{ n: number }>)[0]?.n).toBe(0);
  });

  test("no session or no sub is off", async () => {
    expect(await isNewAuthoringEnabled(getDb(), null)).toBe(false);
    expect(await isNewAuthoringEnabled(getDb(), { sub: "" })).toBe(false);
  });

  test("opt-in is per staff member and reversible", async () => {
    expect(await setNewAuthoring(getDb(), TEACHER, true)).toEqual({ ok: true, enabled: true });
    expect(await isNewAuthoringEnabled(getDb(), TEACHER)).toBe(true);
    expect(await isNewAuthoringEnabled(getDb(), OTHER)).toBe(false);

    expect(await setNewAuthoring(getDb(), TEACHER, false)).toEqual({ ok: true, enabled: false });
    expect(await isNewAuthoringEnabled(getDb(), TEACHER)).toBe(false);
  });

  test("an act-as session reads the target's choice but cannot change it", async () => {
    await setNewAuthoring(getDb(), TEACHER, true);
    expect(await isNewAuthoringEnabled(getDb(), ACTING_AS)).toBe(true);
    expect(await setNewAuthoring(getDb(), ACTING_AS, false)).toEqual({
      ok: false,
      reason: "impersonating",
    });
    expect(await isNewAuthoringEnabled(getDb(), TEACHER)).toBe(true);
  });
});

describe("/api/me/preferences", () => {
  test("401 without a session, 403 for a student", async () => {
    const { GET, POST } = await route();
    expect((await GET()).status).toBe(401);
    expect((await POST(jsonPost({ new_authoring: true }))).status).toBe(401);

    principal = studentPrincipal("student-flag@example.test");
    expect((await GET()).status).toBe(403);
    expect((await POST(jsonPost({ new_authoring: true }))).status).toBe(403);
  });

  test("GET reports off, JSON POST turns it on, GET then reports on", async () => {
    principal = TEACHER;
    const { GET, POST } = await route();
    expect(await (await GET()).json()).toEqual({ new_authoring: false });

    const res = await POST(jsonPost({ new_authoring: true }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, new_authoring: true });
    expect(await (await GET()).json()).toEqual({ new_authoring: true });
  });

  test("form POST flips it and redirects 303 to the beta page", async () => {
    principal = TEACHER;
    const { POST } = await route();
    const on = await POST(formPost("on"));
    expect(on.status).toBe(303);
    expect(new URL(on.headers.get("location")!).pathname).toBe("/dashboard/beta");
    expect(await isNewAuthoringEnabled(getDb(), TEACHER)).toBe(true);

    const off = await POST(formPost("off"));
    expect(off.status).toBe(303);
    expect(await isNewAuthoringEnabled(getDb(), TEACHER)).toBe(false);
  });

  test("400 on a malformed body, and nothing is written", async () => {
    principal = TEACHER;
    const { POST } = await route();
    expect((await POST(jsonPost({ new_authoring: "yes" }))).status).toBe(400);
    expect((await POST(jsonPost({ new_authoring: true, extra: 1 }))).status).toBe(400);
    expect((await POST(formPost("true"))).status).toBe(400);
    expect(
      (
        await POST(
          new Request("http://localhost/api/me/preferences", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{not json",
          }),
        )
      ).status,
    ).toBe(400);
    expect(await isNewAuthoringEnabled(getDb(), TEACHER)).toBe(false);
  });

  test("403 while acting as a teacher, and the teacher's choice stands", async () => {
    principal = ACTING_AS;
    const { GET, POST } = await route();
    const res = await POST(jsonPost({ new_authoring: true }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, error: "impersonating" });
    expect(await (await GET()).json()).toEqual({ new_authoring: false });
  });
});

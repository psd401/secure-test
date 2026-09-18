// GET /api/assessments/[id]/grants/suggestions (docs/access-model-design.md,
// D-4 (b)), access slice 3 — the route in front of `coTeachersOf`
// (test/co-teachers.test.ts covers the query itself).
//
// `own`, same as the grants surface beside it: 404 for anyone but the owner
// or an admin, never 403 (D-3).
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { sql } from "drizzle-orm";
import { closeDb, getDb } from "../db/client";
import { assessments } from "../db/schema";
import { SESSION_COOKIE_NAME } from "../lib/auth/session";
import * as sessionMod from "../lib/auth/session";
import { loadExtract, replaceFile } from "./fixtures/roster/load";
import { importSnapshot } from "../lib/roster/importSnapshot";
import { clearRoster, TEACHER_EMAIL } from "./helpers/roster";

const expectTestDb = () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("secure_test_design_tool_test")) {
    throw new Error(`grants-suggestions-route tests require the test DB; got: ${url}`);
  }
};

// teacher.five is a CURRENT Co-Teacher of TEACHER_EMAIL on 5001 — the fixture
// used is the same shape as test/co-teachers.test.ts's, trimmed to the one row
// this file needs.
const SECTION_TEACHERS_CSV = `section_ps_id,teacher_ps_id,teacher_email,role_name,priority_order,start_date,end_date
5001,301,Teacher.One@psd401.net,Lead Teacher,1,2020-09-01,2099-06-30
5001,305,teacher.five@psd401.net,Co-Teacher,3,2020-09-01,2099-06-30
5002,302,teacher.two@psd401.net,Lead Teacher,1,2020-09-01,2099-06-30
5003,301,teacher.one@psd401.net,Lead Teacher,1,2020-09-01,2099-06-30
5004,304,teacher.four@psd401.net,Lead Teacher,1,2020-09-01,2099-06-30
`;

const OWNER = { sub: "sugg-owner", email: TEACHER_EMAIL };
const OTHER = { sub: "sugg-other", email: "other@psd401.net" };
const ADMIN = { sub: "sugg-admin", email: "sysadmin@psd401.net" };

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

async function route() {
  return import("../app/api/assessments/[id]/grants/suggestions/route");
}

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function makeAssessment(owner = OWNER) {
  const [row] = await getDb()
    .insert(assessments)
    .values({ owner_sub: owner.sub, owner_email: owner.email, name: "Suggestions fixture" })
    .returning();
  return row!;
}

beforeAll(async () => {
  expectTestDb();
  process.env.DESIGN_TOOL_SESSION_SECRET = "test-session-secret-do-not-use";
  const extract = replaceFile(await loadExtract(), "section_teachers", SECTION_TEACHERS_CSV);
  const result = await importSnapshot(getDb(), { manifest: extract.manifest, readFile: extract.readFile });
  if (!result.ok) throw new Error(`roster fixture refused: ${result.reason}`);
});

afterEach(async () => {
  await getDb().execute(sql`truncate table assessments restart identity cascade`);
  asUser(null);
});

afterAll(async () => {
  await clearRoster();
  await closeDb();
});

describe("GET /api/assessments/[id]/grants/suggestions", () => {
  test("the owner sees their roster co-teacher", async () => {
    const a = await makeAssessment();
    asUser(OWNER);
    const { GET } = await route();
    const res = await GET(new Request(`http://localhost/x`), ctx(a.id));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { suggestions: { email: string }[] };
    expect(body.suggestions.map((s) => s.email)).toEqual(["teacher.five@psd401.net"]);
  });

  test("an admin sees the OWNER's co-teacher, not their own", async () => {
    process.env.ADMIN_EMAILS = ADMIN.email;
    const a = await makeAssessment();
    asUser(ADMIN);
    const { GET } = await route();
    const res = await GET(new Request(`http://localhost/x`), ctx(a.id));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { suggestions: { email: string }[] };
    expect(body.suggestions.map((s) => s.email)).toEqual(["teacher.five@psd401.net"]);
    delete process.env.ADMIN_EMAILS;
  });

  test("a colleague with no access gets 404, not 403", async () => {
    const a = await makeAssessment();
    asUser(OTHER);
    const { GET } = await route();
    const res = await GET(new Request(`http://localhost/x`), ctx(a.id));
    expect(res.status).toBe(404);
  });

  test("an unauthenticated caller is 401", async () => {
    const a = await makeAssessment();
    asUser(null);
    const { GET } = await route();
    const res = await GET(new Request(`http://localhost/x`), ctx(a.id));
    expect(res.status).toBe(401);
  });

  test("a malformed id is 400", async () => {
    asUser(OWNER);
    const { GET } = await route();
    const res = await GET(new Request(`http://localhost/x`), ctx("not-a-uuid"));
    expect(res.status).toBe(400);
  });

  test("an assessment with no owner_email yields no suggestions rather than throwing", async () => {
    const [row] = await getDb()
      .insert(assessments)
      .values({ owner_sub: OWNER.sub, owner_email: null, name: "No owner_email" })
      .returning();
    asUser(OWNER);
    const { GET } = await route();
    const res = await GET(new Request(`http://localhost/x`), ctx(row!.id));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ suggestions: [] });
  });
});

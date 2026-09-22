// Co-teacher tenant fix (2026-09-22, docs/access-model-design.md §Progress):
// a student who joins a CO-TEACHER's class sitting (access D-5 — the sitting's
// owner fields are the co-teacher's) gets an overlay row under the ASSESSMENT
// owner, so the join, the bundle, every per-attempt route, the co-teacher's
// Monitor, "Your tests" and the owner's results all resolve the same row.
// Before the fix the join filed the row under the co-teacher and the delivery
// route (which resolves under `assessments.owner_sub`) answered 404.
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { closeDb, getDb } from "../db/client";
import {
  access_grants,
  assessments,
  items,
  students,
  type AttemptRow,
  type TestSessionRow,
} from "../db/schema";
import { SESSION_COOKIE_NAME } from "../lib/auth/session";
import * as sessionMod from "../lib/auth/session";
import { buildResults } from "../lib/scoring/results";
import {
  BIOLOGY_STUDENT,
  OTHER_TEACHER_EMAIL,
  TEACHER_EMAIL,
  clearRoster,
  seedRoster,
  staffPrincipal,
  studentPrincipal,
  type TestPrincipal,
} from "./helpers/roster";

const expectTestDb = () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("secure_test_design_tool_test")) {
    throw new Error(`co-teacher-tenant tests require the test DB; got: ${url}`);
  }
};

// A owns the assessment and teaches 5001 / 5003; B co-teaches it and teaches
// 5002, where the Biology student is enrolled — A does not teach them.
const OWNER = "co-tenant-owner";
const CO_TEACHER = "co-tenant-coteacher";
let principal: TestPrincipal | null = null;

mock.module("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({
    get: (name: string) =>
      principal && name === SESSION_COOKIE_NAME ? { value: "x" } : undefined,
  }),
}));

mock.module("../lib/auth/session", () => ({
  ...sessionMod,
  readSessionFromCookies: async () => principal,
  readStaffSessionFromCookies: async () =>
    principal && principal.role === "staff" ? principal : null,
}));

async function call(
  modPath: string,
  method: string,
  url: string,
  params: Record<string, string> = {},
  body?: unknown,
): Promise<Response> {
  const mod = (await import(modPath)) as Record<string, Function>;
  return (await mod[method]!(
    new Request(`http://localhost${url}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    { params: Promise.resolve(params) },
  )) as Response;
}

beforeAll(async () => {
  expectTestDb();
  await seedRoster();
});

afterEach(async () => {
  const db = getDb();
  await db.execute(sql`truncate table assessments restart identity cascade`);
  await db.execute(sql`truncate table students restart identity cascade`);
  await db.execute(sql`truncate table access_grants restart identity cascade`);
});

afterAll(async () => {
  await clearRoster();
  await closeDb();
});

describe("a student in a co-teacher's class sitting (co-teacher tenant fix)", () => {
  test("redeem → join → delivery → answer → hand in; the overlay is the owner's; Monitor and results name the student", async () => {
    const db = getDb();
    const [assessment] = await db
      .insert(assessments)
      .values({ owner_sub: OWNER, owner_email: TEACHER_EMAIL, name: "Co-taught", status: "published" })
      .returning();
    const [item] = await db
      .insert(items)
      .values({
        assessment_id: assessment!.id,
        position: 0,
        type: "multiple_choice_single",
        stem: "Pick",
        choices: [
          { id: "a", text: "A" },
          { id: "b", text: "B" },
        ],
        correct_choice_ids: ["a"],
      })
      .returning();
    await db.insert(access_grants).values({
      grantee_email: OTHER_TEACHER_EMAIL,
      scope_kind: "assessment",
      scope_id: assessment!.id,
      level: "edit",
      note: "co-teacher",
      granted_by_sub: OWNER,
      granted_by_email: TEACHER_EMAIL,
    });

    // B starts a class sitting on B's own section; per D-5 it is B's.
    principal = staffPrincipal(CO_TEACHER, OTHER_TEACHER_EMAIL);
    const created = await call("../app/api/test-sessions/route", "POST", "/api/test-sessions", {}, {
      assessment_id: assessment!.id,
      section_ps_id: "5002",
    });
    expect(created.status).toBe(201);
    const sitting = ((await created.json()) as { test_session: TestSessionRow }).test_session;
    expect(sitting.owner_sub).toBe(CO_TEACHER);
    expect(sitting.owner_email).toBe(OTHER_TEACHER_EMAIL);

    principal = studentPrincipal(BIOLOGY_STUDENT.email);
    const redeemed = await call("../app/api/test-sessions/redeem/route", "POST", "/api/test-sessions/redeem", {}, {
      code: sitting.code,
    });
    expect(redeemed.status).toBe(200);

    const joined = await call("../app/api/attempts/route", "POST", "/api/attempts", {}, {
      test_session_id: sitting.id,
    });
    expect(joined.status).toBe(201);
    const { attempt } = (await joined.json()) as { attempt: AttemptRow };

    // The overlay row the attempt hangs off is the ASSESSMENT owner's.
    const [overlay] = await db.select().from(students).where(eq(students.id, attempt.student_id));
    expect(overlay!.owner_sub).toBe(OWNER);
    expect(overlay!.roster_ps_id).toBe(BIOLOGY_STUDENT.ps_id);
    expect(await db.select().from(students).where(eq(students.owner_sub, CO_TEACHER))).toHaveLength(0);

    const delivery = await call(
      "../app/api/assessments/[id]/delivery/route",
      "GET",
      `/api/assessments/${assessment!.id}/delivery`,
      { id: assessment!.id },
    );
    expect(delivery.status).toBe(200);

    const saved = await call(
      "../app/api/attempts/[attemptId]/responses/[itemId]/route",
      "PUT",
      `/api/attempts/${attempt.id}/responses/${item!.id}`,
      { attemptId: attempt.id, itemId: item!.id },
      { response: { type: "multiple_choice_single", choice_id: "a" } },
    );
    expect(saved.status).toBe(200);

    // "Your tests" carries the attempt on the co-teacher's sitting.
    const mine = (await (await call("../app/api/me/sittings/route", "GET", "/api/me/sittings")).json()) as {
      sittings: { test_session_id: string; attempt: { id: string; status: string } | null }[];
    };
    expect(mine.sittings.find((s) => s.test_session_id === sitting.id)?.attempt).toMatchObject({
      id: attempt.id,
      status: "in_progress",
    });

    // B's Monitor: in progress.
    const attendance = async () => {
      principal = staffPrincipal(CO_TEACHER, OTHER_TEACHER_EMAIL);
      const { GET } = await import("../app/api/test-sessions/[sessionId]/attendance/route");
      const res = await GET(new Request("http://localhost/x"), { params: Promise.resolve({ sessionId: sitting.id }) });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { rows: { ps_id: string; status: string; attempt_id: string | null }[] };
      return body.rows.find((r) => r.ps_id === BIOLOGY_STUDENT.ps_id);
    };
    expect(await attendance()).toMatchObject({ status: "in_progress", attempt_id: attempt.id });

    principal = studentPrincipal(BIOLOGY_STUDENT.email);
    const submitted = await call(
      "../app/api/attempts/[attemptId]/submit/route",
      "POST",
      `/api/attempts/${attempt.id}/submit`,
      { attemptId: attempt.id },
    );
    expect(submitted.status).toBe(200);

    expect(await attendance()).toMatchObject({ status: "submitted", attempt_id: attempt.id });

    // Results (A5-4 reads the owner's overlay) name the student.
    const results = await buildResults(assessment!.id);
    expect(results.rows).toHaveLength(1);
    expect(results.rows[0]!.student.name).not.toBe("(unknown)");
    expect(results.rows[0]!.student.student_number).toBe(BIOLOGY_STUDENT.ps_id);
  });
});

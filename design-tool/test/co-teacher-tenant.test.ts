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
  roster_sections,
  student_accommodations,
  students,
  type AttemptRow,
  type TestSessionRow,
} from "../db/schema";
import { SESSION_COOKIE_NAME } from "../lib/auth/session";
import * as sessionMod from "../lib/auth/session";
import { sectionLabel, teacherRoster } from "../lib/roster/teacherRoster";
import { buildResults, sectionEnrolment, sectionFilterOptions } from "../lib/scoring/results";
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

  // Follow-up (6.2, 2026-09-22): the co-teacher recorded this child's
  // accommodations on THEIR overlay row; the owner's row the join creates has
  // none. Delivery falls back to the co-teacher's row — unless the owner's row
  // carries any live row at all, which is then the decision.
  test("delivery falls back to the co-teacher's accommodations when the owner's row has none", async () => {
    const db = getDb();
    const [assessment] = await db
      .insert(assessments)
      .values({
        owner_sub: OWNER,
        owner_email: TEACHER_EMAIL,
        name: "Co-taught, accommodated",
        status: "published",
        allowed_accommodations: ["spell_check"],
      })
      .returning();
    await db.insert(items).values({
      assessment_id: assessment!.id,
      position: 0,
      type: "multiple_choice_single",
      stem: "Pick",
      choices: [
        { id: "a", text: "A" },
        { id: "b", text: "B" },
      ],
      correct_choice_ids: ["a"],
    });
    await db.insert(access_grants).values({
      grantee_email: OTHER_TEACHER_EMAIL,
      scope_kind: "assessment",
      scope_id: assessment!.id,
      level: "edit",
      note: "co-teacher",
      granted_by_sub: OWNER,
      granted_by_email: TEACHER_EMAIL,
    });
    const [coRow] = await db
      .insert(students)
      .values({ owner_sub: CO_TEACHER, roster_ps_id: BIOLOGY_STUDENT.ps_id, name: "Co-teacher's row" })
      .returning();
    await db.insert(student_accommodations).values({
      student_id: coRow!.id,
      subject: "Science",
      tool_id: "spell_check",
      value: "On",
      source: "manual",
    });

    principal = staffPrincipal(CO_TEACHER, OTHER_TEACHER_EMAIL);
    const created = await call("../app/api/test-sessions/route", "POST", "/api/test-sessions", {}, {
      assessment_id: assessment!.id,
      section_ps_id: "5002",
    });
    const sitting = ((await created.json()) as { test_session: TestSessionRow }).test_session;

    principal = studentPrincipal(BIOLOGY_STUDENT.email);
    await call("../app/api/test-sessions/redeem/route", "POST", "/api/test-sessions/redeem", {}, {
      code: sitting.code,
    });
    const joined = await call("../app/api/attempts/route", "POST", "/api/attempts", {}, {
      test_session_id: sitting.id,
    });
    const { attempt } = (await joined.json()) as { attempt: AttemptRow };
    expect(attempt.student_id).not.toBe(coRow!.id);

    const deliver = async () =>
      (await (
        await call(
          "../app/api/assessments/[id]/delivery/route",
          "GET",
          `/api/assessments/${assessment!.id}/delivery`,
          { id: assessment!.id },
        )
      ).json()) as { accommodations?: Record<string, string> };

    expect((await deliver()).accommodations).toEqual({ spell_check: "On" });

    // The owner records a decision (Off) on their own row: that wins.
    await db.insert(student_accommodations).values({
      student_id: attempt.student_id,
      subject: "Science",
      tool_id: "spell_check",
      value: "Off",
      source: "manual",
    });
    expect((await deliver()).accommodations).toBeUndefined();
  });

  // Co-teacher follow-ups, 2026-09-22 (docs/access-model-design.md §Progress):
  // once the join files the student under the OWNER, the owner's surfaces must
  // still say where the student came from — the co-teacher's section on every
  // results reader, that section's enrolment in the work packet's "N of M",
  // and "co-taught" (not "not in your sections") on the owner's Students page.
  test("results, the work packet's enrolment and the owner's Students page carry the co-teacher's section", async () => {
    const db = getDb();
    const [assessment] = await db
      .insert(assessments)
      .values({ owner_sub: OWNER, owner_email: TEACHER_EMAIL, name: "Co-taught, sections", status: "published" })
      .returning();
    await db.insert(items).values({
      assessment_id: assessment!.id,
      position: 0,
      type: "multiple_choice_single",
      stem: "Pick",
      choices: [
        { id: "a", text: "A" },
        { id: "b", text: "B" },
      ],
      correct_choice_ids: ["a"],
    });
    await db.insert(access_grants).values({
      grantee_email: OTHER_TEACHER_EMAIL,
      scope_kind: "assessment",
      scope_id: assessment!.id,
      level: "edit",
      note: "co-teacher",
      granted_by_sub: OWNER,
      granted_by_email: TEACHER_EMAIL,
    });

    principal = staffPrincipal(CO_TEACHER, OTHER_TEACHER_EMAIL);
    const created = await call("../app/api/test-sessions/route", "POST", "/api/test-sessions", {}, {
      assessment_id: assessment!.id,
      section_ps_id: "5002",
    });
    expect(created.status).toBe(201);
    const sitting = ((await created.json()) as { test_session: TestSessionRow }).test_session;

    principal = studentPrincipal(BIOLOGY_STUDENT.email);
    await call("../app/api/test-sessions/redeem/route", "POST", "/api/test-sessions/redeem", {}, {
      code: sitting.code,
    });
    const joined = await call("../app/api/attempts/route", "POST", "/api/attempts", {}, {
      test_session_id: sitting.id,
    });
    const { attempt } = (await joined.json()) as { attempt: AttemptRow };
    const submitted = await call(
      "../app/api/attempts/[attemptId]/submit/route",
      "POST",
      `/api/attempts/${attempt.id}/submit`,
      { attemptId: attempt.id },
    );
    expect(submitted.status).toBe(200);

    const [biology] = await db.select().from(roster_sections).where(eq(roster_sections.ps_id, "5002"));
    const biologyLabel = sectionLabel(biology!);

    // The owner also opens a sitting on English 9 that nobody has joined yet.
    principal = staffPrincipal(OWNER, TEACHER_EMAIL);
    const ownSitting = await call("../app/api/test-sessions/route", "POST", "/api/test-sessions", {}, {
      assessment_id: assessment!.id,
      section_ps_id: "5003",
    });
    expect(ownSitting.status).toBe(201);
    const [english] = await db.select().from(roster_sections).where(eq(roster_sections.ps_id, "5003"));
    const englishLabel = sectionLabel(english!);

    // The section label comes from the co-teacher's sitting. (A regression
    // guard: `resolveSection` already read the sitting first, so this held
    // before the follow-up too.)
    const results = await buildResults(assessment!.id);
    expect(results.rows).toHaveLength(1);
    expect(results.rows[0]!.student.section).toBe(biologyLabel);

    // The filter offers every section a class sitting named — including one
    // with no rows yet — and filtering by the co-teacher's finds the student.
    const { labels } = sectionFilterOptions(results);
    expect(labels).toContain(biologyLabel);
    expect(labels).toContain(englishLabel);
    expect(results.rows.filter((r) => r.student.section === biologyLabel).map((r) => r.attempt_id)).toEqual([
      attempt.id,
    ]);

    // "N of M enrolled": the co-teacher's section counts its one student.
    expect(await sectionEnrolment(db, assessment!.id, biologyLabel)).toBe(1);

    // The owner's Students page: co-taught under the co-teacher's section,
    // not "not in your current sections"; the link still opens the row.
    const roster = await teacherRoster(db, OWNER, TEACHER_EMAIL);
    expect(roster.unlinked.map((o) => o.id)).not.toContain(attempt.student_id);
    expect(roster.coTaught).toHaveLength(1);
    expect(roster.coTaught[0]!.section?.ps_id).toBe("5002");
    expect(roster.coTaught[0]!.coTeacherEmail).toBe(OTHER_TEACHER_EMAIL);
    expect(roster.coTaught[0]!.students.map((o) => o.id)).toEqual([attempt.student_id]);
  });
});

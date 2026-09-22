// Practice sittings (docs/practice-sitting-design.md) slice 1, behaviour: a
// staff member creates a practice sitting, finds it in "Your tests", joins it
// through the STUDENT routes, and nobody else can — plus the Monitor's single
// row (D-5), Practice again (D-6) and the nightly sweep (D-7). The resolver's
// access decisions are in test/access-enforcement.test.ts; the invisibility
// guarantee is test/practice-invisibility.test.ts.
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { closeDb, getDb } from "../db/client";
import {
  assessments,
  attempt_deletions,
  attempts,
  items,
  students,
  test_sessions,
  type AttemptRow,
  type TestSessionRow,
} from "../db/schema";
import { SESSION_COOKIE_NAME } from "../lib/auth/session";
import * as sessionMod from "../lib/auth/session";
import { PRACTICE_ROW_NAME, attendanceForSitting } from "../lib/api/sittingAttendance";
import {
  PRACTICE_SWEEP_ACTOR,
  sweepPracticeSittings,
} from "../lib/retention/sweep";
import {
  STUDENT,
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
    throw new Error(`practice-sitting tests require the test DB; got: ${url}`);
  }
};

const OWNER = "practice-sitting-owner";
const COLLEAGUE = "practice-sitting-colleague";
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

const asOwner = () => {
  principal = staffPrincipal(OWNER, TEACHER_EMAIL);
};
const asColleague = () => {
  principal = staffPrincipal(COLLEAGUE, "colleague@psd401.net");
};

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

let assessmentId = "";
let itemId = "";

async function createSitting(body: Record<string, unknown>): Promise<Response> {
  return call("../app/api/test-sessions/route", "POST", "/api/test-sessions", {}, {
    assessment_id: assessmentId,
    ...body,
  });
}

async function practiceSitting(): Promise<TestSessionRow> {
  asOwner();
  const res = await createSitting({ kind: "practice" });
  expect(res.status).toBe(201);
  return ((await res.json()) as { test_session: TestSessionRow }).test_session;
}

async function join(sittingId: string): Promise<Response> {
  return call("../app/api/attempts/route", "POST", "/api/attempts", {}, {
    test_session_id: sittingId,
  });
}

async function answer(attemptId: string): Promise<Response> {
  return call(
    "../app/api/attempts/[attemptId]/responses/[itemId]/route",
    "PUT",
    `/api/attempts/${attemptId}/responses/${itemId}`,
    { attemptId, itemId },
    { response: { type: "multiple_choice_single", choice_id: "a" } },
  );
}

beforeAll(async () => {
  expectTestDb();
  await seedRoster();
});

afterEach(async () => {
  const db = getDb();
  await db.execute(sql`truncate table assessments restart identity cascade`);
  await db.execute(sql`truncate table students restart identity cascade`);
});

afterAll(async () => {
  await clearRoster();
  await closeDb();
});

async function seedAssessment() {
  const [a] = await getDb()
    .insert(assessments)
    .values({ owner_sub: OWNER, owner_email: TEACHER_EMAIL, name: "Practice me", status: "published" })
    .returning();
  assessmentId = a!.id;
  const [item] = await getDb()
    .insert(items)
    .values({
      assessment_id: assessmentId,
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
  itemId = item!.id;
}

describe("creating a practice sitting (D-1, D-2)", () => {
  test("kind practice names the caller and takes no scope", async () => {
    await seedAssessment();
    const sitting = await practiceSitting();
    expect(sitting.kind).toBe("practice");
    expect(sitting.practice_for_sub).toBe(OWNER);
    expect(sitting.owner_sub).toBe(OWNER);
    expect(sitting.section_ps_id).toBeNull();
    expect(sitting.student_ps_ids).toBeNull();

    const scoped = await createSitting({ kind: "practice", section_ps_id: "5001" });
    expect(scoped.status).toBe(400);
    expect(await scoped.json()).toEqual({ ok: false, error: "scope_conflict" });

    // Omitted kind stays a class sitting.
    const cls = await createSitting({});
    const row = ((await cls.json()) as { test_session: TestSessionRow }).test_session;
    expect(row.kind).toBe("class");
    expect(row.practice_for_sub).toBeNull();
  });

  test("a colleague with no access to the assessment cannot start one (404)", async () => {
    await seedAssessment();
    asColleague();
    const res = await createSitting({ kind: "practice" });
    expect(res.status).toBe(404);
  });
});

describe("the practice principal on the student routes (D-3)", () => {
  test("Your tests → join → answer → delivery → hand in, all as staff", async () => {
    await seedAssessment();
    const sitting = await practiceSitting();

    const listed = await call("../app/api/me/sittings/route", "GET", "/api/me/sittings");
    const list = (await listed.json()) as { sittings: { test_session_id: string; scope: string; attempt: unknown }[] };
    expect(list.sittings).toHaveLength(1);
    expect(list.sittings[0]).toMatchObject({ test_session_id: sitting.id, scope: "practice", attempt: null });

    const joined = await join(sitting.id);
    expect(joined.status).toBe(201);
    const { attempt } = (await joined.json()) as { attempt: AttemptRow };
    expect(attempt.practice).toBe(true);

    expect((await answer(attempt.id)).status).toBe(200);

    const delivery = await call(
      "../app/api/assessments/[id]/delivery/route",
      "GET",
      `/api/assessments/${assessmentId}/delivery`,
      { id: assessmentId },
    );
    expect(delivery.status).toBe(200);

    const relisted = (await (await call("../app/api/me/sittings/route", "GET", "/api/me/sittings")).json()) as {
      sittings: { attempt: { id: string; status: string } | null }[];
    };
    expect(relisted.sittings[0]!.attempt).toMatchObject({ id: attempt.id, status: "in_progress" });

    const submitted = await call(
      "../app/api/attempts/[attemptId]/submit/route",
      "POST",
      `/api/attempts/${attempt.id}/submit`,
      { attemptId: attempt.id },
    );
    expect(submitted.status).toBe(200);

    // One practice overlay row, under the assessment owner, named for the teacher.
    const overlays = await getDb().select().from(students);
    expect(overlays).toHaveLength(1);
    expect(overlays[0]!.practice_for_sub).toBe(OWNER);
    expect(overlays[0]!.name).toContain("Practice");
  });

  test("redeem by code: the teacher it names only", async () => {
    await seedAssessment();
    const sitting = await practiceSitting();
    const redeem = () =>
      call("../app/api/test-sessions/redeem/route", "POST", "/api/test-sessions/redeem", {}, {
        code: sitting.code,
      });

    asOwner();
    expect((await redeem()).status).toBe(200);

    asColleague();
    const colleague = await redeem();
    expect(colleague.status).toBe(404);
    expect(await colleague.json()).toEqual({ ok: false, error: "session_unavailable" });

    principal = studentPrincipal(STUDENT.email);
    const student = await redeem();
    expect(student.status).toBe(404);
    expect(await student.json()).toEqual({ ok: false, error: "session_unavailable" });
  });

  test("nobody else can join, write or list it; staff cannot join a class sitting", async () => {
    await seedAssessment();
    const sitting = await practiceSitting();
    const { attempt } = (await (await join(sitting.id)).json()) as { attempt: AttemptRow };

    asColleague();
    expect((await join(sitting.id)).status).toBe(404);
    expect((await answer(attempt.id)).status).toBe(404);
    expect(await (await call("../app/api/me/sittings/route", "GET", "/api/me/sittings")).json()).toEqual({
      sittings: [],
      reason: "no_practice_sitting",
    });

    principal = studentPrincipal(STUDENT.email);
    expect((await join(sitting.id)).status).toBe(404);
    expect((await answer(attempt.id)).status).toBe(404);

    // The owner is refused a CLASS sitting, and never sees one in the list.
    asOwner();
    const cls = ((await (await createSitting({})).json()) as { test_session: TestSessionRow }).test_session;
    const refused = await join(cls.id);
    expect(refused.status).toBe(404);
    expect(await refused.json()).toEqual({ ok: false, error: "not_in_sitting" });
    const mine = (await (await call("../app/api/me/sittings/route", "GET", "/api/me/sittings")).json()) as {
      sittings: { test_session_id: string }[];
    };
    expect(mine.sittings.map((s) => s.test_session_id)).toEqual([sitting.id]);
  });
});

describe("the Monitor on a practice sitting (D-5)", () => {
  test("one expected row — the practising teacher — joined or not", async () => {
    await seedAssessment();
    const sitting = await practiceSitting();

    const before = await attendanceForSitting(getDb(), sitting);
    expect(before.counts.expected).toBe(1);
    expect(before.rows).toHaveLength(1);
    expect(before.rows[0]).toMatchObject({ name: PRACTICE_ROW_NAME, status: "not_joined", attempt_id: null });

    const { attempt } = (await (await join(sitting.id)).json()) as { attempt: AttemptRow };
    const after = await attendanceForSitting(getDb(), sitting);
    expect(after.rows).toHaveLength(1);
    expect(after.rows[0]).toMatchObject({
      name: PRACTICE_ROW_NAME,
      status: "in_progress",
      attempt_id: attempt.id,
      in_scope: true,
    });
    expect(after.counts).toMatchObject({ expected: 1, joined: 1 });
  });
});

describe("Practice again (D-6)", () => {
  test("the practice attempt deletes while its sitting is open; a class one still does not", async () => {
    await seedAssessment();
    const sitting = await practiceSitting();
    const { attempt } = (await (await join(sitting.id)).json()) as { attempt: AttemptRow };

    asOwner();
    const del = await call(
      "../app/api/attempts/[attemptId]/route",
      "DELETE",
      `/api/attempts/${attempt.id}`,
      { attemptId: attempt.id },
    );
    expect(del.status).toBe(204);

    // The next join starts fresh.
    const again = await join(sitting.id);
    expect(again.status).toBe(201);
    const fresh = ((await again.json()) as { attempt: AttemptRow }).attempt;
    expect(fresh.id).not.toBe(attempt.id);

    // The relaxation is for practice only.
    const cls = ((await (await createSitting({})).json()) as { test_session: TestSessionRow }).test_session;
    principal = studentPrincipal(STUDENT.email);
    const { attempt: classAttempt } = (await (await join(cls.id)).json()) as { attempt: AttemptRow };
    asOwner();
    const refused = await call(
      "../app/api/attempts/[attemptId]/route",
      "DELETE",
      `/api/attempts/${classAttempt.id}`,
      { attemptId: classAttempt.id },
    );
    expect(refused.status).toBe(409);
  });
});

describe("the nightly practice sweep (D-7)", () => {
  const DAY = 24 * 60 * 60 * 1000;

  test("deletes practice attempts 7 days after the sitting ended and archives it; nothing else", async () => {
    await seedAssessment();
    const now = new Date();

    // Practice, expired 8 days ago → swept.
    const old = await practiceSitting();
    const { attempt: oldAttempt } = (await (await join(old.id)).json()) as { attempt: AttemptRow };
    await getDb()
      .update(test_sessions)
      .set({ expires_at: new Date(now.getTime() - 8 * DAY) })
      .where(eq(test_sessions.id, old.id));

    // Practice, CLOSED 6 days ago (expiry later) → kept.
    const recent = await practiceSitting();
    await getDb()
      .update(test_sessions)
      .set({ status: "closed", updated_at: new Date(now.getTime() - 6 * DAY) })
      .where(eq(test_sessions.id, recent.id));

    // A class sitting that expired long ago, with a student's attempt → untouched.
    asOwner();
    const cls = ((await (await createSitting({})).json()) as { test_session: TestSessionRow }).test_session;
    principal = studentPrincipal(STUDENT.email);
    const { attempt: classAttempt } = (await (await join(cls.id)).json()) as { attempt: AttemptRow };
    await getDb()
      .update(test_sessions)
      .set({ expires_at: new Date(now.getTime() - 30 * DAY) })
      .where(eq(test_sessions.id, cls.id));

    const counts = await sweepPracticeSittings(getDb(), now);
    expect(counts).toMatchObject({ practice_attempts_deleted: 1, practice_sittings_archived: 1 });

    const remaining = (await getDb().select().from(attempts)).map((a) => a.id);
    expect(remaining).not.toContain(oldAttempt.id);
    expect(remaining).toContain(classAttempt.id);

    const [oldRow] = await getDb().select().from(test_sessions).where(eq(test_sessions.id, old.id));
    expect(oldRow!.archived_at).not.toBeNull();
    const [recentRow] = await getDb().select().from(test_sessions).where(eq(test_sessions.id, recent.id));
    expect(recentRow!.archived_at).toBeNull();
    const [clsRow] = await getDb().select().from(test_sessions).where(eq(test_sessions.id, cls.id));
    expect(clsRow!.archived_at).toBeNull();

    // The same audit row the Delete button writes.
    const [audit] = await getDb()
      .select()
      .from(attempt_deletions)
      .where(eq(attempt_deletions.attempt_id, oldAttempt.id));
    expect(audit!.deleted_by_sub).toBe(PRACTICE_SWEEP_ACTOR);

    // Idempotent: an archived sitting is not swept twice.
    expect(await sweepPracticeSittings(getDb(), now)).toMatchObject({
      practice_attempts_deleted: 0,
      practice_sittings_archived: 0,
    });
  });
});

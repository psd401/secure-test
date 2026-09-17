// Teacher-granted extra time: `POST /api/attempts/[attemptId]/extend`.
//
// Same in-process mock harness as attempt-hand-in-api.test.ts, and
// deliberately the same authorisation expectations (404 unknown / 403 someone
// else's), because the two controls sit side by side on every teacher surface
// and a caller must not be able to tell them apart.
//
// The last group is the point of the whole feature: an extension has to make
// the STUDENT PLANE accept a write it was refusing a moment earlier. A route
// that stored an override nothing enforced would pass every test above it.
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { closeDb, getDb } from "../db/client";
import {
  assessments,
  attempt_events,
  attempts,
  items,
  students,
  test_sessions,
} from "../db/schema";
import { SESSION_COOKIE_NAME } from "../lib/auth/session";
import * as sessionMod from "../lib/auth/session";

const expectTestDb = () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("secure_test_design_tool_test")) {
    throw new Error(`extend tests require the test DB DATABASE_URL; got: ${url}`);
  }
};

const OWNER = "extend-teacher";
const OTHER_OWNER = "extend-other-teacher";

let mockSession: { sub: string; role: string } | null = null;
let originalSessionSecret: string | undefined;

mock.module("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({
    get: (name: string) =>
      mockSession && name === SESSION_COOKIE_NAME ? { value: "x" } : undefined,
  }),
}));

mock.module("../lib/auth/session", () => ({
  ...sessionMod,
  readSessionFromCookies: async () => mockSession,
}));

beforeAll(() => {
  expectTestDb();
  originalSessionSecret = process.env.DESIGN_TOOL_SESSION_SECRET;
  process.env.DESIGN_TOOL_SESSION_SECRET = "test-session-secret-do-not-use";
  mockSession = { sub: OWNER, role: "staff" };
});

afterEach(async () => {
  mockSession = { sub: OWNER, role: "staff" };
  const db = getDb();
  await db.execute(sql`truncate table assessments restart identity cascade`);
  await db.execute(sql`truncate table students restart identity cascade`);
});

afterAll(async () => {
  await closeDb();
  if (originalSessionSecret === undefined) delete process.env.DESIGN_TOOL_SESSION_SECRET;
  else process.env.DESIGN_TOOL_SESSION_SECRET = originalSessionSecret;
});

async function seedAttempt(
  opts: {
    status?: "in_progress" | "submitted";
    sittingStatus?: "open" | "closed";
    timeLimitSeconds?: number | null;
    startedMinutesAgo?: number;
  } = {},
) {
  const db = getDb();
  const [assessment] = await db
    .insert(assessments)
    .values({
      owner_sub: OWNER,
      name: "Extend",
      time_limit_seconds: opts.timeLimitSeconds ?? null,
    })
    .returning();
  const [mc] = await db
    .insert(items)
    .values({
      assessment_id: assessment!.id,
      position: 0,
      type: "multiple_choice_single",
      stem: "Pick one",
      choices: [
        { id: "a", text: "A" },
        { id: "b", text: "B" },
      ],
      correct_choice_ids: ["a"],
    })
    .returning();
  const [student] = await db
    .insert(students)
    .values({ owner_sub: OWNER, ssid: "998", name: "Extend Student" })
    .returning();

  let sittingId: string | null = null;
  if (opts.sittingStatus) {
    const [sitting] = await db
      .insert(test_sessions)
      .values({
        assessment_id: assessment!.id,
        owner_sub: OWNER,
        code: `E${Math.floor(Math.random() * 100000)}`,
        status: opts.sittingStatus,
        expires_at: new Date(Date.now() + 3_600_000),
      })
      .returning();
    sittingId = sitting!.id;
  }

  const status = opts.status ?? "in_progress";
  const [attempt] = await db
    .insert(attempts)
    .values({
      assessment_id: assessment!.id,
      student_id: student!.id,
      test_session_id: sittingId,
      status,
      started_at: new Date(Date.now() - (opts.startedMinutesAgo ?? 0) * 60_000),
      submitted_at: status === "submitted" ? new Date() : null,
    })
    .returning();

  return { assessment: assessment!, student: student!, attempt: attempt!, mc: mc! };
}

const inMinutes = (n: number) => new Date(Date.now() + n * 60_000).toISOString();

async function extend(attemptId: string, endsAt?: string, raw?: string) {
  const { POST } = await import("../app/api/attempts/[attemptId]/extend/route");
  return POST(
    new Request(`http://localhost/api/attempts/${attemptId}/extend`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: raw ?? JSON.stringify({ ends_at: endsAt }),
    }),
    { params: Promise.resolve({ attemptId }) },
  );
}

describe("POST /api/attempts/[attemptId]/extend", () => {
  test("the owner extends: the column, updated_at and the audit event", async () => {
    const s = await seedAttempt({ sittingStatus: "open", timeLimitSeconds: 600 });
    const endsAt = inMinutes(45);
    const res = await extend(s.attempt.id, endsAt);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      attempt_id: s.attempt.id,
      deadline_override_at: endsAt,
    });

    const db = getDb();
    const [row] = await db.select().from(attempts).where(eq(attempts.id, s.attempt.id));
    expect(row!.deadline_override_at!.toISOString()).toBe(endsAt);
    expect(row!.updated_at.getTime()).toBeGreaterThanOrEqual(
      s.attempt.updated_at.getTime(),
    );
    // Still in progress: extending is not a status change.
    expect(row!.status).toBe("in_progress");

    const events = await db
      .select()
      .from(attempt_events)
      .where(eq(attempt_events.attempt_id, s.attempt.id));
    expect(events.map((e) => e.kind)).toEqual(["deadline_extended"]);
    expect(events[0]!.detail).toEqual({ ends_at: endsAt, by: OWNER });
  });

  // An OPEN sitting is deliberately not a refusal here, unlike hand-in and
  // delete: extending is additive, so the "may be mid-answer" guard would
  // block exactly the case the feature exists for.
  test("an open sitting is NOT a refusal", async () => {
    const s = await seedAttempt({ sittingStatus: "open" });
    expect((await extend(s.attempt.id, inMinutes(20))).status).toBe(200);
  });

  test("a closed sitting extends too — tomorrow is the point", async () => {
    const s = await seedAttempt({ sittingStatus: "closed", timeLimitSeconds: 600 });
    expect((await extend(s.attempt.id, inMinutes(60 * 24))).status).toBe(200);
  });

  test("an attempt with no sitting at all extends", async () => {
    const s = await seedAttempt({});
    expect((await extend(s.attempt.id, inMinutes(20))).status).toBe(200);
  });

  test("re-applying the same instant is idempotent in effect", async () => {
    const s = await seedAttempt({ timeLimitSeconds: 600 });
    const endsAt = inMinutes(30);
    expect((await extend(s.attempt.id, endsAt)).status).toBe(200);
    expect((await extend(s.attempt.id, endsAt)).status).toBe(200);
    const db = getDb();
    const [row] = await db.select().from(attempts).where(eq(attempts.id, s.attempt.id));
    // The override REPLACES, so twice is the same deadline, not double the time.
    expect(row!.deadline_override_at!.toISOString()).toBe(endsAt);
  });

  test("a later extension replaces the earlier one", async () => {
    const s = await seedAttempt({ timeLimitSeconds: 600 });
    await extend(s.attempt.id, inMinutes(20));
    const second = inMinutes(50);
    await extend(s.attempt.id, second);
    const db = getDb();
    const [row] = await db.select().from(attempts).where(eq(attempts.id, s.attempt.id));
    expect(row!.deadline_override_at!.toISOString()).toBe(second);
    // Both extensions are on the record, though — the timeline shows the history.
    const events = await db
      .select()
      .from(attempt_events)
      .where(eq(attempt_events.attempt_id, s.attempt.id));
    expect(events).toHaveLength(2);
  });

  test("an instant in the past is 400 ends_at_past and writes nothing", async () => {
    const s = await seedAttempt({ timeLimitSeconds: 600 });
    const res = await extend(s.attempt.id, inMinutes(-1));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: "ends_at_past" });
    const db = getDb();
    const [row] = await db.select().from(attempts).where(eq(attempts.id, s.attempt.id));
    expect(row!.deadline_override_at).toBeNull();
    expect(await db.select().from(attempt_events)).toHaveLength(0);
  });

  test("a submitted attempt is 409 not_in_progress and writes nothing", async () => {
    const s = await seedAttempt({ status: "submitted" });
    const res = await extend(s.attempt.id, inMinutes(30));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ ok: false, error: "not_in_progress" });
    const db = getDb();
    const [row] = await db.select().from(attempts).where(eq(attempts.id, s.attempt.id));
    expect(row!.deadline_override_at).toBeNull();
    expect(await db.select().from(attempt_events)).toHaveLength(0);
  });

  test("a missing, unparseable or non-string ends_at is 400 invalid_body", async () => {
    const s = await seedAttempt({});
    expect((await extend(s.attempt.id, undefined)).status).toBe(400);
    expect((await extend(s.attempt.id, "next Tuesday-ish")).status).toBe(400);
    expect((await extend(s.attempt.id, undefined, "{")).status).toBe(400);
    expect((await extend(s.attempt.id, undefined, '{"ends_at":123}')).status).toBe(400);
  });

  test("another teacher gets 403 and nothing changes", async () => {
    const s = await seedAttempt({ timeLimitSeconds: 600 });
    mockSession = { sub: OTHER_OWNER, role: "staff" };
    expect((await extend(s.attempt.id, inMinutes(30))).status).toBe(403);
    const db = getDb();
    const [row] = await db.select().from(attempts).where(eq(attempts.id, s.attempt.id));
    expect(row!.deadline_override_at).toBeNull();
  });

  test("a student session gets 403; no session 401", async () => {
    const s = await seedAttempt({});
    mockSession = { sub: "student-sub", role: "student" };
    expect((await extend(s.attempt.id, inMinutes(30))).status).toBe(403);
    mockSession = null;
    expect((await extend(s.attempt.id, inMinutes(30))).status).toBe(401);
  });

  test("an unknown id is 404, a malformed one 400", async () => {
    expect(
      (await extend("11111111-1111-4111-8111-111111111111", inMinutes(30))).status,
    ).toBe(404);
    expect((await extend("nope", inMinutes(30))).status).toBe(400);
  });
});

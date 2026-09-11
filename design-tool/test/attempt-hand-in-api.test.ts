// Time limit / unfinished attempts
// (docs/time-limit-and-unfinished-attempts-design.md, D-1/A): the teacher's
// forced submission. Same in-process mock harness as attempt-delete-api.test.ts
// — and deliberately the same authorisation expectations, because the two
// actions sit side by side on every teacher surface and a caller must not be
// able to tell them apart.
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { closeDb, getDb } from "../db/client";
import {
  assessments,
  attempt_events,
  attempts,
  items,
  responses,
  scores,
  students,
  test_sessions,
} from "../db/schema";
import { SESSION_COOKIE_NAME } from "../lib/auth/session";
import * as sessionMod from "../lib/auth/session";

const expectTestDb = () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("secure_test_design_tool_test")) {
    throw new Error(`hand-in tests require the test DB DATABASE_URL; got: ${url}`);
  }
};

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

const OWNER = "hand-in-teacher";
const OTHER_OWNER = "hand-in-other-teacher";

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

/**
 * An attempt with one correct MC answer saved and NOT scored — so the
 * auto-scoring the hand-in fires is observable as a score row appearing.
 */
async function seedAttempt(opts: {
  status?: "in_progress" | "submitted";
  sittingStatus?: "open" | "closed";
  /** Seconds; with `startedMinutesAgo` this decides whether time is up. */
  timeLimitSeconds?: number | null;
  startedMinutesAgo?: number;
} = {}) {
  const db = getDb();
  const [assessment] = await db
    .insert(assessments)
    .values({
      owner_sub: OWNER,
      name: "Hand in",
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
    .values({ owner_sub: OWNER, ssid: "999", name: "Hand-in Student" })
    .returning();

  let sittingId: string | null = null;
  if (opts.sittingStatus) {
    const [sitting] = await db
      .insert(test_sessions)
      .values({
        assessment_id: assessment!.id,
        owner_sub: OWNER,
        code: `H${Math.floor(Math.random() * 100000)}`,
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

  await db.insert(responses).values({
    attempt_id: attempt!.id,
    item_id: mc!.id,
    response: { type: "multiple_choice_single", choice_id: "a" },
  });

  return { assessment: assessment!, student: student!, attempt: attempt!, mc: mc! };
}

async function handIn(attemptId: string) {
  const { POST } = await import("../app/api/attempts/[attemptId]/hand-in/route");
  return POST(
    new Request(`http://localhost/api/attempts/${attemptId}/hand-in`, { method: "POST" }),
    { params: Promise.resolve({ attemptId }) },
  );
}

describe("POST /api/attempts/[attemptId]/hand-in", () => {
  test("the owner hands in: status, submitted_at, submitted_by_sub, the event and the auto-score", async () => {
    const s = await seedAttempt({ sittingStatus: "closed" });
    const res = await handIn(s.attempt.id);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.scored).toBe(1);
    expect(body.attempt.status).toBe("submitted");

    const db = getDb();
    const [row] = await db.select().from(attempts).where(eq(attempts.id, s.attempt.id));
    expect(row!.status).toBe("submitted");
    expect(row!.submitted_at).not.toBeNull();
    // The whole point of the column: this was NOT the student's own hand-in.
    expect(row!.submitted_by_sub).toBe(OWNER);

    const events = await db
      .select()
      .from(attempt_events)
      .where(eq(attempt_events.attempt_id, s.attempt.id));
    expect(events.map((e) => e.kind)).toEqual(["teacher_hand_in"]);

    const scoreRows = await db.select().from(scores);
    expect(scoreRows).toHaveLength(1);
    expect(scoreRows[0]).toMatchObject({ points: 1, max_points: 1, status: "final" });
  });

  test("a second hand-in is refused with 409 already_submitted and moves nothing", async () => {
    const s = await seedAttempt({ sittingStatus: "closed" });
    expect((await handIn(s.attempt.id)).status).toBe(200);
    const db = getDb();
    const [first] = await db.select().from(attempts).where(eq(attempts.id, s.attempt.id));

    const res = await handIn(s.attempt.id);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ ok: false, error: "already_submitted" });

    const [again] = await db.select().from(attempts).where(eq(attempts.id, s.attempt.id));
    expect(again!.submitted_at!.getTime()).toBe(first!.submitted_at!.getTime());
  });

  test("an attempt the student already handed in is 409 too, and keeps submitted_by_sub null", async () => {
    const s = await seedAttempt({ status: "submitted" });
    const res = await handIn(s.attempt.id);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("already_submitted");
    const db = getDb();
    const [row] = await db.select().from(attempts).where(eq(attempts.id, s.attempt.id));
    expect(row!.submitted_by_sub).toBeNull();
  });

  test("an OPEN sitting with no time limit is refused with 409 session_open", async () => {
    const s = await seedAttempt({ sittingStatus: "open" });
    const res = await handIn(s.attempt.id);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ ok: false, error: "session_open" });
    const db = getDb();
    const [row] = await db.select().from(attempts).where(eq(attempts.id, s.attempt.id));
    expect(row!.status).toBe("in_progress");
  });

  // The relaxation that makes this usable in the room: once the student's own
  // time is up the server refuses their writes anyway, so there is no answer
  // in flight and the teacher need not close the whole period first.
  test("an OPEN sitting whose deadline has PASSED hands in", async () => {
    const s = await seedAttempt({
      sittingStatus: "open",
      timeLimitSeconds: 600,
      startedMinutesAgo: 30,
    });
    const res = await handIn(s.attempt.id);
    expect(res.status).toBe(200);
    const db = getDb();
    const [row] = await db.select().from(attempts).where(eq(attempts.id, s.attempt.id));
    expect(row!.status).toBe("submitted");
  });

  test("an OPEN sitting whose deadline has NOT passed is still refused", async () => {
    const s = await seedAttempt({
      sittingStatus: "open",
      timeLimitSeconds: 3600,
      startedMinutesAgo: 5,
    });
    expect((await handIn(s.attempt.id)).status).toBe(409);
  });

  test("an in-progress attempt with no sitting at all hands in", async () => {
    const s = await seedAttempt({});
    expect((await handIn(s.attempt.id)).status).toBe(200);
  });

  test("another teacher gets 403 and nothing changes", async () => {
    const s = await seedAttempt({ sittingStatus: "closed" });
    mockSession = { sub: OTHER_OWNER, role: "staff" };
    expect((await handIn(s.attempt.id)).status).toBe(403);
    const db = getDb();
    const [row] = await db.select().from(attempts).where(eq(attempts.id, s.attempt.id));
    expect(row!.status).toBe("in_progress");
  });

  test("a student session gets 403; no session 401", async () => {
    const s = await seedAttempt({ sittingStatus: "closed" });
    mockSession = { sub: "student-sub", role: "student" };
    expect((await handIn(s.attempt.id)).status).toBe(403);
    mockSession = null;
    expect((await handIn(s.attempt.id)).status).toBe(401);
  });

  test("an unknown id is 404, a malformed one 400", async () => {
    expect((await handIn("11111111-1111-4111-8111-111111111111")).status).toBe(404);
    expect((await handIn("nope")).status).toBe(400);
  });
});

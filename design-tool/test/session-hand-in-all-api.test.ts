// "Hand in everyone now" (James, 2026-09-16): the per-attempt forced hand-in
// applied to a whole sitting. Same in-process mock harness and the same
// authorisation expectations as attempt-hand-in-api.test.ts — the two buttons
// sit on the same page and a caller must not be able to tell them apart.
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
    throw new Error(`hand-in-all tests require the test DB DATABASE_URL; got: ${url}`);
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

const OWNER = "hand-in-all-teacher";
const OTHER_OWNER = "hand-in-all-other-teacher";

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

interface SeedAttempt {
  status?: "in_progress" | "submitted";
  /** Minutes ago the attempt began — with the sitting's time limit, whether
   *  its own deadline has passed. */
  startedMinutesAgo?: number;
  /** Bind the attempt to NO sitting (the `--token` dev posture). */
  detached?: boolean;
}

/**
 * One assessment, one sitting, and an attempt per spec — each with one correct
 * MC answer saved and NOT scored, so the auto-scoring the hand-in fires is
 * observable as a score row appearing.
 */
async function seedSitting(opts: {
  sittingStatus?: "open" | "closed";
  timeLimitSeconds?: number | null;
  attempts: SeedAttempt[];
}) {
  const db = getDb();
  const [assessment] = await db
    .insert(assessments)
    .values({
      owner_sub: OWNER,
      name: "Hand in everyone",
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

  const [sitting] = await db
    .insert(test_sessions)
    .values({
      assessment_id: assessment!.id,
      owner_sub: OWNER,
      code: `A${Math.floor(Math.random() * 100000)}`,
      status: opts.sittingStatus ?? "closed",
      expires_at: new Date(Date.now() + 3_600_000),
    })
    .returning();

  const rows = [];
  for (const [i, spec] of opts.attempts.entries()) {
    const [student] = await db
      .insert(students)
      .values({ owner_sub: OWNER, ssid: `90${i}`, name: `Student ${i}` })
      .returning();
    const status = spec.status ?? "in_progress";
    const [attempt] = await db
      .insert(attempts)
      .values({
        assessment_id: assessment!.id,
        student_id: student!.id,
        test_session_id: spec.detached ? null : sitting!.id,
        status,
        started_at: new Date(Date.now() - (spec.startedMinutesAgo ?? 0) * 60_000),
        submitted_at: status === "submitted" ? new Date() : null,
      })
      .returning();
    await db.insert(responses).values({
      attempt_id: attempt!.id,
      item_id: mc!.id,
      response: { type: "multiple_choice_single", choice_id: "a" },
    });
    rows.push(attempt!);
  }

  return { assessment: assessment!, sitting: sitting!, attempts: rows };
}

async function handInAll(sessionId: string) {
  const { POST } = await import(
    "../app/api/test-sessions/[sessionId]/hand-in-all/route"
  );
  return POST(
    new Request(`http://localhost/api/test-sessions/${sessionId}/hand-in-all`, {
      method: "POST",
    }),
    { params: Promise.resolve({ sessionId }) },
  );
}

async function statusOf(attemptId: string) {
  const db = getDb();
  const [row] = await db.select().from(attempts).where(eq(attempts.id, attemptId));
  return row!;
}

describe("POST /api/test-sessions/[sessionId]/hand-in-all", () => {
  test("a closed sitting hands in every in-progress attempt, skips the submitted one, and scores each", async () => {
    const s = await seedSitting({
      sittingStatus: "closed",
      attempts: [{}, {}, {}, { status: "submitted" }],
    });

    const res = await handInAll(s.sitting.id);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.handed_in).toBe(3);
    expect(body.skipped).toBe(1);
    expect(body.scored).toBe(3);
    expect(body.attempts).toHaveLength(3);
    expect(body.attempts.every((a: { status: string }) => a.status === "submitted")).toBe(
      true,
    );

    const db = getDb();
    for (const attempt of s.attempts.slice(0, 3)) {
      const row = await statusOf(attempt.id);
      expect(row.status).toBe("submitted");
      expect(row.submitted_at).not.toBeNull();
      // The whole point of the column: this was NOT the student's own hand-in.
      expect(row.submitted_by_sub).toBe(OWNER);
      const events = await db
        .select()
        .from(attempt_events)
        .where(eq(attempt_events.attempt_id, attempt.id));
      expect(events.map((e) => e.kind)).toEqual(["teacher_hand_in"]);
    }

    // The already-submitted attempt is untouched: no event, no teacher stamp.
    const untouched = await statusOf(s.attempts[3]!.id);
    expect(untouched.submitted_by_sub).toBeNull();
    const noEvents = await db
      .select()
      .from(attempt_events)
      .where(eq(attempt_events.attempt_id, s.attempts[3]!.id));
    expect(noEvents).toHaveLength(0);

    const scoreRows = await db.select().from(scores);
    expect(scoreRows).toHaveLength(3);
    expect(scoreRows[0]).toMatchObject({ points: 1, max_points: 1, status: "final" });
  });

  test("a second call hands in 0 and changes nothing", async () => {
    const s = await seedSitting({ sittingStatus: "closed", attempts: [{}, {}] });
    expect((await handInAll(s.sitting.id)).status).toBe(200);
    const first = await statusOf(s.attempts[0]!.id);

    const res = await handInAll(s.sitting.id);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.handed_in).toBe(0);
    expect(body.skipped).toBe(2);
    expect(body.attempts).toEqual([]);

    const again = await statusOf(s.attempts[0]!.id);
    expect(again.submitted_at!.getTime()).toBe(first.submitted_at!.getTime());
    const db = getDb();
    const events = await db
      .select()
      .from(attempt_events)
      .where(eq(attempt_events.attempt_id, s.attempts[0]!.id));
    expect(events).toHaveLength(1);
  });

  test("an OPEN sitting with no time limit is refused with 409 session_open", async () => {
    const s = await seedSitting({ sittingStatus: "open", attempts: [{}, {}] });
    const res = await handInAll(s.sitting.id);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ ok: false, error: "session_open" });
    for (const attempt of s.attempts) {
      expect((await statusOf(attempt.id)).status).toBe("in_progress");
    }
  });

  // The relaxation that makes this usable in the room, applied per row: the
  // student whose own time is up is already being refused their writes, so
  // there is no answer in flight to freeze.
  test("an OPEN sitting hands in only the attempts past their own deadline", async () => {
    const s = await seedSitting({
      sittingStatus: "open",
      timeLimitSeconds: 600,
      attempts: [{ startedMinutesAgo: 30 }, { startedMinutesAgo: 2 }],
    });

    const res = await handInAll(s.sitting.id);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.handed_in).toBe(1);
    expect(body.skipped).toBe(1);
    expect(body.attempts[0].attempt_id).toBe(s.attempts[0]!.id);

    expect((await statusOf(s.attempts[0]!.id)).status).toBe("submitted");
    expect((await statusOf(s.attempts[1]!.id)).status).toBe("in_progress");
  });

  test("attempts on the same assessment with no sitting are NOT touched", async () => {
    const s = await seedSitting({
      sittingStatus: "closed",
      attempts: [{}, { detached: true }],
    });
    const res = await handInAll(s.sitting.id);
    expect((await res.json()).handed_in).toBe(1);
    expect((await statusOf(s.attempts[1]!.id)).status).toBe("in_progress");
  });

  test("another teacher gets 404 and nothing changes", async () => {
    const s = await seedSitting({ sittingStatus: "closed", attempts: [{}] });
    mockSession = { sub: OTHER_OWNER, role: "staff" };
    const res = await handInAll(s.sitting.id);
    expect(res.status).toBe(404);
    expect((await statusOf(s.attempts[0]!.id)).status).toBe("in_progress");
  });

  test("a student session gets 403; no session 401", async () => {
    const s = await seedSitting({ sittingStatus: "closed", attempts: [{}] });
    mockSession = { sub: "student-sub", role: "student" };
    expect((await handInAll(s.sitting.id)).status).toBe(403);
    mockSession = null;
    expect((await handInAll(s.sitting.id)).status).toBe(401);
  });

  test("an unknown id is 404, a malformed one 400", async () => {
    expect((await handInAll("11111111-1111-4111-8111-111111111111")).status).toBe(404);
    expect((await handInAll("nope")).status).toBe(400);
  });
});

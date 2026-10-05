// Roadmap U-14 (2026-10-05): "Hand in all in progress" from the Results page —
// the per-attempt hand-in applied to a list of attempts on one assessment,
// whichever sitting each last joined. Same harness and authorisation
// expectations as session-hand-in-all-api.test.ts.
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
    throw new Error(`assessment hand-in tests require the test DB DATABASE_URL; got: ${url}`);
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

const OWNER = "hand-in-ip-teacher";
const OTHER_OWNER = "hand-in-ip-other-teacher";

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
let seedCount = 90;
async function seedSitting(opts: {
  sittingStatus?: "open" | "closed";
  timeLimitSeconds?: number | null;
  attempts: SeedAttempt[];
}) {
  seedCount++;
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
      .values({ owner_sub: OWNER, ssid: `${seedCount}${i}`, name: `Student ${i}` })
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

async function handIn(assessmentId: string, attemptIds: unknown) {
  const { POST } = await import("../app/api/assessments/[id]/hand-in/route");
  return POST(
    new Request(`http://localhost/api/assessments/${assessmentId}/hand-in`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ attempt_ids: attemptIds }),
    }),
    { params: Promise.resolve({ id: assessmentId }) },
  );
}

async function statusOf(attemptId: string) {
  const db = getDb();
  const [row] = await db.select().from(attempts).where(eq(attempts.id, attemptId));
  return row!;
}

describe("POST /api/assessments/[id]/hand-in", () => {
  // The case U-14 exists for: a resume rebinds an attempt to the LAST sitting,
  // so attempts on one assessment sit across several closed sittings.
  test("hands in in-progress attempts across two closed sittings in one call, scores each", async () => {
    const a = await seedSitting({ sittingStatus: "closed", attempts: [{}, {}] });
    const db = getDb();
    const [second] = await db
      .insert(test_sessions)
      .values({
        assessment_id: a.assessment.id,
        owner_sub: OWNER,
        code: `B${Math.floor(Math.random() * 100000)}`,
        status: "closed",
        expires_at: new Date(Date.now() + 3_600_000),
      })
      .returning();
    await db
      .update(attempts)
      .set({ test_session_id: second!.id })
      .where(eq(attempts.id, a.attempts[1]!.id));

    const res = await handIn(a.assessment.id, a.attempts.map((x) => x.id));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.handed_in).toBe(2);
    expect(body.scored).toBe(2);
    for (const attempt of a.attempts) {
      const row = await statusOf(attempt.id);
      expect(row.status).toBe("submitted");
      expect(row.submitted_by_sub).toBe(OWNER);
      const events = await db
        .select()
        .from(attempt_events)
        .where(eq(attempt_events.attempt_id, attempt.id));
      expect(events.map((e) => e.kind)).toEqual(["teacher_hand_in"]);
    }
  });

  test("submitted rows and ids from another assessment are skipped, not touched", async () => {
    const a = await seedSitting({ sittingStatus: "closed", attempts: [{}, { status: "submitted" }] });
    const b = await seedSitting({ sittingStatus: "closed", attempts: [{}] });
    const res = await handIn(a.assessment.id, [...a.attempts.map((x) => x.id), b.attempts[0]!.id]);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.handed_in).toBe(1);
    expect(body.skipped).toBe(2);
    expect((await statusOf(b.attempts[0]!.id)).status).toBe("in_progress");
    expect((await statusOf(a.attempts[1]!.id)).submitted_by_sub).toBeNull();
  });

  test("an open sitting with no time limit holds every row: 409 session_open", async () => {
    const a = await seedSitting({ sittingStatus: "open", attempts: [{}, {}] });
    const res = await handIn(a.assessment.id, a.attempts.map((x) => x.id));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ ok: false, error: "session_open" });
    for (const attempt of a.attempts) {
      expect((await statusOf(attempt.id)).status).toBe("in_progress");
    }
  });

  test("an open sitting hands in only the attempts past their own deadline", async () => {
    const a = await seedSitting({
      sittingStatus: "open",
      timeLimitSeconds: 600,
      attempts: [{ startedMinutesAgo: 30 }, { startedMinutesAgo: 2 }],
    });
    const res = await handIn(a.assessment.id, a.attempts.map((x) => x.id));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.handed_in).toBe(1);
    expect(body.held_by_open_session).toBe(1);
    expect((await statusOf(a.attempts[0]!.id)).status).toBe("submitted");
    expect((await statusOf(a.attempts[1]!.id)).status).toBe("in_progress");
  });

  test("a second call hands in 0", async () => {
    const a = await seedSitting({ sittingStatus: "closed", attempts: [{}] });
    expect((await handIn(a.assessment.id, [a.attempts[0]!.id])).status).toBe(200);
    const body = await (await handIn(a.assessment.id, [a.attempts[0]!.id])).json();
    expect(body.handed_in).toBe(0);
    expect(body.skipped).toBe(1);
  });

  test("another teacher gets 404 and nothing changes", async () => {
    const a = await seedSitting({ sittingStatus: "closed", attempts: [{}] });
    mockSession = { sub: OTHER_OWNER, role: "staff" };
    expect((await handIn(a.assessment.id, [a.attempts[0]!.id])).status).toBe(404);
    expect((await statusOf(a.attempts[0]!.id)).status).toBe("in_progress");
  });

  test("a student session gets 403; no session 401", async () => {
    const a = await seedSitting({ sittingStatus: "closed", attempts: [{}] });
    mockSession = { sub: "student-sub", role: "student" };
    expect((await handIn(a.assessment.id, [a.attempts[0]!.id])).status).toBe(403);
    mockSession = null;
    expect((await handIn(a.assessment.id, [a.attempts[0]!.id])).status).toBe(401);
  });

  test("a malformed body or id is 400", async () => {
    const a = await seedSitting({ sittingStatus: "closed", attempts: [{}] });
    expect((await handIn(a.assessment.id, [])).status).toBe(400);
    expect((await handIn(a.assessment.id, ["nope"])).status).toBe(400);
    expect((await handIn("nope", [a.attempts[0]!.id])).status).toBe(400);
  });
});

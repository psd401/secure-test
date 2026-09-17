// "Give everyone more time": the per-attempt extension applied to a whole
// sitting. Same in-process mock harness and the same authorisation
// expectations (owner-only, 404 for a sitting that is not yours) as
// session-hand-in-all-api.test.ts — the two buttons sit on the same header and
// a caller must not be able to tell them apart.
//
// What is deliberately DIFFERENT from hand-in-all: the sitting's own state is
// no condition at all. Extending into tomorrow, after today's period closed,
// is the case the route exists for.
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
    throw new Error(`session-extend tests require the test DB DATABASE_URL; got: ${url}`);
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

const OWNER = "extend-all-teacher";
const OTHER_OWNER = "extend-all-other-teacher";

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
  /** Bind the attempt to NO sitting (the `--token` dev posture, the seeder). */
  detached?: boolean;
}

async function seedSitting(opts: {
  sittingStatus?: "open" | "closed";
  /** Past expiry, with the sitting still `open` — the third sitting state. */
  expired?: boolean;
  timeLimitSeconds?: number | null;
  attempts: SeedAttempt[];
}) {
  const db = getDb();
  const [assessment] = await db
    .insert(assessments)
    .values({
      owner_sub: OWNER,
      name: "Extend everyone",
      time_limit_seconds: opts.timeLimitSeconds ?? null,
    })
    .returning();
  await db.insert(items).values({
    assessment_id: assessment!.id,
    position: 0,
    type: "multiple_choice_single",
    stem: "Pick one",
    choices: [
      { id: "a", text: "A" },
      { id: "b", text: "B" },
    ],
    correct_choice_ids: ["a"],
  });

  const [sitting] = await db
    .insert(test_sessions)
    .values({
      assessment_id: assessment!.id,
      owner_sub: OWNER,
      code: `X${Math.floor(Math.random() * 100000)}`,
      status: opts.sittingStatus ?? "closed",
      expires_at: new Date(Date.now() + (opts.expired ? -3_600_000 : 3_600_000)),
    })
    .returning();

  const rows = [];
  for (const [i, spec] of opts.attempts.entries()) {
    const [student] = await db
      .insert(students)
      .values({ owner_sub: OWNER, ssid: `80${i}`, name: `Student ${i}` })
      .returning();
    const status = spec.status ?? "in_progress";
    const [attempt] = await db
      .insert(attempts)
      .values({
        assessment_id: assessment!.id,
        student_id: student!.id,
        test_session_id: spec.detached ? null : sitting!.id,
        status,
        submitted_at: status === "submitted" ? new Date() : null,
      })
      .returning();
    rows.push(attempt!);
  }

  return { assessment: assessment!, sitting: sitting!, attempts: rows };
}

const inMinutes = (n: number) => new Date(Date.now() + n * 60_000).toISOString();

async function extendAll(sessionId: string, endsAt?: string, raw?: string) {
  const { POST } = await import("../app/api/test-sessions/[sessionId]/extend/route");
  return POST(
    new Request(`http://localhost/api/test-sessions/${sessionId}/extend`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: raw ?? JSON.stringify({ ends_at: endsAt }),
    }),
    { params: Promise.resolve({ sessionId }) },
  );
}

async function rowOf(attemptId: string) {
  const [row] = await getDb().select().from(attempts).where(eq(attempts.id, attemptId));
  return row!;
}

describe("POST /api/test-sessions/[sessionId]/extend", () => {
  test("every in-progress attempt is extended; the submitted one is skipped", async () => {
    const s = await seedSitting({
      sittingStatus: "closed",
      timeLimitSeconds: 600,
      attempts: [{}, {}, { status: "submitted" }],
    });
    const endsAt = inMinutes(40);

    const res = await extendAll(s.sitting.id, endsAt);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.extended).toBe(2);
    expect(body.skipped).toBe(1);
    expect(body.attempts.map((a: { attempt_id: string }) => a.attempt_id).sort()).toEqual(
      [s.attempts[0]!.id, s.attempts[1]!.id].sort(),
    );

    expect((await rowOf(s.attempts[0]!.id)).deadline_override_at!.toISOString()).toBe(endsAt);
    expect((await rowOf(s.attempts[1]!.id)).deadline_override_at!.toISOString()).toBe(endsAt);
    // The submitted attempt is untouched — there is nothing to give time to.
    expect((await rowOf(s.attempts[2]!.id)).deadline_override_at).toBeNull();

    const events = await getDb().select().from(attempt_events);
    expect(events).toHaveLength(2);
    expect(new Set(events.map((e) => e.kind))).toEqual(new Set(["deadline_extended"]));
  });

  // The whole point: today's sitting is over and three students finish
  // tomorrow. A route that refused on a closed sitting would refuse this.
  test("a CLOSED sitting extends", async () => {
    const s = await seedSitting({ sittingStatus: "closed", attempts: [{}] });
    expect((await extendAll(s.sitting.id, inMinutes(60 * 24))).status).toBe(200);
    expect((await rowOf(s.attempts[0]!.id)).deadline_override_at).not.toBeNull();
  });

  test("an OPEN sitting extends", async () => {
    const s = await seedSitting({ sittingStatus: "open", attempts: [{}] });
    expect((await extendAll(s.sitting.id, inMinutes(30))).status).toBe(200);
    expect((await rowOf(s.attempts[0]!.id)).deadline_override_at).not.toBeNull();
  });

  test("an EXPIRED-but-open sitting extends", async () => {
    const s = await seedSitting({ sittingStatus: "open", expired: true, attempts: [{}] });
    expect((await extendAll(s.sitting.id, inMinutes(30))).status).toBe(200);
    expect((await rowOf(s.attempts[0]!.id)).deadline_override_at).not.toBeNull();
  });

  test("an attempt on no sitting is never touched", async () => {
    const s = await seedSitting({ attempts: [{}, { detached: true }] });
    const res = await extendAll(s.sitting.id, inMinutes(30));
    expect((await res.json()).extended).toBe(1);
    expect((await rowOf(s.attempts[1]!.id)).deadline_override_at).toBeNull();
  });

  test("re-applying the same instant is idempotent", async () => {
    const s = await seedSitting({ attempts: [{}, {}] });
    const endsAt = inMinutes(30);
    expect((await (await extendAll(s.sitting.id, endsAt)).json()).extended).toBe(2);
    const second = await (await extendAll(s.sitting.id, endsAt)).json();
    expect(second.extended).toBe(2);
    // Twice is the same deadline, not double the time: the override replaces.
    expect((await rowOf(s.attempts[0]!.id)).deadline_override_at!.toISOString()).toBe(endsAt);
  });

  test("a sitting with nothing in progress is a successful no-op, not an error", async () => {
    const s = await seedSitting({ attempts: [{ status: "submitted" }] });
    const body = await (await extendAll(s.sitting.id, inMinutes(30))).json();
    expect(body).toEqual({ ok: true, extended: 0, skipped: 1, attempts: [] });
  });

  test("an instant in the past is 400 ends_at_past and writes nothing", async () => {
    const s = await seedSitting({ attempts: [{}] });
    const res = await extendAll(s.sitting.id, inMinutes(-5));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: "ends_at_past" });
    expect((await rowOf(s.attempts[0]!.id)).deadline_override_at).toBeNull();
    expect(await getDb().select().from(attempt_events)).toHaveLength(0);
  });

  test("a missing or unparseable ends_at is 400 invalid_body", async () => {
    const s = await seedSitting({ attempts: [{}] });
    expect((await extendAll(s.sitting.id, undefined)).status).toBe(400);
    expect((await extendAll(s.sitting.id, "soon")).status).toBe(400);
    expect((await extendAll(s.sitting.id, undefined, "{")).status).toBe(400);
    expect((await rowOf(s.attempts[0]!.id)).deadline_override_at).toBeNull();
  });

  // Owner-only via the SITTING's owner_sub, and 404 rather than 403 — the
  // same posture as Close and Hand in everyone, so a caller cannot learn that
  // someone else's sitting exists.
  test("another teacher gets 404 and nothing changes", async () => {
    const s = await seedSitting({ attempts: [{}] });
    mockSession = { sub: OTHER_OWNER, role: "staff" };
    expect((await extendAll(s.sitting.id, inMinutes(30))).status).toBe(404);
    expect((await rowOf(s.attempts[0]!.id)).deadline_override_at).toBeNull();
  });

  test("a student session gets 403; no session 401", async () => {
    const s = await seedSitting({ attempts: [{}] });
    mockSession = { sub: "student-sub", role: "student" };
    expect((await extendAll(s.sitting.id, inMinutes(30))).status).toBe(403);
    mockSession = null;
    expect((await extendAll(s.sitting.id, inMinutes(30))).status).toBe(401);
  });

  test("an unknown id is 404, a malformed one 400", async () => {
    expect(
      (await extendAll("11111111-1111-4111-8111-111111111111", inMinutes(30))).status,
    ).toBe(404);
    expect((await extendAll("nope", inMinutes(30))).status).toBe(400);
  });
});

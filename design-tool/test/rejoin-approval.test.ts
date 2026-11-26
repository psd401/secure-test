// Working-time clock, slice 3 (docs/working-time-clock-design.md, D2,
// 3.1–3.3): rejoin approval. Pure rule first, then `admitJoin` and the
// teacher's "Let back in" against the test DB, then the delivery route end to
// end as the student (attempt-pass-back-api.test.ts's harness).
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { closeDb, getDb } from "../db/client";
import { assessments, attempt_events, attempts, items, students, test_sessions } from "../db/schema";
import { SESSION_COOKIE_NAME } from "../lib/auth/session";
import * as headersMod from "next/headers";
import * as sessionMod from "../lib/auth/session";
import {
  MID_SESSION_SECONDS,
  REJOIN_APPROVAL_SECONDS,
  admitJoin,
  approveRejoin,
  needsRejoinApproval,
} from "../lib/api/rejoinApproval";
import { passBackAttempt } from "../lib/api/passBackAttempt";
import { rejoinNote, studentState, type AttendanceRow } from "../app/dashboard/[id]/attendanceView";
import { STUDENT, TEACHER_EMAIL, clearRoster, seedRoster, staffPrincipal, studentPrincipal } from "./helpers/roster";

const NOW = new Date("2026-11-26T17:00:00.000Z");
const ago = (s: number) => new Date(NOW.getTime() - s * 1000);
const WORKING = { time_limit_seconds: 3600, time_limit_mode: "working" };

// ---- pure ------------------------------------------------------------------

describe("needsRejoinApproval", () => {
  const base = {
    status: "in_progress",
    time_limit_removed: false,
    practice: false,
    test_session_id: "s1",
    last_join_session_id: "s1",
    last_tick_at: ago(600),
    rejoin_approved_until: null,
  };

  test("back into the same session after leaving it: waits", () => {
    expect(needsRejoinApproval(base, WORKING, NOW)).toBe(true);
    expect(needsRejoinApproval({ ...base, last_tick_at: null }, WORKING, NOW)).toBe(true);
  });

  test("first join to a session, or since a pass back (3.1, 3.2): free", () => {
    expect(needsRejoinApproval({ ...base, last_join_session_id: "s0" }, WORKING, NOW)).toBe(false);
    expect(needsRejoinApproval({ ...base, last_join_session_id: null }, WORKING, NOW)).toBe(false);
  });

  test("a reload mid-session, a live approval, practice: free", () => {
    expect(needsRejoinApproval({ ...base, last_tick_at: ago(MID_SESSION_SECONDS) }, WORKING, NOW)).toBe(false);
    expect(needsRejoinApproval({ ...base, last_tick_at: ago(MID_SESSION_SECONDS + 1) }, WORKING, NOW)).toBe(true);
    expect(needsRejoinApproval({ ...base, rejoin_approved_until: ago(-60) }, WORKING, NOW)).toBe(false);
    expect(needsRejoinApproval({ ...base, rejoin_approved_until: ago(1) }, WORKING, NOW)).toBe(true);
    expect(needsRejoinApproval({ ...base, practice: true }, WORKING, NOW)).toBe(false);
  });

  test("only on the working-time clock", () => {
    expect(needsRejoinApproval(base, { time_limit_seconds: 3600, time_limit_mode: "wall" }, NOW)).toBe(false);
    expect(needsRejoinApproval(base, { time_limit_seconds: null, time_limit_mode: "working" }, NOW)).toBe(false);
    expect(needsRejoinApproval({ ...base, time_limit_removed: true }, WORKING, NOW)).toBe(false);
  });
});

describe("Monitor words", () => {
  test("a waiting student needs attention, with its line", () => {
    const row = { status: "in_progress", rejoin: "asked", alert: null, last_activity_at: null, last_lockdown_begin_at: null } as unknown as AttendanceRow;
    expect(studentState(row, NOW.getTime())).toBe("needs_attention");
    expect(rejoinNote("asked")).toBe("Asks to continue");
    expect(rejoinNote("approved")).toContain("10 min");
    expect(rejoinNote(null)).toBeNull();
  });
});

// ---- DB --------------------------------------------------------------------

const expectTestDb = () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("secure_test_design_tool_test")) {
    throw new Error(`rejoin-approval tests require the test DB DATABASE_URL; got: ${url}`);
  }
};

const OWNER = "rejoin-teacher";
type Principal = { sub: string; role: string; email?: string } | null;
let principal: Principal = staffPrincipal(OWNER);

mock.module("next/headers", () => ({
  ...headersMod,
  headers: async () => new Headers(),
  cookies: async () => ({
    get: (name: string) => (principal && name === SESSION_COOKIE_NAME ? { value: "x" } : undefined),
  }),
}));
mock.module("../lib/auth/session", () => ({
  ...sessionMod,
  readSessionFromCookies: async () => principal,
}));

let originalSecret: string | undefined;
beforeAll(async () => {
  expectTestDb();
  await seedRoster();
  originalSecret = process.env.DESIGN_TOOL_SESSION_SECRET;
  process.env.DESIGN_TOOL_SESSION_SECRET ||= "rejoin-test-secret-do-not-use";
});
afterEach(async () => {
  principal = staffPrincipal(OWNER);
  await getDb().execute(sql`truncate table assessments restart identity cascade`);
  await getDb().execute(sql`truncate table students restart identity cascade`);
});
afterAll(async () => {
  await clearRoster();
  await closeDb();
  if (originalSecret === undefined) delete process.env.DESIGN_TOOL_SESSION_SECRET;
  else process.env.DESIGN_TOOL_SESSION_SECRET = originalSecret;
});

let codeSeq = 0;
async function sitting(assessmentId: string) {
  const [s] = await getDb()
    .insert(test_sessions)
    .values({
      assessment_id: assessmentId,
      owner_sub: OWNER,
      owner_email: TEACHER_EMAIL,
      code: `RJ${(codeSeq++).toString().padStart(4, "0")}`,
      status: "open",
      expires_at: new Date(Date.now() + 60 * 60_000),
    })
    .returning();
  return s!;
}

async function scenario(mode: "working" | "wall" = "working") {
  const db = getDb();
  const [assessment] = await db
    .insert(assessments)
    .values({
      owner_sub: OWNER,
      owner_email: TEACHER_EMAIL,
      name: "Rejoin",
      status: "published",
      time_limit_seconds: 3600,
      time_limit_mode: mode,
    })
    .returning();
  await db.insert(items).values({ assessment_id: assessment!.id, position: 0, type: "essay", stem: "Explain" });
  const s = await sitting(assessment!.id);
  const [student] = await db
    .insert(students)
    .values({ owner_sub: OWNER, ssid: STUDENT.ssid, roster_ps_id: STUDENT.ps_id, name: STUDENT.name })
    .returning();
  const [attempt] = await db
    .insert(attempts)
    .values({
      assessment_id: assessment!.id,
      student_id: student!.id,
      test_session_id: s.id,
      status: "in_progress",
      started_at: new Date(Date.now() - 3_600_000),
      working_seconds: 600,
    })
    .returning();
  return { assessment: assessment!, sitting: s, attempt: attempt! };
}

const row = async (id: string) => (await getDb().select().from(attempts).where(eq(attempts.id, id)))[0]!;
const kinds = async (id: string) =>
  (await getDb().select().from(attempt_events).where(eq(attempt_events.attempt_id, id))).map((e) => e.kind);
const leave = (id: string) =>
  getDb().update(attempts).set({ last_tick_at: new Date(Date.now() - 10 * 60_000) }).where(eq(attempts.id, id));

describe("admitJoin", () => {
  test("first join is free and recorded; coming back after leaving waits, recorded once", async () => {
    const { assessment, sitting: s, attempt } = await scenario();
    expect(await admitJoin(getDb(), attempt, assessment, { enforce: true })).toBeNull();
    expect((await row(attempt.id)).last_join_session_id).toBe(s.id);

    await leave(attempt.id);
    for (let i = 0; i < 2; i++) {
      const res = await admitJoin(getDb(), await row(attempt.id), assessment, { enforce: true });
      expect(res?.status).toBe(409);
      expect(((await res!.json()) as { error: string }).error).toBe("rejoin_needs_approval");
    }
    expect((await row(attempt.id)).rejoin_requested_at).not.toBeNull();
    expect((await kinds(attempt.id)).filter((k) => k === "rejoin_requested")).toHaveLength(1);
  });

  test("Let back in admits the next join once; it is used up", async () => {
    const { assessment, attempt } = await scenario();
    await admitJoin(getDb(), attempt, assessment, { enforce: true });
    await leave(attempt.id);
    await admitJoin(getDb(), await row(attempt.id), assessment, { enforce: true }); // asks
    const approved = await approveRejoin(getDb(), await row(attempt.id), "rejoin-teacher");
    expect(approved.rejoin_approved_until!.getTime() - Date.now()).toBeGreaterThan((REJOIN_APPROVAL_SECONDS - 5) * 1000);
    expect(await admitJoin(getDb(), await row(attempt.id), assessment, { enforce: true })).toBeNull();
    const after = await row(attempt.id);
    expect(after.rejoin_approved_until).toBeNull();
    expect(after.rejoin_requested_at).toBeNull();
    // Used up: leaving again waits again.
    expect((await admitJoin(getDb(), after, assessment, { enforce: true }))?.status).toBe(409);
  });

  test("a new session (3.2) and a pass back (3.1) are free; old clients (3.3) are admitted", async () => {
    const { assessment, attempt } = await scenario();
    await admitJoin(getDb(), attempt, assessment, { enforce: true });
    await leave(attempt.id);
    // 3.3: no version header — admitted, and the join recorded.
    expect(await admitJoin(getDb(), await row(attempt.id), assessment, { enforce: false })).toBeNull();
    // 3.2: rebound to a new sitting.
    const s2 = await sitting(assessment.id);
    await getDb().update(attempts).set({ test_session_id: s2.id }).where(eq(attempts.id, attempt.id));
    expect(await admitJoin(getDb(), await row(attempt.id), assessment, { enforce: true })).toBeNull();
    expect((await row(attempt.id)).last_join_session_id).toBe(s2.id);
    // 3.1: handed in, passed back — the next join is free.
    await getDb().update(attempts).set({ status: "submitted", submitted_at: new Date() }).where(eq(attempts.id, attempt.id));
    await passBackAttempt(getDb(), await row(attempt.id), "rejoin-teacher");
    await leave(attempt.id);
    expect(await admitJoin(getDb(), await row(attempt.id), assessment, { enforce: true })).toBeNull();
  });

  test("a wall-clock test never waits", async () => {
    const { assessment, attempt } = await scenario("wall");
    await admitJoin(getDb(), attempt, assessment, { enforce: true });
    await leave(attempt.id);
    expect(await admitJoin(getDb(), await row(attempt.id), assessment, { enforce: true })).toBeNull();
  });
});

async function letBackIn(attemptId: string) {
  const { POST } = await import("../app/api/attempts/[attemptId]/let-back-in/route");
  return POST(new Request(`http://localhost/api/attempts/${attemptId}/let-back-in`, { method: "POST" }), {
    params: Promise.resolve({ attemptId }),
  });
}

async function getDelivery(assessmentId: string, withVersion = true) {
  const { GET } = await import("../app/api/assessments/[id]/delivery/route");
  return GET(
    new Request(`http://localhost/api/assessments/${assessmentId}/delivery`, {
      headers: withVersion ? { "x-securetest-version": "2.0.0" } : {},
    }),
    { params: Promise.resolve({ id: assessmentId }) as Promise<{ id: string }> },
  );
}

describe("POST let-back-in", () => {
  test("sets a 10-minute approval and records who; refused when handed in or on the wall clock", async () => {
    const { attempt } = await scenario();
    const res = await letBackIn(attempt.id);
    expect(res.status).toBe(200);
    expect((await row(attempt.id)).rejoin_approved_until).not.toBeNull();
    const [ev] = (await getDb().select().from(attempt_events).where(eq(attempt_events.attempt_id, attempt.id)));
    expect(ev!.kind).toBe("rejoin_approved");
    expect((ev!.detail as { by: string }).by).toBe(OWNER);

    await getDb().update(attempts).set({ status: "submitted", submitted_at: new Date() }).where(eq(attempts.id, attempt.id));
    expect(((await (await letBackIn(attempt.id)).json()) as { error: string }).error).toBe("not_in_progress");

    await getDb().execute(sql`truncate table assessments restart identity cascade`);
    await getDb().execute(sql`truncate table students restart identity cascade`);
    const wall = await scenario("wall");
    expect(((await (await letBackIn(wall.attempt.id)).json()) as { error: string }).error).toBe("not_working_time");
  });
});

describe("the delivery route, as the student", () => {
  test("join, leave, refused with 409; let back in; joins", async () => {
    const { assessment, attempt } = await scenario();
    principal = studentPrincipal();
    expect((await getDelivery(assessment.id)).status).toBe(200);
    await leave(attempt.id);
    const refused = await getDelivery(assessment.id);
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toBe("rejoin_needs_approval");
    // An old client (no version header) is not refused (3.3).
    expect((await getDelivery(assessment.id, false)).status).toBe(200);

    await leave(attempt.id);
    expect((await getDelivery(assessment.id)).status).toBe(409);
    principal = staffPrincipal(OWNER);
    expect((await letBackIn(attempt.id)).status).toBe(200);
    principal = studentPrincipal();
    expect((await getDelivery(assessment.id)).status).toBe(200);
  });
});

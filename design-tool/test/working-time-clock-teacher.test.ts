// Working-time clock, slice 2 (docs/working-time-clock-design.md): the
// teacher's levers — Extend time "+N minutes" (D3), pass back resuming the
// clock with an optional "+N minutes" (D4), the Monitor's used / left (D5),
// and the Settings clock choice (D1). Pure helpers first, then the routes
// in process against the test DB (attempt-pass-back-api.test.ts's harness).
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { closeDb, getDb } from "../db/client";
import { assessments, attempt_events, attempts, students, test_sessions } from "../db/schema";
import { SESSION_COOKIE_NAME } from "../lib/auth/session";
import * as headersMod from "next/headers";
import * as sessionMod from "../lib/auth/session";
import { reopenNeedsEndTime } from "../lib/api/attemptDeadline";
import { hasExactlyOneTarget, toExtendTarget } from "../lib/api/extendAttempt";
import { UpdateAssessmentBody } from "../lib/api/assessments";
import {
  defaultExtendChoice,
  extendHint,
  extendRequest,
  parseAddMinutes,
} from "../components/app/ExtendTimeControl";
import { passBackAddMinutesBody } from "../components/app/PassBackAddMinutes";
import { deadlineNote, workingTimeNote } from "../app/dashboard/[id]/attendanceView";
import { STUDENT, TEACHER_EMAIL, clearRoster, seedRoster, staffPrincipal } from "./helpers/roster";

// ---- pure ------------------------------------------------------------------

describe("Adjust time dialog on a working-time test (D3)", () => {
  test("opens on Add minutes; an untimed test still opens on No time limit", () => {
    expect(defaultExtendChoice(false, true)).toBe("add");
    expect(defaultExtendChoice(false, false)).toBe("deadline");
    expect(defaultExtendChoice(true, true)).toBe("no_limit");
  });

  test("posts add_minutes; a bad number posts nothing", () => {
    const t = { kind: "attempt" as const, attemptId: "a1" };
    expect(extendRequest(t, "add", "", "15")?.body).toEqual({ add_minutes: 15 });
    expect(extendRequest({ kind: "selected", sessionId: "s1", attemptIds: ["a1"] }, "add", "", "5")?.body)
      .toEqual({ add_minutes: 5, attempt_ids: ["a1"] });
    for (const bad of ["", "0", "-3", "2.5", "601", "ten"]) {
      expect(extendRequest(t, "add", "", bad)).toBeNull();
    }
    expect(parseAddMinutes(" 600 ")).toBe(600);
  });

  test("the hint says minutes, not a time", () => {
    expect(extendHint("sitting", "add")).toContain("more minutes");
    expect(extendHint("attempt", "add")).toBe("This student gets this many more minutes.");
  });
});

describe("the routes' body rule", () => {
  test("exactly one of ends_at, no_limit, add_minutes", () => {
    expect(hasExactlyOneTarget({ add_minutes: 10 })).toBe(true);
    expect(hasExactlyOneTarget({ add_minutes: 10, no_limit: true })).toBe(false);
    expect(hasExactlyOneTarget({ add_minutes: 10, ends_at: "2026-11-26T17:00:00Z" })).toBe(false);
    expect(hasExactlyOneTarget({})).toBe(false);
    expect(toExtendTarget({ add_minutes: 10 })).toEqual({ addSeconds: 600 });
  });

  test("a pass back on a working-time test needs no end time (D4)", () => {
    const a = { deadline_override_at: null, time_limit_removed: false };
    expect(reopenNeedsEndTime(a, { time_limit_seconds: 3600, time_limit_mode: "working" })).toBe(false);
    expect(reopenNeedsEndTime(a, { time_limit_seconds: 3600, time_limit_mode: "wall" })).toBe(true);
    expect(reopenNeedsEndTime({ ...a, deadline_override_at: new Date() }, { time_limit_seconds: null, time_limit_mode: "working" })).toBe(true);
  });

  test("the pass-back minutes field: blank adds nothing, a number adds, junk is refused", () => {
    expect(passBackAddMinutesBody("")).toEqual({});
    expect(passBackAddMinutesBody("20")).toEqual({ add_minutes: 20 });
    expect(passBackAddMinutesBody("0")).toBeNull();
  });

  test("Settings saves the clock; anything else is refused (D1)", () => {
    expect(UpdateAssessmentBody.safeParse({ time_limit_mode: "wall" }).success).toBe(true);
    expect(UpdateAssessmentBody.safeParse({ time_limit_mode: "working" }).success).toBe(true);
    expect(UpdateAssessmentBody.safeParse({ time_limit_mode: "sundial" }).success).toBe(false);
  });
});

describe("Monitor used / left (D5)", () => {
  test("minutes used round down, minutes left round up", () => {
    expect(workingTimeNote({ used_seconds: 725, left_seconds: 2875 })).toBe("12 of 60 min used · 48 left");
    expect(workingTimeNote({ used_seconds: 3570, left_seconds: 30 })).toBe("59 of 60 min used · 1 left");
  });

  test("the row note prefers the clock to the moving deadline; removal and time-out still win", () => {
    const w = { used_seconds: 600, left_seconds: 3000 };
    expect(deadlineNote("2026-11-26T18:00:00Z", false, new Date(), false, w)).toBe("10 of 60 min used · 50 left");
    expect(deadlineNote("2026-11-26T18:00:00Z", false, new Date(), true, w)).toBe("No time limit");
    expect(deadlineNote(null, true, new Date(), false, w)).toContain("Time ran out");
  });
});

// ---- routes ----------------------------------------------------------------

const expectTestDb = () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("secure_test_design_tool_test")) {
    throw new Error(`working-time-clock tests require the test DB DATABASE_URL; got: ${url}`);
  }
};

const OWNER = "clock-teacher";
const principal = staffPrincipal(OWNER);

mock.module("next/headers", () => ({
  ...headersMod,
  headers: async () => new Headers(),
  cookies: async () => ({
    get: (name: string) => (name === SESSION_COOKIE_NAME ? { value: "x" } : undefined),
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
  process.env.DESIGN_TOOL_SESSION_SECRET ||= "clock-test-secret-do-not-use";
});

afterEach(async () => {
  const db = getDb();
  await db.execute(sql`truncate table assessments restart identity cascade`);
  await db.execute(sql`truncate table students restart identity cascade`);
});

afterAll(async () => {
  await clearRoster();
  await closeDb();
  if (originalSecret === undefined) delete process.env.DESIGN_TOOL_SESSION_SECRET;
  else process.env.DESIGN_TOOL_SESSION_SECRET = originalSecret;
});

let codeSeq = 0;

async function scenario(opts: { mode?: "working" | "wall"; status?: "in_progress" | "submitted"; working?: number } = {}) {
  const db = getDb();
  const [assessment] = await db
    .insert(assessments)
    .values({
      owner_sub: OWNER,
      owner_email: TEACHER_EMAIL,
      name: "Clocked",
      status: "published",
      time_limit_seconds: 3600,
      time_limit_mode: opts.mode ?? "working",
    })
    .returning();
  const [sitting] = await db
    .insert(test_sessions)
    .values({
      assessment_id: assessment!.id,
      owner_sub: OWNER,
      owner_email: TEACHER_EMAIL,
      code: `WT${(codeSeq++).toString().padStart(4, "0")}`,
      status: "open",
      expires_at: new Date(Date.now() + 60 * 60_000),
    })
    .returning();
  const [student] = await db
    .insert(students)
    .values({ owner_sub: OWNER, ssid: STUDENT.ssid, roster_ps_id: STUDENT.ps_id, name: STUDENT.name })
    .returning();
  const status = opts.status ?? "in_progress";
  const [attempt] = await db
    .insert(attempts)
    .values({
      assessment_id: assessment!.id,
      student_id: student!.id,
      test_session_id: sitting!.id,
      status,
      started_at: new Date(Date.now() - 2 * 86_400_000),
      submitted_at: status === "submitted" ? new Date() : null,
      working_seconds: opts.working ?? 3600,
    })
    .returning();
  return { assessment: assessment!, sitting: sitting!, attempt: attempt! };
}

const post = (url: string, body: unknown) =>
  new Request(`http://localhost${url}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

async function extendOne(attemptId: string, body: unknown) {
  const { POST } = await import("../app/api/attempts/[attemptId]/extend/route");
  return POST(post(`/api/attempts/${attemptId}/extend`, body), { params: Promise.resolve({ attemptId }) });
}
async function extendSitting(sessionId: string, body: unknown) {
  const { POST } = await import("../app/api/test-sessions/[sessionId]/extend/route");
  return POST(post(`/api/test-sessions/${sessionId}/extend`, body), { params: Promise.resolve({ sessionId }) });
}
async function passBackOne(attemptId: string, body: unknown) {
  const { POST } = await import("../app/api/attempts/[attemptId]/pass-back/route");
  return POST(post(`/api/attempts/${attemptId}/pass-back`, body), { params: Promise.resolve({ attemptId }) });
}
async function passBackMany(id: string, body: unknown) {
  const { POST } = await import("../app/api/assessments/[id]/pass-back/route");
  return POST(post(`/api/assessments/${id}/pass-back`, body), { params: Promise.resolve({ id }) });
}
const row = async (id: string) => (await getDb().select().from(attempts).where(eq(attempts.id, id)))[0]!;
const events = async (id: string, kind: string) =>
  (await getDb().select().from(attempt_events).where(eq(attempt_events.attempt_id, id))).filter((e) => e.kind === kind);

describe("POST extend with add_minutes (D3)", () => {
  test("adds to the student's limit, twice adds twice, and records the minutes", async () => {
    const { attempt } = await scenario();
    expect((await extendOne(attempt.id, { add_minutes: 10 })).status).toBe(200);
    expect((await extendOne(attempt.id, { add_minutes: 5 })).status).toBe(200);
    const after = await row(attempt.id);
    expect(after.extension_seconds).toBe(900);
    expect(after.deadline_override_at).toBeNull();
    const ev = await events(attempt.id, "deadline_extended");
    expect(ev.map((e) => (e.detail as { add_seconds?: number }).add_seconds)).toEqual([600, 300]);
  });

  test("puts a removed limit back", async () => {
    const { attempt } = await scenario();
    await extendOne(attempt.id, { no_limit: true });
    await extendOne(attempt.id, { add_minutes: 10 });
    const after = await row(attempt.id);
    expect(after.time_limit_removed).toBe(false);
    expect(after.extension_seconds).toBe(600);
  });

  test("refused on a wall-clock test, and with a second target", async () => {
    const { attempt } = await scenario({ mode: "wall" });
    const res = await extendOne(attempt.id, { add_minutes: 10 });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("add_minutes_needs_working_time");
    expect((await extendOne(attempt.id, { add_minutes: 10, no_limit: true })).status).toBe(400);
    expect((await extendOne(attempt.id, { add_minutes: 0 })).status).toBe(400);
    expect((await row(attempt.id)).extension_seconds).toBe(0);
  });

  test("the sitting route adds for everyone in progress; refused on a wall-clock sitting", async () => {
    const { sitting, attempt } = await scenario();
    const res = await extendSitting(sitting.id, { add_minutes: 20 });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { extended: number }).extended).toBe(1);
    expect((await row(attempt.id)).extension_seconds).toBe(1200);

    await getDb().execute(sql`truncate table assessments restart identity cascade`);
    await getDb().execute(sql`truncate table students restart identity cascade`);
    const wall = await scenario({ mode: "wall" });
    expect((await extendSitting(wall.sitting.id, { add_minutes: 20 })).status).toBe(400);
  });
});

describe("pass back on a working-time test (D4)", () => {
  test("needs no end time and keeps the clock where it stopped", async () => {
    const { attempt } = await scenario({ status: "submitted", working: 1500 });
    const res = await passBackOne(attempt.id, {});
    expect(res.status).toBe(200);
    const after = await row(attempt.id);
    expect(after.status).toBe("in_progress");
    expect(after.working_seconds).toBe(1500);
    expect(after.extension_seconds).toBe(0);
  });

  test("optional minutes are added and recorded", async () => {
    const { attempt } = await scenario({ status: "submitted" });
    expect((await passBackOne(attempt.id, { add_minutes: 15 })).status).toBe(200);
    expect((await row(attempt.id)).extension_seconds).toBe(900);
    const [ev] = await events(attempt.id, "passed_back");
    expect((ev!.detail as { add_seconds?: number }).add_seconds).toBe(900);
  });

  test("minutes are refused on a wall-clock test, which still needs an end time", async () => {
    const { attempt } = await scenario({ mode: "wall", status: "submitted" });
    expect((await passBackOne(attempt.id, { add_minutes: 15 })).status).toBe(400);
    const res = await passBackOne(attempt.id, {});
    expect(((await res.json()) as { error: string }).error).toBe("ends_at_required");
  });

  test("an end time sent on a working-time test is ignored: the clock resumes, nothing is set", async () => {
    const { attempt } = await scenario({ status: "submitted", working: 1500 });
    const res = await passBackOne(attempt.id, { ends_at: new Date(Date.now() + 3_600_000).toISOString() });
    expect(res.status).toBe(200);
    const after = await row(attempt.id);
    expect(after.deadline_override_at).toBeNull();
    expect(after.extension_seconds).toBe(0);
    expect(after.working_seconds).toBe(1500);
  });

  test("a removed limit stays removed: minutes are refused for one, skipped in bulk", async () => {
    const { assessment, attempt } = await scenario({ status: "submitted" });
    await getDb().update(attempts).set({ time_limit_removed: true }).where(eq(attempts.id, attempt.id));
    const one = await passBackOne(attempt.id, { add_minutes: 10 });
    expect(((await one.json()) as { error: string }).error).toBe("add_minutes_needs_working_time");
    const many = await passBackMany(assessment.id, { attempt_ids: [attempt.id], add_minutes: 10 });
    expect(many.status).toBe(200);
    const after = await row(attempt.id);
    expect(after.status).toBe("in_progress");
    expect(after.time_limit_removed).toBe(true);
    expect(after.extension_seconds).toBe(0);
  });

  test("the bulk route adds the minutes to each", async () => {
    const { assessment, attempt } = await scenario({ status: "submitted" });
    const res = await passBackMany(assessment.id, { attempt_ids: [attempt.id], add_minutes: 5 });
    expect(res.status).toBe(200);
    expect((await row(attempt.id)).extension_seconds).toBe(300);
  });
});

describe("attendance rows carry used / left (D5)", () => {
  test("an in-progress working-time row has used and left", async () => {
    const { attendanceForSitting } = await import("../lib/api/sittingAttendance");
    const { sitting } = await scenario({ working: 1500 });
    const result = await attendanceForSitting(getDb(), sitting);
    const r = result.rows.find((x) => x.attempt_id !== null)!;
    expect(r.working_time).toEqual({ used_seconds: 1500, left_seconds: 2100 });
  });
});

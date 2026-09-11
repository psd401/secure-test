// Time limit (docs/time-limit-and-unfinished-attempts-design.md, D-4): the
// server refuses answers and student submits once the attempt's deadline plus
// its 30-second grace has passed, so the limit holds without trusting the
// client's clock. Assessments with no limit must be entirely untouched — half
// this file exists to prove that.
//
// Same harness as attempt-ingest-api.test.ts (a real student principal against
// the test DB); the routes are driven in process.
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { closeDb, getDb } from "../db/client";
import {
  assessments,
  attempts,
  items,
  response_uploads,
  responses,
  students,
} from "../db/schema";
import { SESSION_COOKIE_NAME } from "../lib/auth/session";
import * as sessionMod from "../lib/auth/session";
import {
  DEADLINE_GRACE_SECONDS,
  deadlineFor,
  isPastDeadline,
} from "../lib/api/attemptDeadline";
import { STUDENT, clearRoster, seedRoster, studentPrincipal } from "./helpers/roster";

const expectTestDb = () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("secure_test_design_tool_test")) {
    throw new Error(`deadline tests require the test DB DATABASE_URL; got: ${url}`);
  }
};

const OWNER = "deadline-teacher";
type Principal = { sub: string; role: string; email?: string } | null;
let principal: Principal = studentPrincipal();

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
}));

let originalSecret: string | undefined;
let originalStorageRoot: string | undefined;

beforeAll(async () => {
  expectTestDb();
  await seedRoster();
  originalSecret = process.env.DESIGN_TOOL_SESSION_SECRET;
  process.env.DESIGN_TOOL_SESSION_SECRET ||= "deadline-test-secret-do-not-use";
  originalStorageRoot = process.env.STORAGE_LOCAL_ROOT;
  process.env.STORAGE_LOCAL_ROOT = "./storage-test";
});

afterEach(async () => {
  principal = studentPrincipal();
  const db = getDb();
  await db.execute(sql`truncate table assessments restart identity cascade`);
  await db.execute(sql`truncate table students restart identity cascade`);
});

afterAll(async () => {
  await clearRoster();
  await closeDb();
  if (originalSecret === undefined) delete process.env.DESIGN_TOOL_SESSION_SECRET;
  else process.env.DESIGN_TOOL_SESSION_SECRET = originalSecret;
  if (originalStorageRoot === undefined) delete process.env.STORAGE_LOCAL_ROOT;
  else process.env.STORAGE_LOCAL_ROOT = originalStorageRoot;
});

/**
 * @param elapsedSeconds how long ago the attempt started. With a 600-second
 *   limit: 60 is comfortably inside, 610 is inside the 30-second grace, 700
 *   is past it.
 */
async function scenario(opts: {
  timeLimitSeconds: number | null;
  elapsedSeconds: number;
}) {
  const db = getDb();
  const [assessment] = await db
    .insert(assessments)
    .values({
      owner_sub: OWNER,
      name: "Timed",
      time_limit_seconds: opts.timeLimitSeconds,
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
        { id: "c1", text: "one" },
        { id: "c2", text: "two" },
      ],
      correct_choice_ids: ["c1"],
    })
    .returning();
  const [drawing] = await db
    .insert(items)
    .values({
      assessment_id: assessment!.id,
      position: 1,
      type: "drawing_upload",
      stem: "Sketch it",
    })
    .returning();
  const [student] = await db
    .insert(students)
    .values({
      owner_sub: OWNER,
      ssid: STUDENT.ssid,
      roster_ps_id: STUDENT.ps_id,
      name: STUDENT.name,
    })
    .returning();
  const [attempt] = await db
    .insert(attempts)
    .values({
      assessment_id: assessment!.id,
      student_id: student!.id,
      status: "in_progress",
      started_at: new Date(Date.now() - opts.elapsedSeconds * 1000),
    })
    .returning();
  return { assessment: assessment!, mc: mc!, drawing: drawing!, attempt: attempt! };
}

async function put(attemptId: string, itemId: string, response: unknown) {
  const { PUT } = await import("../app/api/attempts/[attemptId]/responses/[itemId]/route");
  return PUT(
    new Request("http://localhost/x", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ response }),
    }),
    { params: Promise.resolve({ attemptId, itemId }) },
  );
}

async function del(attemptId: string, itemId: string) {
  const { DELETE } = await import("../app/api/attempts/[attemptId]/responses/[itemId]/route");
  return DELETE(new Request("http://localhost/x", { method: "DELETE" }), {
    params: Promise.resolve({ attemptId, itemId }),
  });
}

async function submit(attemptId: string) {
  const { POST } = await import("../app/api/attempts/[attemptId]/submit/route");
  return POST(new Request("http://localhost/x", { method: "POST" }), {
    params: Promise.resolve({ attemptId }),
  });
}

/** The local-fs slot completion (the drawing path this app serves itself). */
async function uploadBytes(attemptId: string, itemId: string, uploadId: string) {
  const { PUT } = await import(
    "../app/api/attempts/[attemptId]/responses/[itemId]/upload/route"
  );
  return PUT(
    new Request(`http://localhost/x?upload_id=${uploadId}`, {
      method: "PUT",
      body: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]),
    }),
    { params: Promise.resolve({ attemptId, itemId }) },
  );
}

async function registerSlot(attemptId: string, itemId: string) {
  const [upload] = await getDb()
    .insert(response_uploads)
    .values({
      attempt_id: attemptId,
      item_id: itemId,
      storage_provider: "local-fs",
      storage_key: `responses/${attemptId}/${itemId}/${crypto.randomUUID()}`,
      content_type: "image/png",
      status: "pending",
    })
    .returning();
  return upload!;
}

const PICK = { type: "multiple_choice_single", choice_id: "c1" };

describe("deadlineFor / isPastDeadline", () => {
  const started = new Date("2026-09-11T17:00:00.000Z");

  test("no limit means no deadline, and nothing is ever past it", () => {
    expect(deadlineFor({ started_at: started }, { time_limit_seconds: null })).toBeNull();
    expect(isPastDeadline(new Date("2099-01-01T00:00:00Z"), null)).toBe(false);
  });

  test("a zero or negative limit is treated as no limit, not as already over", () => {
    expect(deadlineFor({ started_at: started }, { time_limit_seconds: 0 })).toBeNull();
    expect(deadlineFor({ started_at: started }, { time_limit_seconds: -5 })).toBeNull();
  });

  test("the deadline is started_at + the limit", () => {
    const deadline = deadlineFor({ started_at: started }, { time_limit_seconds: 1800 });
    expect(deadline!.toISOString()).toBe("2026-09-11T17:30:00.000Z");
  });

  test("the grace covers an autosave in flight at the buzzer", () => {
    const deadline = new Date("2026-09-11T17:30:00.000Z");
    const at = (s: number) => new Date(deadline.getTime() + s * 1000);
    expect(isPastDeadline(at(-1), deadline)).toBe(false);
    expect(isPastDeadline(at(0), deadline)).toBe(false);
    expect(isPastDeadline(at(DEADLINE_GRACE_SECONDS), deadline)).toBe(false);
    expect(isPastDeadline(at(DEADLINE_GRACE_SECONDS + 1), deadline)).toBe(true);
  });
});

describe("409 time_expired on the student plane", () => {
  test("a response saves comfortably inside the limit", async () => {
    const s = await scenario({ timeLimitSeconds: 600, elapsedSeconds: 60 });
    expect((await put(s.attempt.id, s.mc.id, PICK)).status).toBe(200);
  });

  test("a response saves inside the grace", async () => {
    const s = await scenario({ timeLimitSeconds: 600, elapsedSeconds: 610 });
    expect((await put(s.attempt.id, s.mc.id, PICK)).status).toBe(200);
  });

  test("a response after the grace is refused, and nothing is written", async () => {
    const s = await scenario({ timeLimitSeconds: 600, elapsedSeconds: 700 });
    const res = await put(s.attempt.id, s.mc.id, PICK);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ ok: false, error: "time_expired" });
    const rows = await getDb()
      .select()
      .from(responses)
      .where(eq(responses.attempt_id, s.attempt.id));
    expect(rows).toHaveLength(0);
  });

  test("withdrawing an answer after the grace is refused too", async () => {
    const s = await scenario({ timeLimitSeconds: 600, elapsedSeconds: 60 });
    expect((await put(s.attempt.id, s.mc.id, PICK)).status).toBe(200);
    await getDb()
      .update(attempts)
      .set({ started_at: new Date(Date.now() - 700_000) })
      .where(eq(attempts.id, s.attempt.id));
    expect((await del(s.attempt.id, s.mc.id)).status).toBe(409);
    const rows = await getDb()
      .select()
      .from(responses)
      .where(eq(responses.attempt_id, s.attempt.id));
    expect(rows).toHaveLength(1);
  });

  test("the drawing-slot completion is refused after the grace and accepted before it", async () => {
    const inTime = await scenario({ timeLimitSeconds: 600, elapsedSeconds: 60 });
    const okSlot = await registerSlot(inTime.attempt.id, inTime.drawing.id);
    expect(
      (await uploadBytes(inTime.attempt.id, inTime.drawing.id, okSlot.id)).status,
    ).toBe(200);

    await getDb()
      .update(attempts)
      .set({ started_at: new Date(Date.now() - 700_000) })
      .where(eq(attempts.id, inTime.attempt.id));
    const lateSlot = await registerSlot(inTime.attempt.id, inTime.drawing.id);
    const res = await uploadBytes(inTime.attempt.id, inTime.drawing.id, lateSlot.id);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("time_expired");
    const [row] = await getDb()
      .select()
      .from(response_uploads)
      .where(eq(response_uploads.id, lateSlot.id));
    expect(row!.status).toBe("pending");
  });

  // D-2: handing in after time is the TEACHER's call — the hand-in route is
  // the door that stays open.
  test("the student's own submit is refused after the grace and the attempt stays in progress", async () => {
    const s = await scenario({ timeLimitSeconds: 600, elapsedSeconds: 700 });
    const res = await submit(s.attempt.id);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ ok: false, error: "time_expired" });
    const [row] = await getDb().select().from(attempts).where(eq(attempts.id, s.attempt.id));
    expect(row!.status).toBe("in_progress");
    expect(row!.submitted_at).toBeNull();
  });

  test("the student's own submit inside the grace still works", async () => {
    const s = await scenario({ timeLimitSeconds: 600, elapsedSeconds: 610 });
    expect((await submit(s.attempt.id)).status).toBe(200);
  });
});

describe("an assessment with no time limit is untouched", () => {
  test("responses, withdrawals and submits all work hours in", async () => {
    const s = await scenario({ timeLimitSeconds: null, elapsedSeconds: 60 * 60 * 8 });
    expect((await put(s.attempt.id, s.mc.id, PICK)).status).toBe(200);
    expect((await del(s.attempt.id, s.mc.id)).status).toBe(204);
    const slot = await registerSlot(s.attempt.id, s.drawing.id);
    expect((await uploadBytes(s.attempt.id, s.drawing.id, slot.id)).status).toBe(200);
    expect((await submit(s.attempt.id)).status).toBe(200);
  });
});

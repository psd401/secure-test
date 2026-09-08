// Roadmap 2026-09, finding of the 2026-09-07 signed-build run: a teacher
// could not delete an attempt, so a student who had handed in could never sit
// the same assessment again. These tests cover DELETE /api/attempts/[attemptId]
// — the same in-process mock harness as response-upload-view.test.ts.
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { closeDb, getDb } from "../db/client";
import {
  assessments,
  attempt_deletions,
  attempt_events,
  attempts,
  items,
  response_uploads,
  responses,
  scores,
  students,
  test_sessions,
} from "../db/schema";
import { SESSION_COOKIE_NAME } from "../lib/auth/session";
import * as sessionMod from "../lib/auth/session";
import { localFsProvider } from "../lib/storage/localFsProvider";

const expectTestDb = () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("secure_test_design_tool_test")) {
    throw new Error(`attempt-delete tests require the test DB DATABASE_URL; got: ${url}`);
  }
};

let mockSession: { sub: string; role: string } | null = null;
let originalSessionSecret: string | undefined;
let originalRoot: string | undefined;

mock.module("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({
    get: (name: string) => (mockSession && name === SESSION_COOKIE_NAME ? { value: "x" } : undefined),
  }),
}));

mock.module("../lib/auth/session", () => ({
  ...sessionMod,
  readSessionFromCookies: async () => mockSession,
}));

const OWNER = "attempt-delete-teacher";
const OTHER_OWNER = "attempt-delete-other-teacher";
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

beforeAll(() => {
  expectTestDb();
  originalSessionSecret = process.env.DESIGN_TOOL_SESSION_SECRET;
  process.env.DESIGN_TOOL_SESSION_SECRET = "test-session-secret-do-not-use";
  originalRoot = process.env.STORAGE_LOCAL_ROOT;
  process.env.STORAGE_LOCAL_ROOT = "./storage-test";
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
  if (originalRoot === undefined) delete process.env.STORAGE_LOCAL_ROOT;
  else process.env.STORAGE_LOCAL_ROOT = originalRoot;
});

/**
 * One attempt with everything that hangs off it: a scored MC response, a
 * complete drawing upload with real bytes on disk, and two events — so the
 * cascade and the storage delete are both observable.
 */
async function seedAttempt(opts: {
  status: "in_progress" | "submitted";
  sittingStatus?: "open" | "closed";
}) {
  const db = getDb();
  const [assessment] = await db
    .insert(assessments)
    .values({ owner_sub: OWNER, name: "Delete me" })
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
  const [drawing] = await db
    .insert(items)
    .values({ assessment_id: assessment!.id, position: 1, type: "drawing_upload", stem: "Sketch it" })
    .returning();
  const [student] = await db
    .insert(students)
    .values({ owner_sub: OWNER, ssid: "999", name: "Delete Student" })
    .returning();

  let sittingId: string | null = null;
  if (opts.sittingStatus) {
    const [sitting] = await db
      .insert(test_sessions)
      .values({
        assessment_id: assessment!.id,
        owner_sub: OWNER,
        code: `D${Math.floor(Math.random() * 100000)}`,
        status: opts.sittingStatus,
        expires_at: new Date(Date.now() + 3_600_000),
      })
      .returning();
    sittingId = sitting!.id;
  }

  const [attempt] = await db
    .insert(attempts)
    .values({
      assessment_id: assessment!.id,
      student_id: student!.id,
      test_session_id: sittingId,
      status: opts.status,
      submitted_at: opts.status === "submitted" ? new Date() : null,
    })
    .returning();

  const [mcResponse] = await db
    .insert(responses)
    .values({ attempt_id: attempt!.id, item_id: mc!.id, response: { type: "multiple_choice_single", choice_id: "a" } })
    .returning();
  await db.insert(scores).values({
    response_id: mcResponse!.id,
    method: "auto",
    points: 1,
    max_points: 1,
    scorer: "auto",
    status: "final",
  });

  const storageKey = `responses/${attempt!.id}/${drawing!.id}/test-object`;
  await localFsProvider.put({ id: storageKey, bytes: PNG_BYTES, content_type: "image/png" });
  const [upload] = await db
    .insert(response_uploads)
    .values({
      attempt_id: attempt!.id,
      item_id: drawing!.id,
      storage_provider: "local-fs",
      storage_key: storageKey,
      content_type: "image/png",
      status: "complete",
    })
    .returning();
  await db.insert(responses).values({
    attempt_id: attempt!.id,
    item_id: drawing!.id,
    response: { type: "drawing_upload", upload_id: upload!.id },
  });

  await db.insert(attempt_events).values([
    { attempt_id: attempt!.id, kind: "lockdown_begin", at: new Date("2026-09-08T16:00:00Z") },
    { attempt_id: attempt!.id, kind: "focus_loss", at: new Date("2026-09-08T16:05:00Z") },
  ]);

  return { assessment: assessment!, student: student!, attempt: attempt!, storageKey };
}

async function deleteAttempt(attemptId: string) {
  const { DELETE } = await import("../app/api/attempts/[attemptId]/route");
  return DELETE(new Request(`http://localhost/api/attempts/${attemptId}`, { method: "DELETE" }), {
    params: Promise.resolve({ attemptId }),
  });
}

async function countRows(attemptId: string) {
  const db = getDb();
  const [a] = await db.select().from(attempts).where(eq(attempts.id, attemptId));
  const r = await db.select().from(responses).where(eq(responses.attempt_id, attemptId));
  const u = await db.select().from(response_uploads).where(eq(response_uploads.attempt_id, attemptId));
  const e = await db.select().from(attempt_events).where(eq(attempt_events.attempt_id, attemptId));
  const s = await db.select().from(scores);
  return { attempt: a, responses: r.length, uploads: u.length, events: e.length, scores: s.length };
}

describe("DELETE /api/attempts/[attemptId]", () => {
  test("the owner deletes a submitted attempt: rows, scores, uploads, events, bytes gone; audit row written", async () => {
    const s = await seedAttempt({ status: "submitted" });
    expect(existsSync(join("./storage-test", s.storageKey))).toBe(true);
    const before = await countRows(s.attempt.id);
    expect(before).toMatchObject({ responses: 2, uploads: 1, events: 2, scores: 1 });

    const res = await deleteAttempt(s.attempt.id);
    expect(res.status).toBe(204);

    const after = await countRows(s.attempt.id);
    expect(after.attempt).toBeUndefined();
    expect(after).toMatchObject({ responses: 0, uploads: 0, events: 0, scores: 0 });
    expect(existsSync(join("./storage-test", s.storageKey))).toBe(false);

    const db = getDb();
    const [audit] = await db
      .select()
      .from(attempt_deletions)
      .where(eq(attempt_deletions.attempt_id, s.attempt.id));
    expect(audit).toMatchObject({
      assessment_id: s.assessment.id,
      student_id: s.student.id,
      deleted_by_sub: OWNER,
      attempt_status: "submitted",
      response_count: 2,
      upload_count: 1,
      event_count: 2,
    });
    expect(audit!.attempt_submitted_at).not.toBeNull();
  });

  test("the next join creates a fresh attempt", async () => {
    const s = await seedAttempt({ status: "submitted" });
    expect((await deleteAttempt(s.attempt.id)).status).toBe(204);
    const db = getDb();
    const [fresh] = await db
      .insert(attempts)
      .values({ assessment_id: s.assessment.id, student_id: s.student.id })
      .returning();
    expect(fresh!.id).not.toBe(s.attempt.id);
    expect(fresh!.status).toBe("in_progress");
  });

  test("an in-progress attempt on an OPEN session is refused with 409", async () => {
    const s = await seedAttempt({ status: "in_progress", sittingStatus: "open" });
    const res = await deleteAttempt(s.attempt.id);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ ok: false, error: "session_open" });
    expect((await countRows(s.attempt.id)).attempt).toBeDefined();
  });

  test("an in-progress attempt on a CLOSED session deletes", async () => {
    const s = await seedAttempt({ status: "in_progress", sittingStatus: "closed" });
    expect((await deleteAttempt(s.attempt.id)).status).toBe(204);
    expect((await countRows(s.attempt.id)).attempt).toBeUndefined();
  });

  test("an in-progress attempt with no session deletes", async () => {
    const s = await seedAttempt({ status: "in_progress" });
    expect((await deleteAttempt(s.attempt.id)).status).toBe(204);
  });

  test("a submitted attempt deletes even while its session is open", async () => {
    const s = await seedAttempt({ status: "submitted", sittingStatus: "open" });
    expect((await deleteAttempt(s.attempt.id)).status).toBe(204);
  });

  test("another teacher gets 403 and nothing changes", async () => {
    const s = await seedAttempt({ status: "submitted" });
    mockSession = { sub: OTHER_OWNER, role: "staff" };
    expect((await deleteAttempt(s.attempt.id)).status).toBe(403);
    expect((await countRows(s.attempt.id)).attempt).toBeDefined();
    expect(existsSync(join("./storage-test", s.storageKey))).toBe(true);
  });

  test("a student session gets 403; no session 401", async () => {
    const s = await seedAttempt({ status: "submitted" });
    mockSession = { sub: "student-sub", role: "student" };
    expect((await deleteAttempt(s.attempt.id)).status).toBe(403);
    mockSession = null;
    expect((await deleteAttempt(s.attempt.id)).status).toBe(401);
  });

  test("an unknown id is 404, a malformed one 400", async () => {
    expect((await deleteAttempt("11111111-1111-4111-8111-111111111111")).status).toBe(404);
    expect((await deleteAttempt("nope")).status).toBe(400);
  });
});

// On-demand peek P1 (docs/on-demand-peek-design.md): the request cycle's
// server side — auth matrix, rate limit, replace-on-re-request, pending TTL,
// delivery, delete-on-read, and the image sweep.
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { closeDb, getDb } from "../db/client";
import { assessments, attempts, peek_requests, students } from "../db/schema";
import { SESSION_COOKIE_NAME } from "../lib/auth/session";
import * as sessionMod from "../lib/auth/session";
import {
  OTHER_STUDENT,
  STUDENT,
  TEACHER_EMAIL,
  clearRoster,
  seedRoster,
  staffPrincipal,
  studentPrincipal,
} from "./helpers/roster";

const expectTestDb = () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("secure_test_design_tool_test")) {
    throw new Error(`peek tests require the test DB; got: ${url}`);
  }
};

const TEACHER = "peek-teacher";

type Principal = { sub: string; role: string; email?: string } | null;
let principal: Principal = null;

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

beforeAll(async () => {
  expectTestDb();
  await seedRoster();
});

afterEach(async () => {
  principal = null;
  const db = getDb();
  await db.execute(sql`truncate table assessments restart identity cascade`);
  await db.execute(sql`truncate table students restart identity cascade`);
});

afterAll(async () => {
  await clearRoster();
  await closeDb();
});

async function seedAssessment(owner = TEACHER) {
  const [row] = await getDb()
    .insert(assessments)
    .values({ owner_sub: owner, name: "Peek", status: "published" })
    .returning();
  if (!row) throw new Error("seed failed");
  return row;
}

/** Overlay row bound to the roster student, plus an attempt. */
async function seedAttempt(
  assessmentId: string,
  rosterPsId: string,
  opts: { status?: "in_progress" | "submitted"; owner?: string } = {},
) {
  const db = getDb();
  const owner = opts.owner ?? TEACHER;
  const status = opts.status ?? "in_progress";
  const [st] = await db
    .insert(students)
    .values({ owner_sub: owner, roster_ps_id: rosterPsId, name: `overlay ${rosterPsId}` })
    .returning();
  const [attempt] = await db
    .insert(attempts)
    .values({
      assessment_id: assessmentId,
      student_id: st!.id,
      status,
      submitted_at: status === "submitted" ? new Date() : null,
    })
    .returning();
  return attempt!;
}

async function postPeek(attemptId: string) {
  const { POST } = await import("../app/api/attempts/[attemptId]/peek/route");
  return POST(new Request(`http://localhost/api/attempts/${attemptId}/peek`, { method: "POST" }), {
    params: Promise.resolve({ attemptId }),
  });
}

async function getPeek(attemptId: string) {
  const { GET } = await import("../app/api/attempts/[attemptId]/peek/pending/route");
  return GET(new Request(`http://localhost/api/attempts/${attemptId}/peek/pending`), {
    params: Promise.resolve({ attemptId }),
  });
}

async function postImage(attemptId: string, peekId: string, image = "aGVsbG8=") {
  const { POST } = await import("../app/api/attempts/[attemptId]/peek/upload/route");
  return POST(
    new Request(`http://localhost/api/attempts/${attemptId}/peek/upload`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ peek_id: peekId, image_base64: image }),
    }),
    { params: Promise.resolve({ attemptId }) },
  );
}

async function getImage(attemptId: string) {
  const { GET } = await import("../app/api/attempts/[attemptId]/peek/image/route");
  return GET(new Request(`http://localhost/api/attempts/${attemptId}/peek/image`), {
    params: Promise.resolve({ attemptId }),
  });
}

/** The full happy path up to a delivered image, returning the peek id. */
async function deliverOne(attemptId: string): Promise<string> {
  principal = staffPrincipal(TEACHER, TEACHER_EMAIL);
  const created = await postPeek(attemptId);
  expect(created.status).toBe(201);
  const { peek } = (await created.json()) as { peek: { id: string } };
  principal = studentPrincipal(STUDENT.email);
  expect((await postImage(attemptId, peek.id)).status).toBe(201);
  principal = null;
  return peek.id;
}

describe("POST /api/attempts/:id/peek", () => {
  test("owner creates a request; student sees it pending", async () => {
    const a = await seedAssessment();
    const attempt = await seedAttempt(a.id, STUDENT.ps_id);

    principal = staffPrincipal(TEACHER, TEACHER_EMAIL);
    const res = await postPeek(attempt.id);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { peek: { id: string } };

    principal = studentPrincipal(STUDENT.email);
    const seen = await getPeek(attempt.id);
    expect(seen.status).toBe(200);
    const { pending } = (await seen.json()) as { pending: { id: string } | null };
    expect(pending?.id).toBe(body.peek.id);
  });

  test("another teacher is forbidden; unknown attempt is 404", async () => {
    const a = await seedAssessment();
    const attempt = await seedAttempt(a.id, STUDENT.ps_id);

    principal = staffPrincipal("someone-else", "other@psd401.net");
    expect((await postPeek(attempt.id)).status).toBe(403);

    principal = staffPrincipal(TEACHER, TEACHER_EMAIL);
    expect((await postPeek("00000000-0000-0000-0000-000000000000")).status).toBe(404);
  });

  test("a submitted attempt has no screen to peek", async () => {
    const a = await seedAssessment();
    const attempt = await seedAttempt(a.id, STUDENT.ps_id, { status: "submitted" });
    principal = staffPrincipal(TEACHER, TEACHER_EMAIL);
    expect((await postPeek(attempt.id)).status).toBe(409);
  });

  test("rate limit: a second request inside 10 s answers 429", async () => {
    const a = await seedAssessment();
    const attempt = await seedAttempt(a.id, STUDENT.ps_id);
    principal = staffPrincipal(TEACHER, TEACHER_EMAIL);
    expect((await postPeek(attempt.id)).status).toBe(201);
    expect((await postPeek(attempt.id)).status).toBe(429);
  });

  test("re-request after the limit replaces the pending row", async () => {
    const a = await seedAssessment();
    const attempt = await seedAttempt(a.id, STUDENT.ps_id);
    const db = getDb();

    principal = staffPrincipal(TEACHER, TEACHER_EMAIL);
    const first = await postPeek(attempt.id);
    const firstId = ((await first.json()) as { peek: { id: string } }).peek.id;
    // Age the first request past the rate limit so the second is admitted.
    await db
      .update(peek_requests)
      .set({ requested_at: new Date(Date.now() - 11_000) })
      .where(eq(peek_requests.id, firstId));

    const second = await postPeek(attempt.id);
    expect(second.status).toBe(201);

    const rows = await db
      .select()
      .from(peek_requests)
      .where(eq(peek_requests.attempt_id, attempt.id));
    expect(rows.length).toBe(1);
    expect(rows[0]!.id).not.toBe(firstId);
  });
});

describe("GET /api/attempts/:id/peek/pending (student poll)", () => {
  test("another student's attempt is a 404; no pending is null", async () => {
    const a = await seedAssessment();
    const attempt = await seedAttempt(a.id, STUDENT.ps_id);

    principal = studentPrincipal(OTHER_STUDENT.email);
    expect((await getPeek(attempt.id)).status).toBe(404);

    principal = studentPrincipal(STUDENT.email);
    const res = await getPeek(attempt.id);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { pending: unknown }).pending).toBeNull();
  });

  test("a request older than the pending TTL is not offered", async () => {
    const a = await seedAssessment();
    const attempt = await seedAttempt(a.id, STUDENT.ps_id);
    const db = getDb();

    principal = staffPrincipal(TEACHER, TEACHER_EMAIL);
    const created = await postPeek(attempt.id);
    const id = ((await created.json()) as { peek: { id: string } }).peek.id;
    await db
      .update(peek_requests)
      .set({ requested_at: new Date(Date.now() - 31_000) })
      .where(eq(peek_requests.id, id));

    principal = studentPrincipal(STUDENT.email);
    const res = await getPeek(attempt.id);
    expect(((await res.json()) as { pending: unknown }).pending).toBeNull();
  });
});

describe("POST /api/attempts/:id/peek/upload", () => {
  test("delivery stores the image and stamps delivered_at", async () => {
    const a = await seedAssessment();
    const attempt = await seedAttempt(a.id, STUDENT.ps_id);
    const peekId = await deliverOne(attempt.id);

    const [row] = await getDb()
      .select()
      .from(peek_requests)
      .where(eq(peek_requests.id, peekId));
    expect(row!.delivered_at).not.toBeNull();
    expect(row!.image_base64).toBe("aGVsbG8=");
  });

  test("wrong student 404; unknown peek 404; double delivery 404", async () => {
    const a = await seedAssessment();
    const attempt = await seedAttempt(a.id, STUDENT.ps_id);

    principal = staffPrincipal(TEACHER, TEACHER_EMAIL);
    const created = await postPeek(attempt.id);
    const id = ((await created.json()) as { peek: { id: string } }).peek.id;

    principal = studentPrincipal(OTHER_STUDENT.email);
    expect((await postImage(attempt.id, id)).status).toBe(404);

    principal = studentPrincipal(STUDENT.email);
    expect((await postImage(attempt.id, "00000000-0000-0000-0000-000000000000")).status).toBe(404);
    expect((await postImage(attempt.id, id)).status).toBe(201);
    expect((await postImage(attempt.id, id)).status).toBe(404);
  });

  test("a stale pending request refuses the late upload", async () => {
    const a = await seedAssessment();
    const attempt = await seedAttempt(a.id, STUDENT.ps_id);
    const db = getDb();

    principal = staffPrincipal(TEACHER, TEACHER_EMAIL);
    const created = await postPeek(attempt.id);
    const id = ((await created.json()) as { peek: { id: string } }).peek.id;
    await db
      .update(peek_requests)
      .set({ requested_at: new Date(Date.now() - 31_000) })
      .where(eq(peek_requests.id, id));

    principal = studentPrincipal(STUDENT.email);
    expect((await postImage(attempt.id, id)).status).toBe(404);
  });
});

describe("GET /api/attempts/:id/peek/image (teacher collect)", () => {
  test("pending before delivery, ready exactly once, then none", async () => {
    const a = await seedAssessment();
    const attempt = await seedAttempt(a.id, STUDENT.ps_id);

    principal = staffPrincipal(TEACHER, TEACHER_EMAIL);
    await postPeek(attempt.id);
    let res = await getImage(attempt.id);
    expect(((await res.json()) as { status: string }).status).toBe("pending");

    principal = studentPrincipal(STUDENT.email);
    const [pendingRow] = await getDb()
      .select()
      .from(peek_requests)
      .where(eq(peek_requests.attempt_id, attempt.id));
    await postImage(attempt.id, pendingRow!.id);

    principal = staffPrincipal(TEACHER, TEACHER_EMAIL);
    res = await getImage(attempt.id);
    const ready = (await res.json()) as { status: string; image_base64?: string };
    expect(ready.status).toBe("ready");
    expect(ready.image_base64).toBe("aGVsbG8=");

    // Delete-on-read: the second collect finds nothing, and the audit row
    // survives with the image gone.
    res = await getImage(attempt.id);
    expect(((await res.json()) as { status: string }).status).toBe("none");
    const [audit] = await getDb()
      .select()
      .from(peek_requests)
      .where(eq(peek_requests.attempt_id, attempt.id));
    expect(audit!.viewed_at).not.toBeNull();
    expect(audit!.image_base64).toBeNull();
    expect(audit!.requested_by).toBe(TEACHER);
  });

  test("an unread image past the TTL is swept, not served", async () => {
    const a = await seedAssessment();
    const attempt = await seedAttempt(a.id, STUDENT.ps_id);
    const db = getDb();
    const peekId = await deliverOne(attempt.id);
    await db
      .update(peek_requests)
      .set({ delivered_at: new Date(Date.now() - 61_000) })
      .where(eq(peek_requests.id, peekId));

    principal = staffPrincipal(TEACHER, TEACHER_EMAIL);
    const res = await getImage(attempt.id);
    expect(((await res.json()) as { status: string }).status).toBe("none");
    const [row] = await db.select().from(peek_requests).where(eq(peek_requests.id, peekId));
    expect(row!.image_base64).toBeNull();
    expect(row!.viewed_at).toBeNull();
  });

  test("another teacher is forbidden", async () => {
    const a = await seedAssessment();
    const attempt = await seedAttempt(a.id, STUDENT.ps_id);
    await deliverOne(attempt.id);
    principal = staffPrincipal("someone-else", "other@psd401.net");
    expect((await getImage(attempt.id)).status).toBe(403);
  });
});

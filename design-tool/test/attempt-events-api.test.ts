// Slice 91: client-reported attempt events — the route, and how they fold
// into the attendance payload the Sittings tab and monitor poll.
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { closeDb, getDb } from "../db/client";
import { assessments, attempt_events, attempts, students } from "../db/schema";
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
    throw new Error(`attempt-events tests require the test DB; got: ${url}`);
  }
};

const TEACHER = "events-teacher";

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
    .values({ owner_sub: owner, name: "Events", status: "published" })
    .returning();
  if (!row) throw new Error("seed failed");
  return row;
}

async function createSitting(assessmentId: string) {
  principal = staffPrincipal(TEACHER, TEACHER_EMAIL);
  const { POST } = await import("../app/api/test-sessions/route");
  const res = await POST(
    new Request("http://localhost/api/test-sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ assessment_id: assessmentId, duration_minutes: 60 }),
    }),
  );
  expect(res.status).toBe(201);
  principal = null;
  return ((await res.json()) as { test_session: { id: string } }).test_session;
}

/** Overlay row bound to the roster student, plus an attempt. */
async function seedAttempt(
  assessmentId: string,
  rosterPsId: string,
  opts: { sessionId?: string; status?: "in_progress" | "submitted"; owner?: string } = {},
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
      test_session_id: opts.sessionId ?? null,
      status,
      submitted_at: status === "submitted" ? new Date() : null,
    })
    .returning();
  return attempt!;
}

async function postEvent(attemptId: string, body: unknown) {
  const { POST } = await import("../app/api/attempts/[attemptId]/events/route");
  return POST(
    new Request(`http://localhost/api/attempts/${attemptId}/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ attemptId }) },
  );
}

async function attendance(sessionId: string) {
  principal = staffPrincipal(TEACHER, TEACHER_EMAIL);
  const { GET } = await import("../app/api/test-sessions/[sessionId]/attendance/route");
  const res = await GET(new Request("http://localhost/x"), {
    params: Promise.resolve({ sessionId }),
  });
  expect(res.status).toBe(200);
  principal = null;
  return (await res.json()) as {
    rows: {
      ps_id: string;
      last_activity_at: string | null;
      last_event: { kind: string; at: string } | null;
      alert: { kind: string; at: string } | null;
    }[];
  };
}

describe("POST /api/attempts/:attemptId/events", () => {
  test("records an event with a server-stamped time", async () => {
    const assessment = await seedAssessment();
    const attempt = await seedAttempt(assessment.id, STUDENT.ps_id);
    principal = studentPrincipal(STUDENT.email);

    const before = Date.now();
    const res = await postEvent(attempt.id, { kind: "quit", detail: { via: "cmd-q" } });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { ok: boolean; event: { id: string; kind: string; at: string } };
    expect(body.event.kind).toBe("quit");
    expect(new Date(body.event.at).getTime()).toBeGreaterThanOrEqual(before - 1000);

    const rows = await getDb()
      .select()
      .from(attempt_events)
      .where(eq(attempt_events.attempt_id, attempt.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe("quit");
    expect(rows[0]!.detail).toEqual({ via: "cmd-q" });
  });

  test("refuses an unknown kind and stores nothing", async () => {
    const assessment = await seedAssessment();
    const attempt = await seedAttempt(assessment.id, STUDENT.ps_id);
    principal = studentPrincipal(STUDENT.email);

    const res = await postEvent(attempt.id, { kind: "coffee_break" });
    expect(res.status).toBe(400);
    const rows = await getDb()
      .select()
      .from(attempt_events)
      .where(eq(attempt_events.attempt_id, attempt.id));
    expect(rows).toHaveLength(0);
  });

  test("another student's attempt answers 404", async () => {
    const assessment = await seedAssessment();
    const attempt = await seedAttempt(assessment.id, STUDENT.ps_id);
    principal = studentPrincipal(OTHER_STUDENT.email);

    const res = await postEvent(attempt.id, { kind: "quit" });
    expect(res.status).toBe(404);
  });

  test("a staff session answers 403", async () => {
    const assessment = await seedAssessment();
    const attempt = await seedAttempt(assessment.id, STUDENT.ps_id);
    principal = staffPrincipal(TEACHER, TEACHER_EMAIL);

    const res = await postEvent(attempt.id, { kind: "quit" });
    expect(res.status).toBe(403);
  });

  test("a submitted attempt still accepts events (teardown races submit)", async () => {
    const assessment = await seedAssessment();
    const attempt = await seedAttempt(assessment.id, STUDENT.ps_id, { status: "submitted" });
    principal = studentPrincipal(STUDENT.email);

    const res = await postEvent(attempt.id, { kind: "lockdown_end" });
    expect(res.status).toBe(201);
  });
});

describe("attendance folding", () => {
  test("last_event and alert; focus_loss cleared by a later focus_regained", async () => {
    const assessment = await seedAssessment();
    const sitting = await createSitting(assessment.id);
    const attempt = await seedAttempt(assessment.id, STUDENT.ps_id, { sessionId: sitting.id });

    principal = studentPrincipal(STUDENT.email);
    expect((await postEvent(attempt.id, { kind: "lockdown_begin" })).status).toBe(201);
    expect((await postEvent(attempt.id, { kind: "focus_loss" })).status).toBe(201);

    let ada = (await attendance(sitting.id)).rows.find((r) => r.ps_id === STUDENT.ps_id)!;
    expect(ada.last_event?.kind).toBe("focus_loss");
    expect(ada.alert?.kind).toBe("focus_loss");

    principal = studentPrincipal(STUDENT.email);
    expect((await postEvent(attempt.id, { kind: "focus_regained" })).status).toBe(201);

    ada = (await attendance(sitting.id)).rows.find((r) => r.ps_id === STUDENT.ps_id)!;
    expect(ada.last_event?.kind).toBe("focus_regained");
    expect(ada.alert).toBeNull();
  });

  test("sticky alerts survive a later focus_regained; events never move last_activity_at", async () => {
    const assessment = await seedAssessment();
    const sitting = await createSitting(assessment.id);
    const attempt = await seedAttempt(assessment.id, STUDENT.ps_id, { sessionId: sitting.id });

    principal = studentPrincipal(STUDENT.email);
    expect((await postEvent(attempt.id, { kind: "emergency_exit" })).status).toBe(201);
    expect((await postEvent(attempt.id, { kind: "focus_regained" })).status).toBe(201);

    const ada = (await attendance(sitting.id)).rows.find((r) => r.ps_id === STUDENT.ps_id)!;
    expect(ada.alert?.kind).toBe("emergency_exit");
    expect(ada.last_event?.kind).toBe("focus_regained");
    // Idle detection stays about test progress: no responses were saved, so
    // last_activity_at is the attempt's start, not either event's time.
    expect(new Date(ada.last_activity_at!).getTime()).toBeLessThan(
      new Date(ada.last_event!.at).getTime(),
    );
  });

  test("a student with no events has null last_event and alert", async () => {
    const assessment = await seedAssessment();
    const sitting = await createSitting(assessment.id);
    await seedAttempt(assessment.id, STUDENT.ps_id, { sessionId: sitting.id });

    const ada = (await attendance(sitting.id)).rows.find((r) => r.ps_id === STUDENT.ps_id)!;
    expect(ada.last_event).toBeNull();
    expect(ada.alert).toBeNull();
  });
});

// Batch 3 slice 2 (D-4): an error the client hit DURING an attempt rides the
// existing, retrying events pipe so the teacher sees it live. The
// out-of-attempt errors go to /api/client-errors instead.
describe("the client_error kind", () => {
  test("is accepted and reaches the teacher as a Needs-attention alert", async () => {
    const assessment = await seedAssessment();
    const sitting = await createSitting(assessment.id);
    const attempt = await seedAttempt(assessment.id, STUDENT.ps_id, { sessionId: sitting.id });

    principal = studentPrincipal(STUDENT.email);
    const res = await postEvent(attempt.id, {
      kind: "client_error",
      detail: { kind: "drawing_upload_failed", message: "DRAWING UPLOAD FAILED: 500" },
    });
    expect(res.status).toBe(201);

    const stored = await getDb()
      .select()
      .from(attempt_events)
      .where(eq(attempt_events.attempt_id, attempt.id));
    expect(stored).toHaveLength(1);
    expect(stored[0]!.detail).toEqual({
      kind: "drawing_upload_failed",
      message: "DRAWING UPLOAD FAILED: 500",
    });

    const ada = (await attendance(sitting.id)).rows.find((r) => r.ps_id === STUDENT.ps_id)!;
    expect(ada.alert?.kind).toBe("client_error");
    expect(ada.last_event?.kind).toBe("client_error");
  });

  test("detail is reduced to { kind, message }, truncated, with nothing else kept", async () => {
    const assessment = await seedAssessment();
    const attempt = await seedAttempt(assessment.id, STUDENT.ps_id);

    principal = studentPrincipal(STUDENT.email);
    expect(
      (
        await postEvent(attempt.id, {
          kind: "client_error",
          detail: {
            kind: "spool_failed",
            message: "m".repeat(9000),
            // The monitor renders detail: a client must not be able to put an
            // answer or a stem in front of a teacher through this door.
            response_text: "the student's essay",
          },
        })
      ).status,
    ).toBe(201);

    const stored = await getDb()
      .select()
      .from(attempt_events)
      .where(eq(attempt_events.attempt_id, attempt.id));
    const detail = stored[0]!.detail as { kind: string; message: string };
    expect(Object.keys(detail).sort()).toEqual(["kind", "message"]);
    expect(detail.kind).toBe("spool_failed");
    expect(detail.message).toHaveLength(2000);
  });

  test("a sticky alert: it survives a later focus_regained", async () => {
    const assessment = await seedAssessment();
    const sitting = await createSitting(assessment.id);
    const attempt = await seedAttempt(assessment.id, STUDENT.ps_id, { sessionId: sitting.id });

    principal = studentPrincipal(STUDENT.email);
    expect(
      (await postEvent(attempt.id, { kind: "client_error", detail: { kind: "x", message: "y" } }))
        .status,
    ).toBe(201);
    expect((await postEvent(attempt.id, { kind: "focus_regained" })).status).toBe(201);

    const ada = (await attendance(sitting.id)).rows.find((r) => r.ps_id === STUDENT.ps_id)!;
    expect(ada.alert?.kind).toBe("client_error");
  });
});

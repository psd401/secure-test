// Teacher feedback entry (docs/feedback-release-design.md, slice 2):
// `lib/teacherFeedback/write.ts`, `PUT`/`DELETE /api/responses/[responseId]/feedback`
// and `PUT`/`DELETE /api/attempts/[attemptId]/feedback`.
//
// Harness: attempt-pass-back-api.test.ts's — staff and student principals off
// the roster fixture, switched per call, with the routes driven in process
// against the test DB.
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { closeDb, getDb } from "../db/client";
import {
  access_grants,
  assessments,
  attempt_events,
  attempt_feedback,
  attempts,
  items,
  response_feedback,
  responses,
  scores,
  students,
} from "../db/schema";
import { SESSION_COOKIE_NAME } from "../lib/auth/session";
import * as headersMod from "next/headers";
import * as sessionMod from "../lib/auth/session";
import { changeFinalScore } from "../lib/api/changeScore";
import {
  TEACHER_FEEDBACK_MAX,
  feedbackFailureMessage,
  feedbackIsDirty,
  feedbackRequest,
} from "../lib/teacherFeedback/limits";
import { setResponseFeedback } from "../lib/teacherFeedback/write";
import {
  OTHER_TEACHER_EMAIL,
  TEACHER_EMAIL,
  clearRoster,
  seedRoster,
  staffPrincipal,
  studentPrincipal,
} from "./helpers/roster";

const expectTestDb = () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("secure_test_design_tool_test")) {
    throw new Error(`teacher-feedback tests require the test DB DATABASE_URL; got: ${url}`);
  }
};

const OWNER = "feedback-teacher";
const CO_TEACHER = "feedback-co-teacher";

type Principal = { sub: string; role: string; email?: string } | null;
let principal: Principal = staffPrincipal(OWNER);

mock.module("next/headers", () => ({
  ...headersMod,
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

beforeAll(async () => {
  expectTestDb();
  await seedRoster();
  originalSecret = process.env.DESIGN_TOOL_SESSION_SECRET;
  process.env.DESIGN_TOOL_SESSION_SECRET ||= "teacher-feedback-test-secret-do-not-use";
});

afterEach(async () => {
  principal = staffPrincipal(OWNER);
  const db = getDb();
  await db.execute(sql`truncate table assessments restart identity cascade`);
  await db.execute(sql`truncate table students restart identity cascade`);
  await db.execute(sql`truncate table access_grants restart identity cascade`);
});

afterAll(async () => {
  await clearRoster();
  await closeDb();
  if (originalSecret === undefined) delete process.env.DESIGN_TOOL_SESSION_SECRET;
  else process.env.DESIGN_TOOL_SESSION_SECRET = originalSecret;
});

const SENTINEL = "Your second paragraph needs a source.";

/** A handed-in attempt with one essay answer carrying a human final of 3/5. */
async function scene(opts: { status?: "submitted" | "in_progress" } = {}) {
  const db = getDb();
  const [assessment] = await db
    .insert(assessments)
    .values({ owner_sub: OWNER, name: "Feedback" })
    .returning();
  const [essay] = await db
    .insert(items)
    .values({ assessment_id: assessment!.id, position: 0, type: "essay", stem: "Explain" })
    .returning();
  const [student] = await db
    .insert(students)
    .values({ owner_sub: OWNER, ssid: "FB-1", name: "Fb Student" })
    .returning();
  const status = opts.status ?? "submitted";
  const [attempt] = await db
    .insert(attempts)
    .values({
      assessment_id: assessment!.id,
      student_id: student!.id,
      status,
      submitted_at: status === "submitted" ? new Date() : null,
    })
    .returning();
  const [response] = await db
    .insert(responses)
    .values({
      attempt_id: attempt!.id,
      item_id: essay!.id,
      response: { type: "essay", text: "A first draft." },
    })
    .returning();
  await db.insert(scores).values({
    response_id: response!.id,
    method: "human",
    points: 3,
    max_points: 5,
    scorer: OWNER,
    status: "final",
    reviewed_by_sub: OWNER,
  });
  return { assessment: assessment!, essay: essay!, attempt: attempt!, response: response! };
}

function request(path: string, method: "PUT" | "DELETE", body?: unknown, raw?: string) {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(raw !== undefined ? { body: raw } : body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function putResponse(responseId: string, body: unknown, raw?: string) {
  const { PUT } = await import("../app/api/responses/[responseId]/feedback/route");
  return PUT(request(`/api/responses/${responseId}/feedback`, "PUT", body, raw), {
    params: Promise.resolve({ responseId }),
  });
}

async function deleteResponse(responseId: string) {
  const { DELETE } = await import("../app/api/responses/[responseId]/feedback/route");
  return DELETE(request(`/api/responses/${responseId}/feedback`, "DELETE"), {
    params: Promise.resolve({ responseId }),
  });
}

async function putAttempt(attemptId: string, body: unknown) {
  const { PUT } = await import("../app/api/attempts/[attemptId]/feedback/route");
  return PUT(request(`/api/attempts/${attemptId}/feedback`, "PUT", body), {
    params: Promise.resolve({ attemptId }),
  });
}

async function deleteAttempt(attemptId: string) {
  const { DELETE } = await import("../app/api/attempts/[attemptId]/feedback/route");
  return DELETE(request(`/api/attempts/${attemptId}/feedback`, "DELETE"), {
    params: Promise.resolve({ attemptId }),
  });
}

async function responseFeedbackRows(responseId: string) {
  return getDb()
    .select()
    .from(response_feedback)
    .where(eq(response_feedback.response_id, responseId));
}

async function attemptFeedbackRows(attemptId: string) {
  return getDb()
    .select()
    .from(attempt_feedback)
    .where(eq(attempt_feedback.attempt_id, attemptId));
}

async function feedbackEvents(attemptId: string) {
  return getDb()
    .select()
    .from(attempt_events)
    .where(and(eq(attempt_events.attempt_id, attemptId), eq(attempt_events.kind, "feedback_edited")));
}

async function grant(assessmentId: string, level: "run" | "edit") {
  await getDb().insert(access_grants).values({
    grantee_email: OTHER_TEACHER_EMAIL,
    scope_kind: "assessment",
    scope_id: assessmentId,
    granted_by_sub: OWNER,
    granted_by_email: TEACHER_EMAIL,
    level,
    note: level === "edit" ? "co-teacher" : "sub",
  });
}

describe("lib/teacherFeedback/limits (pure)", () => {
  test("an empty or blank box clears; anything else saves trimmed", () => {
    expect(feedbackRequest("")).toEqual({ method: "DELETE" });
    expect(feedbackRequest("  \n ")).toEqual({ method: "DELETE" });
    expect(feedbackRequest("  Good work. ")).toEqual({
      method: "PUT",
      body: { text: "Good work." },
    });
  });

  test("dirty ignores whitespace at the ends", () => {
    expect(feedbackIsDirty("Good", "Good")).toBe(false);
    expect(feedbackIsDirty("Good ", "Good")).toBe(false);
    expect(feedbackIsDirty("Good.", "Good")).toBe(true);
    expect(feedbackIsDirty("", "Good")).toBe(true);
  });

  test("failure lines differ by status", () => {
    expect(feedbackFailureMessage(400)).toContain("too long");
    expect(feedbackFailureMessage(400, "invalid_body")).toContain("too long");
    expect(feedbackFailureMessage(400, "attempt_not_submitted")).toContain("passed back");
    expect(feedbackFailureMessage(404)).toContain("edit access");
    expect(feedbackFailureMessage(500)).toBe("Couldn't save that. Try again.");
  });
});

describe("PUT/DELETE /api/responses/[responseId]/feedback", () => {
  test("PUT creates the comment and writes one event whose detail has no text", async () => {
    const s = await scene();
    const res = await putResponse(s.response.id, { text: `  ${SENTINEL}  ` });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.feedback.text).toBe(SENTINEL);
    expect(body.feedback.author_sub).toBe(OWNER);
    expect(body.unchanged).toBeUndefined();

    const rows = await responseFeedbackRows(s.response.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.text).toBe(SENTINEL);

    const events = await feedbackEvents(s.attempt.id);
    expect(events).toHaveLength(1);
    expect(events[0]!.detail).toEqual({
      scope: "question",
      response_id: s.response.id,
      item_id: s.essay.id,
      action: "saved",
    });
    // D-14: neither the text nor any part of it rides on the event.
    expect(JSON.stringify(events[0]!.detail)).not.toContain(SENTINEL);
  });

  test("an edit-level co-teacher edits the same row in place and becomes its author (D-12)", async () => {
    const s = await scene();
    await putResponse(s.response.id, { text: SENTINEL });
    const [first] = await responseFeedbackRows(s.response.id);

    await grant(s.assessment.id, "edit");
    principal = staffPrincipal(CO_TEACHER, OTHER_TEACHER_EMAIL);
    const res = await putResponse(s.response.id, { text: "Cite the article." });
    expect(res.status).toBe(200);

    const rows = await responseFeedbackRows(s.response.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(first!.id);
    expect(rows[0]!.text).toBe("Cite the article.");
    expect(rows[0]!.author_sub).toBe(CO_TEACHER);
    expect(rows[0]!.created_at.getTime()).toBe(first!.created_at.getTime());
    expect(rows[0]!.updated_at.getTime()).toBeGreaterThanOrEqual(first!.updated_at.getTime());
    expect(await feedbackEvents(s.attempt.id)).toHaveLength(2);
  });

  test("an identical save is unchanged and writes no event", async () => {
    const s = await scene();
    await putResponse(s.response.id, { text: SENTINEL });
    const res = await putResponse(s.response.id, { text: `${SENTINEL}\n` });
    expect(res.status).toBe(200);
    expect((await res.json()).unchanged).toBe(true);
    expect(await feedbackEvents(s.attempt.id)).toHaveLength(1);
  });

  test("blank, over-length and malformed bodies are 400 and write nothing", async () => {
    const s = await scene();
    for (const body of [
      { text: "" },
      { text: "   " },
      { text: "x".repeat(TEACHER_FEEDBACK_MAX + 1) },
      { text: 7 },
      {},
    ]) {
      const res = await putResponse(s.response.id, body);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe("invalid_body");
      // D-14: a refusal never echoes the body back.
      expect(json.detail).toBeUndefined();
    }
    expect((await putResponse(s.response.id, undefined, "{")).status).toBe(400);
    // The cap itself is allowed.
    expect((await putResponse(s.response.id, { text: "x".repeat(TEACHER_FEEDBACK_MAX) })).status).toBe(200);
    expect(await feedbackEvents(s.attempt.id)).toHaveLength(1);
  });

  test("DELETE clears the comment with a 'cleared' event; a second DELETE is a quiet 200", async () => {
    const s = await scene();
    await putResponse(s.response.id, { text: SENTINEL });
    const res = await deleteResponse(s.response.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, deleted: true });
    expect(await responseFeedbackRows(s.response.id)).toHaveLength(0);

    const again = await deleteResponse(s.response.id);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ ok: true, deleted: false });

    const events = await feedbackEvents(s.attempt.id);
    expect(events.map((e) => (e.detail as { action: string }).action).sort()).toEqual([
      "cleared",
      "saved",
    ]);
  });

  test("feedback survives a change of score (R-1)", async () => {
    const s = await scene();
    await putResponse(s.response.id, { text: SENTINEL });
    const changed = await changeFinalScore(
      getDb(),
      { response_id: s.response.id, attempt_id: s.attempt.id, item_id: s.essay.id },
      { points: 4, max_points: 5 },
      OWNER,
    );
    expect(changed.ok).toBe(true);
    const rows = await responseFeedbackRows(s.response.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.text).toBe(SENTINEL);
  });

  test("an in-progress attempt is 400 attempt_not_submitted", async () => {
    const s = await scene({ status: "in_progress" });
    const res = await putResponse(s.response.id, { text: SENTINEL });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("attempt_not_submitted");
    expect((await deleteResponse(s.response.id)).status).toBe(400);
    expect(await responseFeedbackRows(s.response.id)).toHaveLength(0);
  });

  test("edit is the rung: a run-level grantee gets 404, an edit-level one gets through", async () => {
    const s = await scene();
    await grant(s.assessment.id, "run");
    principal = staffPrincipal(CO_TEACHER, OTHER_TEACHER_EMAIL);
    expect((await putResponse(s.response.id, { text: SENTINEL })).status).toBe(404);
    expect((await deleteResponse(s.response.id)).status).toBe(404);
    expect(await responseFeedbackRows(s.response.id)).toHaveLength(0);

    principal = staffPrincipal(OWNER);
    await getDb().delete(access_grants).where(eq(access_grants.scope_id, s.assessment.id));
    await grant(s.assessment.id, "edit");
    principal = staffPrincipal(CO_TEACHER, OTHER_TEACHER_EMAIL);
    expect((await putResponse(s.response.id, { text: SENTINEL })).status).toBe(200);
  });

  test("another teacher gets 404; a student 403; no session 401", async () => {
    const s = await scene();
    principal = staffPrincipal(CO_TEACHER, OTHER_TEACHER_EMAIL);
    expect((await putResponse(s.response.id, { text: SENTINEL })).status).toBe(404);
    principal = studentPrincipal();
    expect((await putResponse(s.response.id, { text: SENTINEL })).status).toBe(403);
    expect((await deleteResponse(s.response.id)).status).toBe(403);
    principal = null;
    expect((await putResponse(s.response.id, { text: SENTINEL })).status).toBe(401);
    expect((await deleteResponse(s.response.id)).status).toBe(401);
    expect(await responseFeedbackRows(s.response.id)).toHaveLength(0);
  });

  test("an unknown id is 404, a malformed one 400", async () => {
    expect((await putResponse("11111111-1111-4111-8111-111111111111", { text: SENTINEL })).status).toBe(404);
    expect((await deleteResponse("11111111-1111-4111-8111-111111111111")).status).toBe(404);
    expect((await putResponse("nope", { text: SENTINEL })).status).toBe(400);
    expect((await deleteResponse("nope")).status).toBe(400);
  });

  test("a failed write throws an error that carries none of the text (D-14)", async () => {
    // No such response: the FK refuses the insert, and Drizzle's own error
    // would list the params — the text — in its message.
    let caught: unknown;
    try {
      await setResponseFeedback(
        getDb(),
        {
          response_id: "11111111-1111-4111-8111-111111111111",
          attempt_id: "22222222-2222-4222-8222-222222222222",
          item_id: "33333333-3333-4333-8333-333333333333",
        },
        SENTINEL,
        OWNER,
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const err = caught as Error;
    expect(err.message).toBe("teacher feedback write failed");
    expect(err.cause).toBeUndefined();
    expect(String(err.stack)).not.toContain(SENTINEL);
  });
});

describe("PUT/DELETE /api/attempts/[attemptId]/feedback", () => {
  test("PUT creates the overall comment; a co-teacher's edit replaces it in place", async () => {
    const s = await scene();
    const res = await putAttempt(s.attempt.id, { text: SENTINEL });
    expect(res.status).toBe(200);
    expect((await res.json()).feedback.text).toBe(SENTINEL);
    const [first] = await attemptFeedbackRows(s.attempt.id);
    expect(first!.author_sub).toBe(OWNER);

    await grant(s.assessment.id, "edit");
    principal = staffPrincipal(CO_TEACHER, OTHER_TEACHER_EMAIL);
    expect((await putAttempt(s.attempt.id, { text: "Strong finish." })).status).toBe(200);
    const rows = await attemptFeedbackRows(s.attempt.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(first!.id);
    expect(rows[0]!.author_sub).toBe(CO_TEACHER);

    const events = await feedbackEvents(s.attempt.id);
    expect(events).toHaveLength(2);
    for (const e of events) {
      expect(e.detail).toEqual({ scope: "overall", action: "saved" });
    }
  });

  test("an identical save writes no event; DELETE clears once, then quietly", async () => {
    const s = await scene();
    await putAttempt(s.attempt.id, { text: SENTINEL });
    expect((await (await putAttempt(s.attempt.id, { text: SENTINEL })).json()).unchanged).toBe(true);
    expect(await (await deleteAttempt(s.attempt.id)).json()).toEqual({ ok: true, deleted: true });
    expect(await (await deleteAttempt(s.attempt.id)).json()).toEqual({ ok: true, deleted: false });
    expect(await attemptFeedbackRows(s.attempt.id)).toHaveLength(0);
    const events = await feedbackEvents(s.attempt.id);
    expect(events.map((e) => (e.detail as { action: string }).action).sort()).toEqual([
      "cleared",
      "saved",
    ]);
  });

  test("blank and over-length text are 400 invalid_body", async () => {
    const s = await scene();
    for (const body of [{ text: " " }, { text: "x".repeat(TEACHER_FEEDBACK_MAX + 1) }]) {
      const res = await putAttempt(s.attempt.id, body);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("invalid_body");
    }
    expect(await attemptFeedbackRows(s.attempt.id)).toHaveLength(0);
  });

  test("an in-progress attempt is 400 attempt_not_submitted", async () => {
    const s = await scene({ status: "in_progress" });
    const res = await putAttempt(s.attempt.id, { text: SENTINEL });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("attempt_not_submitted");
    expect((await deleteAttempt(s.attempt.id)).status).toBe(400);
  });

  test("a run-level grantee and another teacher get 404; a student 403; no session 401", async () => {
    const s = await scene();
    await grant(s.assessment.id, "run");
    principal = staffPrincipal(CO_TEACHER, OTHER_TEACHER_EMAIL);
    expect((await putAttempt(s.attempt.id, { text: SENTINEL })).status).toBe(404);
    expect((await deleteAttempt(s.attempt.id)).status).toBe(404);
    principal = studentPrincipal();
    expect((await putAttempt(s.attempt.id, { text: SENTINEL })).status).toBe(403);
    principal = null;
    expect((await putAttempt(s.attempt.id, { text: SENTINEL })).status).toBe(401);
    expect(await attemptFeedbackRows(s.attempt.id)).toHaveLength(0);
  });

  test("an unknown id is 404, a malformed one 400", async () => {
    expect((await putAttempt("11111111-1111-4111-8111-111111111111", { text: SENTINEL })).status).toBe(404);
    expect((await putAttempt("nope", { text: SENTINEL })).status).toBe(400);
    expect((await deleteAttempt("nope")).status).toBe(400);
  });

  test("the comment goes with the attempt (cascade)", async () => {
    const s = await scene();
    await putAttempt(s.attempt.id, { text: SENTINEL });
    await putResponse(s.response.id, { text: SENTINEL });
    await getDb().delete(attempts).where(eq(attempts.id, s.attempt.id));
    expect(await attemptFeedbackRows(s.attempt.id)).toHaveLength(0);
    expect(await responseFeedbackRows(s.response.id)).toHaveLength(0);
  });
});

// Instant feedback (docs/instant-feedback-design.md, slice 1): the server
// half on the test DB — the submit response, the `feedback_shown` event,
// release answers, the Published-lock exception and the bundle round trip.
// Same in-process mock harness as attempt-ingest-api.test.ts.
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { closeDb, getDb } from "../db/client";
import {
  assessments,
  attempt_events,
  attempts,
  items,
  responses,
  students,
  test_sessions,
} from "../db/schema";
import { SESSION_COOKIE_NAME } from "../lib/auth/session";
import * as sessionMod from "../lib/auth/session";
import { buildResults } from "../lib/scoring/results";
import { duplicateAssessment } from "../lib/api/duplicateAssessment";
import { buildExportBundle } from "../lib/api/exportBundle";
import { CLIENT_ATTEMPT_EVENT_KINDS } from "../db/schema";
import { STUDENT, TEACHER_EMAIL, clearRoster, seedRoster, studentPrincipal } from "./helpers/roster";

const expectTestDb = () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("secure_test_design_tool_test")) {
    throw new Error(`instant-feedback tests require the test DB; got: ${url}`);
  }
};

const TEACHER = "feedback-teacher";
const OTHER_TEACHER = "feedback-other-teacher";

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

const asStudent = () => {
  principal = studentPrincipal(STUDENT.email);
};
const asTeacher = (sub = TEACHER) => {
  principal = { sub, role: "staff", email: TEACHER_EMAIL };
};

let originalSecret: string | undefined;

beforeAll(async () => {
  expectTestDb();
  await seedRoster();
  originalSecret = process.env.DESIGN_TOOL_SESSION_SECRET;
  process.env.DESIGN_TOOL_SESSION_SECRET ||= "feedback-test-secret-do-not-use";
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
  if (originalSecret === undefined) delete process.env.DESIGN_TOOL_SESSION_SECRET;
  else process.env.DESIGN_TOOL_SESSION_SECRET = originalSecret;
});

type Level = "off" | "score" | "right_wrong" | "answers";

/**
 * An open sitting on a four-question assessment, a started attempt and saved
 * answers: MC right, short text wrong (key `1/2`, answer `3`), a partly right
 * table, and an essay. Expected after the auto pass: 3 of 5, 1 pending.
 */
async function scenario(opts: {
  level?: Level;
  release?: "at_hand_in" | "on_release";
  status?: "draft" | "published";
} = {}) {
  const db = getDb();
  const [assessment] = await db
    .insert(assessments)
    .values({
      owner_sub: TEACHER,
      owner_email: TEACHER_EMAIL,
      name: "Feedback",
      status: opts.status ?? "draft",
      student_feedback: opts.level ?? "off",
      answers_release: opts.release ?? "on_release",
    })
    .returning();
  const a = assessment!;
  const inserted = await db
    .insert(items)
    .values([
      {
        assessment_id: a.id,
        position: 0,
        type: "multiple_choice_single",
        stem: "Pick one",
        choices: [
          { id: "c1", text: "one" },
          { id: "c2", text: "two" },
        ],
        correct_choice_ids: ["c1"],
      },
      { assessment_id: a.id, position: 1, type: "short_text", stem: "Half?", correct_answer: "1/2" },
      {
        assessment_id: a.id,
        position: 2,
        type: "table",
        stem: "Fill in",
        config: {
          columns: [{ id: "k1", label: "Value" }],
          rows: [
            { id: "r1", label: "A" },
            { id: "r2", label: "B" },
            { id: "r3", label: "C" },
          ],
          cell_keys: { r1: { k1: "1" }, r2: { k1: "2" }, r3: { k1: "3" } },
        },
      },
      { assessment_id: a.id, position: 3, type: "essay", stem: "Write" },
    ])
    .returning();
  const byPos = new Map(inserted.map((i) => [i.position, i]));
  await db.insert(students).values({
    owner_sub: TEACHER,
    ssid: STUDENT.ssid,
    roster_ps_id: STUDENT.ps_id,
    name: STUDENT.name,
  });
  const [sitting] = await db
    .insert(test_sessions)
    .values({
      assessment_id: a.id,
      owner_sub: TEACHER,
      owner_email: TEACHER_EMAIL,
      code: "FBACK1",
      status: "open",
      expires_at: new Date(Date.now() + 3_600_000),
    })
    .returning();

  asStudent();
  const { POST } = await import("../app/api/attempts/route");
  const started = await POST(
    new Request("http://localhost/api/attempts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ test_session_id: sitting!.id }),
    }),
  );
  const { attempt } = (await started.json()) as { attempt: { id: string } };
  await db.insert(responses).values([
    { attempt_id: attempt.id, item_id: byPos.get(0)!.id, response: { type: "multiple_choice_single", choice_id: "c1" } },
    { attempt_id: attempt.id, item_id: byPos.get(1)!.id, response: { type: "short_text", text: "3" } },
    {
      attempt_id: attempt.id,
      item_id: byPos.get(2)!.id,
      response: { type: "table", cells: { r1: { k1: "1" }, r2: { k1: "2" }, r3: { k1: "9" } } },
    },
    { attempt_id: attempt.id, item_id: byPos.get(3)!.id, response: { type: "essay", text: "An essay." } },
  ]);
  return { assessment: a, attemptId: attempt.id, sittingId: sitting!.id, items: byPos };
}

async function submit(attemptId: string) {
  const { POST } = await import("../app/api/attempts/[attemptId]/submit/route");
  return POST(new Request("http://localhost/x", { method: "POST" }), {
    params: Promise.resolve({ attemptId }),
  });
}

async function release(assessmentId: string) {
  const { POST } = await import("../app/api/assessments/[id]/release-answers/route");
  return POST(new Request("http://localhost/x", { method: "POST" }), {
    params: Promise.resolve({ id: assessmentId }),
  });
}

async function patch(assessmentId: string, body: unknown) {
  const { PATCH } = await import("../app/api/assessments/[id]/route");
  return PATCH(
    new Request("http://localhost/x", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: assessmentId }) },
  );
}

async function feedbackEvents(attemptId: string) {
  return (await getDb().select().from(attempt_events).where(eq(attempt_events.attempt_id, attemptId))).filter(
    (e) => e.kind === "feedback_shown",
  );
}

describe("submit — feedback by level", () => {
  test("off: no feedback field, no event, response unchanged", async () => {
    const s = await scenario({ level: "off" });
    const body = await (await submit(s.attemptId)).json();
    expect(body.already_submitted).toBe(false);
    expect(body.attempt.status).toBe("submitted");
    expect("feedback" in body).toBe(false);
    expect(await feedbackEvents(s.attemptId)).toHaveLength(0);
  });

  test("score: totals after the auto pass, no items, no key", async () => {
    const s = await scenario({ level: "score", release: "at_hand_in" });
    const body = await (await submit(s.attemptId)).json();
    expect(body.feedback).toEqual({ level: "score", earned: 3, max_auto: 5, pending_count: 1 });
    expect(JSON.stringify(body)).not.toContain("correct_answer");
  });

  test("right_wrong: per-question list, no key", async () => {
    const s = await scenario({ level: "right_wrong", release: "at_hand_in" });
    const body = await (await submit(s.attemptId)).json();
    expect(body.feedback.items.map((i: { result: string }) => i.result)).toEqual([
      "correct",
      "incorrect",
      "partial",
      "pending",
    ]);
    expect(JSON.stringify(body)).not.toContain("correct_answer");
  });

  test("answers + on_release before release: the note, no key in the response", async () => {
    const s = await scenario({ level: "answers" });
    const body = await (await submit(s.attemptId)).json();
    expect(body.feedback.answers_note).toBe("Your teacher will go over the correct answers.");
    expect(JSON.stringify(body)).not.toContain("correct_answer");
    const [event] = await feedbackEvents(s.attemptId);
    expect(event!.detail).toEqual({ level: "answers", earned: 3, max_auto: 5, answers_shown: false });
  });

  test("answers after release: the key on missed questions", async () => {
    const s = await scenario({ level: "answers" });
    asTeacher();
    expect((await release(s.assessment.id)).status).toBe(200);
    asStudent();
    const body = await (await submit(s.attemptId)).json();
    const keys = body.feedback.items.map((i: { correct_answer?: string }) => i.correct_answer ?? null);
    expect(keys).toEqual([null, "1/2", "A, Value: 1\nB, Value: 2\nC, Value: 3", null]);
    expect(body.feedback.answers_note).toBeUndefined();
  });

  test("answers + at_hand_in: the key without a release", async () => {
    const s = await scenario({ level: "answers", release: "at_hand_in" });
    const body = await (await submit(s.attemptId)).json();
    expect(body.feedback.items[1].correct_answer).toBe("1/2");
  });
});

describe("submit — the event, the retry, and the paths with no feedback", () => {
  test("one feedback_shown event; a retry re-delivers without a second one", async () => {
    const s = await scenario({ level: "right_wrong" });
    const first = await (await submit(s.attemptId)).json();
    const events = await feedbackEvents(s.attemptId);
    expect(events).toHaveLength(1);
    expect(events[0]!.detail).toEqual({ level: "right_wrong", earned: 3, max_auto: 5, answers_shown: false });

    const retry = await (await submit(s.attemptId)).json();
    expect(retry.already_submitted).toBe(true);
    expect(retry.feedback).toEqual(first.feedback);
    expect(await feedbackEvents(s.attemptId)).toHaveLength(1);
  });

  test("feedback earned equals the results matrix's total for the same attempt", async () => {
    const s = await scenario({ level: "score" });
    const body = await (await submit(s.attemptId)).json();
    const results = await buildResults(s.assessment.id);
    const row = results.rows.find((r) => r.attempt_id === s.attemptId)!;
    expect(body.feedback.earned).toBe(row.total_points);
    // Every auto item was answered here, so the denominators agree too.
    expect(body.feedback.max_auto).toBe(row.scored_max_points);
  });

  test("D-3: a passed-back attempt gets no feedback on re-hand-in", async () => {
    const s = await scenario({ level: "answers", release: "at_hand_in" });
    await getDb().update(attempts).set({ pass_back_count: 1 }).where(eq(attempts.id, s.attemptId));
    const body = await (await submit(s.attemptId)).json();
    expect(body.attempt.status).toBe("submitted");
    expect("feedback" in body).toBe(false);
    expect(await feedbackEvents(s.attemptId)).toHaveLength(0);
  });

  test("D-6: a teacher's hand-in builds no feedback, and a later student retry gets none", async () => {
    const s = await scenario({ level: "answers", release: "at_hand_in" });
    await getDb().update(test_sessions).set({ status: "closed" }).where(eq(test_sessions.id, s.sittingId));
    asTeacher();
    const { POST } = await import("../app/api/attempts/[attemptId]/hand-in/route");
    const res = await POST(new Request("http://localhost/x", { method: "POST" }), {
      params: Promise.resolve({ attemptId: s.attemptId }),
    });
    expect(res.status).toBe(200);
    expect("feedback" in (await res.json())).toBe(false);
    expect(await feedbackEvents(s.attemptId)).toHaveLength(0);

    asStudent();
    const retry = await submit(s.attemptId);
    const body = await retry.json();
    expect("feedback" in body).toBe(false);
  });

  test("feedback_shown is not client-postable", () => {
    expect(CLIENT_ATTEMPT_EVENT_KINDS).not.toContain("feedback_shown");
  });
});

describe("POST /api/assessments/:id/release-answers", () => {
  test("stamps once; a second press keeps the first stamp", async () => {
    const s = await scenario({ level: "answers", status: "published" });
    asTeacher();
    const first = await (await release(s.assessment.id)).json();
    expect(first.already_released).toBe(false);
    expect(first.assessment.answers_released_at).not.toBeNull();
    const second = await (await release(s.assessment.id)).json();
    expect(second.already_released).toBe(true);
    expect(second.assessment.answers_released_at).toBe(first.assessment.answers_released_at);
  });

  test("409 not_answers_level below `answers`", async () => {
    const s = await scenario({ level: "right_wrong" });
    asTeacher();
    const res = await release(s.assessment.id);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("not_answers_level");
    const [row] = await getDb().select().from(assessments).where(eq(assessments.id, s.assessment.id));
    expect(row!.answers_released_at).toBeNull();
  });

  test("another teacher gets 404; a student is refused", async () => {
    const s = await scenario({ level: "answers" });
    asTeacher(OTHER_TEACHER);
    expect((await release(s.assessment.id)).status).toBe(404);
    asStudent();
    expect((await release(s.assessment.id)).status).toBeGreaterThanOrEqual(401);
    const [row] = await getDb().select().from(assessments).where(eq(assessments.id, s.assessment.id));
    expect(row!.answers_released_at).toBeNull();
  });
});

describe("PATCH while Published (D-1)", () => {
  test("the two feedback settings change; other settings stay locked", async () => {
    const s = await scenario({ status: "published" });
    asTeacher();
    const ok = await patch(s.assessment.id, { student_feedback: "answers", answers_release: "at_hand_in" });
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body.assessment.student_feedback).toBe("answers");
    expect(body.assessment.answers_release).toBe("at_hand_in");
    expect(body.assessment.status).toBe("published");

    const locked = await patch(s.assessment.id, { student_feedback: "score", time_limit_seconds: 600 });
    expect(locked.status).toBe(409);
    expect((await patch(s.assessment.id, { name: "Renamed" })).status).toBe(409);
  });

  test("a full editor body whose only change is the feedback level passes", async () => {
    const s = await scenario({ status: "published" });
    asTeacher();
    const res = await patch(s.assessment.id, {
      name: s.assessment.name,
      description: s.assessment.description,
      time_limit_seconds: null,
      allow_llm_authoring: false,
      allow_clipboard: false,
      student_layout: "scroll",
      status: "published",
      student_feedback: "score",
    });
    expect(res.status).toBe(200);
  });

  test("an unknown level is a 400", async () => {
    const s = await scenario();
    asTeacher();
    expect((await patch(s.assessment.id, { student_feedback: "all" })).status).toBe(400);
  });
});

describe("export / duplicate", () => {
  test("carry the two settings, never the release stamp", async () => {
    const s = await scenario({ level: "answers", release: "at_hand_in" });
    await getDb()
      .update(assessments)
      .set({ answers_released_at: new Date() })
      .where(eq(assessments.id, s.assessment.id));
    const [source] = await getDb().select().from(assessments).where(eq(assessments.id, s.assessment.id));

    const built = await buildExportBundle(getDb(), source!, TEACHER, true);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.bundle.student_feedback).toBe("answers");
    expect(built.bundle.answers_release).toBe("at_hand_in");
    expect(JSON.stringify(built.bundle)).not.toContain("answers_released_at");

    const copy = await duplicateAssessment(getDb(), source!, TEACHER, TEACHER_EMAIL);
    expect(copy.ok).toBe(true);
    if (!copy.ok) return;
    const [row] = await getDb().select().from(assessments).where(eq(assessments.id, copy.assessment_id));
    expect(row!.student_feedback).toBe("answers");
    expect(row!.answers_release).toBe("at_hand_in");
    expect(row!.answers_released_at).toBeNull();
  });

  test("defaults are not emitted", async () => {
    const s = await scenario();
    const built = await buildExportBundle(getDb(), s.assessment, TEACHER, true);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect("student_feedback" in built.bundle).toBe(false);
    expect("answers_release" in built.bundle).toBe(false);
  });
});

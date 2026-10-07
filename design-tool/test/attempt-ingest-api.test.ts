// Slice 61: the student ingest — the half of the system lib/dev/seedAttempts
// was standing in for ("the stand-in for the missing student app").
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { eq, sql, and } from "drizzle-orm";
import { closeDb, getDb } from "../db/client";
import { assessments, attempt_events, attempts, item_sets, items, response_revisions, responses, scores, students, test_sessions } from "../db/schema";
import { SESSION_COOKIE_NAME } from "../lib/auth/session";
import * as sessionMod from "../lib/auth/session";
import * as scoringMod from "../lib/scoring/runAutoScoring";
import {
  OTHER_STUDENT,
  STUDENT,
  TEACHER_EMAIL,
  OTHER_TEACHER_EMAIL,
  clearRoster,
  seedRoster,
  studentPrincipal,
} from "./helpers/roster";

const expectTestDb = () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("secure_test_design_tool_test")) {
    throw new Error(`attempt-ingest tests require the test DB; got: ${url}`);
  }
};

const TEACHER = "ingest-teacher";
const OTHER_TEACHER = "ingest-other-teacher";

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

// R0.1: submit/route.ts must never fail the hand-in when auto-scoring
// throws. `scoringShouldThrow` defaults to false, so every other test in
// this file (and — since bun's mock.module registry is shared across the
// whole run, see auth-bearer.test.ts — every other file) gets the real
// scoring pass transparently; only the one test below flips it.
//
// The real function is snapshotted into a plain local BEFORE mock.module
// runs. `scoringMod` (the namespace import) is a live binding, and
// mock.module replaces the module's own export slots in place — so calling
// `scoringMod.runAutoScoringPass` from inside the wrapper would resolve to
// the wrapper itself (infinite recursion, observed as a stack overflow
// silently swallowed by submit's try/catch, which made the failing tests
// look like a multi-minute hang rather than a clean assertion failure).
const realRunAutoScoringPass = scoringMod.runAutoScoringPass;
let scoringShouldThrow = false;
mock.module("../lib/scoring/runAutoScoring", () => ({
  ...scoringMod,
  runAutoScoringPass: (...args: Parameters<typeof scoringMod.runAutoScoringPass>) => {
    if (scoringShouldThrow) throw new Error("boom (test): auto-scoring failed");
    return realRunAutoScoringPass(...args);
  },
}));

const asStudent = (email: string = STUDENT.email) => {
  principal = studentPrincipal(email);
};

let originalDeliverySecret: string | undefined;

beforeAll(async () => {
  expectTestDb();
  await seedRoster();
  // Slice 64 seals match/order option ids per attempt, which needs a secret.
  originalDeliverySecret = process.env.DESIGN_TOOL_SESSION_SECRET;
  process.env.DESIGN_TOOL_SESSION_SECRET ||= "delivery-test-secret-do-not-use";
});

afterEach(async () => {
  principal = null;
  scoringShouldThrow = false;
  const db = getDb();
  await db.execute(sql`truncate table assessments restart identity cascade`);
  await db.execute(sql`truncate table students restart identity cascade`);
});

afterAll(async () => {
  await clearRoster();
  await closeDb();
  if (originalDeliverySecret === undefined) delete process.env.DESIGN_TOOL_SESSION_SECRET;
  else process.env.DESIGN_TOOL_SESSION_SECRET = originalDeliverySecret;
});

async function scenario(opts: { owner?: string; expired?: boolean; closed?: boolean } = {}) {
  const owner = opts.owner ?? TEACHER;
  const db = getDb();
  const [assessment] = await db
    .insert(assessments)
    .values({ owner_sub: owner, name: "Ingest" })
    .returning();
  const [mc] = await db
    .insert(items)
    .values({
      assessment_id: assessment!.id,
      position: 1,
      type: "multiple_choice_single",
      stem: "Pick one",
      choices: [{ id: "c1", text: "one" }, { id: "c2", text: "two" }],
      correct_choice_ids: ["c1"],
    })
    .returning();
  const [essay] = await db
    .insert(items)
    .values({ assessment_id: assessment!.id, position: 2, type: "essay", stem: "Write" })
    .returning();
  const [match] = await db
    .insert(items)
    .values({
      assessment_id: assessment!.id,
      position: 3,
      type: "match",
      stem: "Match them",
      config: {
        pairs: [
          { id: "p1", left: "Dog", right: "Puppy" },
          { id: "p2", left: "Cat", right: "Kitten" },
        ],
      },
    })
    .returning();
  const [order] = await db
    .insert(items)
    .values({
      assessment_id: assessment!.id,
      position: 4,
      type: "order",
      stem: "Order them",
      config: {
        sequence: [
          { id: "e1", label: "First" },
          { id: "e2", label: "Second" },
          { id: "e3", label: "Third" },
        ],
      },
    })
    .returning();
  const [student] = await db
    .insert(students)
    .values({
      owner_sub: owner,
      ssid: STUDENT.ssid,
      roster_ps_id: STUDENT.ps_id,
      name: STUDENT.name,
    })
    .returning();
  const [sitting] = await db
    .insert(test_sessions)
    .values({
      assessment_id: assessment!.id,
      owner_sub: owner,
      // Slice 78: the sitting is scoped by its owner's sections. The other
      // teacher teaches none of Ada's.
      owner_email: owner === OTHER_TEACHER ? OTHER_TEACHER_EMAIL : TEACHER_EMAIL,
      code: opts.owner === OTHER_TEACHER ? "OTHERZ" : "INGEST",
      status: opts.closed ? "closed" : "open",
      expires_at: new Date(Date.now() + (opts.expired ? -60_000 : 3_600_000)),
    })
    .returning();
  return {
    assessment: assessment!,
    mc: mc!,
    essay: essay!,
    match: match!,
    order: order!,
    student: student!,
    sitting: sitting!,
  };
}

async function start(sessionId: string) {
  const { POST } = await import("../app/api/attempts/route");
  return POST(
    new Request("http://localhost/api/attempts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ test_session_id: sessionId }),
    }),
  );
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

const PICK = { type: "multiple_choice_single", choice_id: "c1" };

describe("POST /api/attempts", () => {
  test("starts an attempt for a rostered student in an open sitting", async () => {
    const s = await scenario();
    asStudent();
    const res = await start(s.sitting.id);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.resumed).toBe(false);
    expect(body.attempt.student_id).toBe(s.student.id);
    expect(body.attempt.test_session_id).toBe(s.sitting.id);
    expect(body.attempt.status).toBe("in_progress");
  });

  // One attempt per (student, assessment): joining again resumes rather than
  // stranding the first set of answers.
  test("resumes the existing attempt instead of starting a second", async () => {
    const s = await scenario();
    asStudent();
    const first = await (await start(s.sitting.id)).json();
    const second = await start(s.sitting.id);
    expect(second.status).toBe(200);
    const body = await second.json();
    expect(body.resumed).toBe(true);
    expect(body.attempt.id).toBe(first.attempt.id);

    const rows = await getDb().select().from(attempts);
    expect(rows.length).toBe(1);
  });

  test("a closed or expired sitting cannot be started", async () => {
    const closed = await scenario({ closed: true });
    asStudent();
    expect((await start(closed.sitting.id)).status).toBe(404);

    await getDb().execute(sql`truncate table assessments restart identity cascade`);
    await getDb().execute(sql`truncate table students restart identity cascade`);
    const expired = await scenario({ expired: true });
    asStudent();
    expect((await start(expired.sitting.id)).status).toBe(404);
  });

  // A sitting id is not an admission ticket on its own.
  test("a student the sitting's owner does not teach cannot start", async () => {
    // Slice 78: the sitting belongs to teacher.two, who teaches none of Ada's
    // sections. The overlay row seeded under OTHER_TEACHER does not matter —
    // scope is decided by the warehouse roster, not by the overlay.
    const s = await scenario({ owner: OTHER_TEACHER });
    asStudent();
    const res = await start(s.sitting.id);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("not_in_sitting");
    expect((await getDb().select().from(attempts)).length).toBe(0);
  });

  // Finding 8.2 (2026-08-28): the first sitting expired, the teacher opened
  // another, and the student rejoined — the attempt must follow them, or the
  // new sitting's monitor shows "not joined" and peek only works from the old
  // sitting's page.
  test("finding 8.2: rejoining through a new sitting of the same assessment rebinds the attempt", async () => {
    const s = await scenario();
    asStudent();
    const first = await (await start(s.sitting.id)).json();
    expect((await put(first.attempt.id, s.mc.id, PICK)).status).toBe(200);
    const second = await secondSitting(s.assessment.id);

    const res = await start(second.id);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.resumed).toBe(true);
    expect(body.attempt.id).toBe(first.attempt.id);
    expect(body.attempt.test_session_id).toBe(second.id);
    expect(body.attempt.status).toBe("in_progress");

    const rows = await getDb().select().from(attempts);
    expect(rows.length).toBe(1);
    expect(rows[0]!.test_session_id).toBe(second.id);
    // The work came along: responses key on the attempt, not the sitting.
    expect((await getDb().select().from(responses)).length).toBe(1);
  });

  test("finding 8.2: a submitted attempt is not rebound", async () => {
    const s = await scenario();
    asStudent();
    const first = await (await start(s.sitting.id)).json();
    expect((await submit(first.attempt.id)).status).toBe(200);
    const second = await secondSitting(s.assessment.id);

    const res = await start(second.id);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.resumed).toBe(true);
    expect(body.attempt.id).toBe(first.attempt.id);
    expect(body.attempt.status).toBe("submitted");
    expect(body.attempt.test_session_id).toBe(s.sitting.id);
    const [row] = await getDb().select().from(attempts);
    expect(row!.test_session_id).toBe(s.sitting.id);
  });

  test("finding 8.2: a new sitting that does not admit the student still refuses, and the attempt stays put", async () => {
    const s = await scenario();
    asStudent();
    const first = await (await start(s.sitting.id)).json();
    // Same assessment, same owner, but an explicit list that names only Ben.
    const second = await secondSitting(s.assessment.id, { student_ps_ids: [OTHER_STUDENT.ps_id] });

    const res = await start(second.id);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("not_in_sitting");
    const [row] = await getDb().select().from(attempts);
    expect(row!.id).toBe(first.attempt.id);
    expect(row!.test_session_id).toBe(s.sitting.id);
  });
});

// Remove time limit (2026-09-24): a sitting whose whole-session "No time
// limit" is on passes it to students who join LATER — new and resumed.
describe("POST /api/attempts — a sitting with its time limit removed", () => {
  async function flag(sittingId: string) {
    await getDb()
      .update(test_sessions)
      .set({ time_limit_removed: true })
      .where(eq(test_sessions.id, sittingId));
  }

  test("a NEW attempt through a flagged sitting has no time limit, with the event", async () => {
    const s = await scenario();
    await flag(s.sitting.id);
    asStudent();
    const res = await start(s.sitting.id);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.attempt.time_limit_removed).toBe(true);
    const events = await getDb().select().from(attempt_events);
    expect(events.map((e) => [e.kind, e.detail])).toEqual([
      // `created_by_sub` is null on this seeded sitting → the owner.
      ["deadline_extended", { no_limit: true, by: TEACHER }],
    ]);
  });

  test("a RESUMED attempt joining through a flagged sitting gets it too, once", async () => {
    const s = await scenario();
    asStudent();
    const first = await (await start(s.sitting.id)).json();
    expect(first.attempt.time_limit_removed).toBe(false);
    const second = await secondSitting(s.assessment.id);
    await flag(second.id);

    const body = await (await start(second.id)).json();
    expect(body.resumed).toBe(true);
    expect(body.attempt.test_session_id).toBe(second.id);
    expect(body.attempt.time_limit_removed).toBe(true);
    // Rejoining the same flagged sitting does not write a second event.
    await start(second.id);
    expect(await getDb().select().from(attempt_events)).toHaveLength(1);
  });

  test("an unflagged sitting changes nothing", async () => {
    const s = await scenario();
    asStudent();
    const body = await (await start(s.sitting.id)).json();
    expect(body.attempt.time_limit_removed).toBe(false);
    expect(await getDb().select().from(attempt_events)).toHaveLength(0);
  });

  test("a submitted attempt resumed through a flagged sitting is untouched", async () => {
    const s = await scenario();
    asStudent();
    const first = await (await start(s.sitting.id)).json();
    expect((await submit(first.attempt.id)).status).toBe(200);
    const second = await secondSitting(s.assessment.id);
    await flag(second.id);
    const body = await (await start(second.id)).json();
    expect(body.attempt.time_limit_removed).toBe(false);
  });
});

/** A second open sitting of the same assessment, owned by the same teacher. */
async function secondSitting(assessmentId: string, extra: { student_ps_ids?: string[] } = {}) {
  const [row] = await getDb()
    .insert(test_sessions)
    .values({
      assessment_id: assessmentId,
      owner_sub: TEACHER,
      owner_email: TEACHER_EMAIL,
      code: "SECOND",
      status: "open",
      expires_at: new Date(Date.now() + 3_600_000),
      ...extra,
    })
    .returning();
  return row!;
}

describe("PUT /api/attempts/:id/responses/:itemId", () => {
  async function started() {
    const s = await scenario();
    asStudent();
    const { attempt } = await (await start(s.sitting.id)).json();
    return { ...s, attempt };
  }

  // E12 slice 3: the outline a student writes in place posts under the
  // SOURCE question's id — a question of another assessment — and is
  // accepted only because a set of this attempt's assessment names it.
  test("accepts an essay response under a set's source question; type mismatch and unrelated foreign questions still refused", async () => {
    const s = await started();
    const db = getDb();
    const [outline] = await db.insert(assessments).values({ owner_sub: TEACHER, name: "Outline" }).returning();
    const [outlineQ, otherQ] = await db
      .insert(items)
      .values([
        { assessment_id: outline!.id, position: 0, type: "essay", stem: "Outline your argument" },
        { assessment_id: outline!.id, position: 1, type: "essay", stem: "Another outline question" },
      ])
      .returning();
    const [set] = await db
      .insert(item_sets)
      .values({ assessment_id: s.assessment.id, stimulus_text: "Your outline:", source_item_id: outlineQ!.id })
      .returning();
    await db.update(items).set({ item_set_id: set!.id }).where(eq(items.id, s.essay.id));

    const ok = await put(s.attempt.id, outlineQ!.id, { type: "essay", text: "Cars should yield" });
    expect(ok.status).toBe(200);
    const [stored] = await db
      .select()
      .from(responses)
      .where(and(eq(responses.attempt_id, s.attempt.id), eq(responses.item_id, outlineQ!.id)));
    expect(stored?.response).toEqual({ type: "essay", text: "Cars should yield" });

    const mismatch = await put(s.attempt.id, outlineQ!.id, { type: "short_text", text: "x" });
    expect(mismatch.status).toBe(400);
    expect(((await mismatch.json()) as { error: string }).error).toBe("response_type_mismatch");

    const unrelated = await put(s.attempt.id, otherQ!.id, { type: "essay", text: "not allowed" });
    expect(unrelated.status).toBe(404);
  });

  test("writes a response", async () => {
    const s = await started();
    const res = await put(s.attempt.id, s.mc.id, PICK);
    expect(res.status).toBe(200);
    const { response } = await res.json();
    expect(response.response).toEqual(PICK);
  });

  // The (attempt, item) unique constraint makes the upsert the natural
  // idempotency key, which is what the offline retry path needs.
  test("answering the same item again replaces, never duplicates", async () => {
    const s = await started();
    await put(s.attempt.id, s.mc.id, PICK);
    await put(s.attempt.id, s.mc.id, { type: "multiple_choice_single", choice_id: "c2" });

    const rows = await getDb().select().from(responses);
    expect(rows.length).toBe(1);
    expect((rows[0]!.response as { choice_id: string }).choice_id).toBe("c2");
  });

  // The jsonb column enforces nothing, and a mismatch is silently unscoreable:
  // an essay response on a multiple-choice item would score zero forever with
  // no error anywhere.
  test("refuses a response whose type is not the item's type", async () => {
    const s = await started();
    const res = await put(s.attempt.id, s.mc.id, { type: "essay", text: "wrong shape" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("response_type_mismatch");
    expect(body.item_type).toBe("multiple_choice_single");
    expect((await getDb().select().from(responses)).length).toBe(0);
  });

  test("refuses a payload the wire schema rejects", async () => {
    const s = await started();
    expect((await put(s.attempt.id, s.mc.id, { type: "multiple_choice_single" })).status).toBe(400);
    expect((await put(s.attempt.id, s.mc.id, { type: "telepathy" })).status).toBe(400);
    expect((await put(s.attempt.id, s.essay.id, { type: "essay", text: "ok" })).status).toBe(200);
  });

  // The responses table's FKs constrain each column separately and say nothing
  // about the two agreeing, so this check is the only thing stopping an answer
  // being filed against another teacher's item.
  test("refuses an item that belongs to a different assessment", async () => {
    const s = await started();
    const [other] = await getDb()
      .insert(assessments)
      .values({ owner_sub: TEACHER, name: "Elsewhere" })
      .returning();
    const [foreignItem] = await getDb()
      .insert(items)
      .values({
        assessment_id: other!.id,
        position: 1,
        type: "multiple_choice_single",
        stem: "Not yours",
        choices: [{ id: "c1", text: "one" }, { id: "c2", text: "two" }],
      })
      .returning();

    expect((await put(s.attempt.id, foreignItem!.id, PICK)).status).toBe(404);
    expect((await getDb().select().from(responses)).length).toBe(0);
  });

  test("a submitted attempt no longer accepts writes", async () => {
    const s = await started();
    await submit(s.attempt.id);
    const res = await put(s.attempt.id, s.mc.id, PICK);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("attempt_submitted");
  });

  // 404, not 403: telling them apart would confirm the attempt exists.
  test("another student cannot write into this attempt", async () => {
    const s = await started();
    await getDb()
      .insert(students)
      .values({
        owner_sub: TEACHER,
        ssid: OTHER_STUDENT.ssid,
        roster_ps_id: OTHER_STUDENT.ps_id,
        name: OTHER_STUDENT.name,
      });
    asStudent(OTHER_STUDENT.email);
    expect((await put(s.attempt.id, s.mc.id, PICK)).status).toBe(404);
  });
});

describe("DELETE /api/attempts/:id/responses/:itemId", () => {
  test("withdraws an answer, and doing so twice is not an error", async () => {
    const s = await scenario();
    asStudent();
    const { attempt } = await (await start(s.sitting.id)).json();
    await put(attempt.id, s.mc.id, PICK);
    expect((await getDb().select().from(responses)).length).toBe(1);

    expect((await del(attempt.id, s.mc.id)).status).toBe(204);
    expect((await getDb().select().from(responses)).length).toBe(0);

    // The caller's intent — no answer for this item — is satisfied either way.
    expect((await del(attempt.id, s.mc.id)).status).toBe(204);
  });

  test("a submitted attempt cannot have answers withdrawn", async () => {
    const s = await scenario();
    asStudent();
    const { attempt } = await (await start(s.sitting.id)).json();
    await put(attempt.id, s.mc.id, PICK);
    await submit(attempt.id);
    expect((await del(attempt.id, s.mc.id)).status).toBe(409);
    expect((await getDb().select().from(responses)).length).toBe(1);
  });
});

describe("POST /api/attempts/:id/submit", () => {
  test("submits, and a retry does not move the timestamp", async () => {
    const s = await scenario();
    asStudent();
    const { attempt } = await (await start(s.sitting.id)).json();

    const first = await (await submit(attempt.id)).json();
    expect(first.already_submitted).toBe(false);
    expect(first.attempt.status).toBe("submitted");
    const submittedAt = first.attempt.submitted_at;

    const second = await (await submit(attempt.id)).json();
    expect(second.already_submitted).toBe(true);
    // A flaky network retrying is indistinguishable from a double press, and a
    // teacher may be reading submitted_at as "when did they finish".
    expect(second.attempt.submitted_at).toBe(submittedAt);
  });

  test("another student cannot submit this attempt", async () => {
    const s = await scenario();
    asStudent();
    const { attempt } = await (await start(s.sitting.id)).json();

    await getDb()
      .insert(students)
      .values({
        owner_sub: TEACHER,
        ssid: OTHER_STUDENT.ssid,
        roster_ps_id: OTHER_STUDENT.ps_id,
        name: OTHER_STUDENT.name,
      });
    asStudent(OTHER_STUDENT.email);
    expect((await submit(attempt.id)).status).toBe(404);

    const [row] = await getDb().select().from(attempts).where(eq(attempts.id, attempt.id));
    expect(row?.status).toBe("in_progress");
  });
});

// R0.1: submit runs the same idempotent auto-scoring pass the teacher-facing
// score route runs (lib/scoring/runAutoScoring.ts), in the same request, and
// a scoring failure must never fail the hand-in.
describe("POST /api/attempts/:id/submit — auto-scoring (R0.1)", () => {
  const PICK_CORRECT = { type: "multiple_choice_single", choice_id: "c1" };

  test("leaves a final score for every auto-scorable answered item", async () => {
    const s = await scenario();
    asStudent();
    const { attempt } = await (await start(s.sitting.id)).json();
    await put(attempt.id, s.mc.id, PICK_CORRECT);

    const res = await submit(attempt.id);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.attempt.status).toBe("submitted");

    const [mcResponse] = await getDb()
      .select()
      .from(responses)
      .where(and(eq(responses.attempt_id, attempt.id), eq(responses.item_id, s.mc.id)));
    const mcScores = await getDb()
      .select()
      .from(scores)
      .where(eq(scores.response_id, mcResponse!.id));
    expect(mcScores).toHaveLength(1);
    expect(mcScores[0]!.method).toBe("auto");
    expect(mcScores[0]!.status).toBe("final");
    expect(mcScores[0]!.points).toBe(1);
    expect(mcScores[0]!.max_points).toBe(1);
  });

  test("a non-auto item (essay) has no score row after submit", async () => {
    const s = await scenario();
    asStudent();
    const { attempt } = await (await start(s.sitting.id)).json();
    await put(attempt.id, s.mc.id, PICK_CORRECT);
    await put(attempt.id, s.essay.id, { type: "essay", text: "my answer" });

    await submit(attempt.id);

    const [essayResponse] = await getDb()
      .select()
      .from(responses)
      .where(and(eq(responses.attempt_id, attempt.id), eq(responses.item_id, s.essay.id)));
    const essayScores = await getDb()
      .select()
      .from(scores)
      .where(eq(scores.response_id, essayResponse!.id));
    expect(essayScores).toHaveLength(0);

    // The auto item is still scored — the essay being untouched isn't
    // because scoring didn't run at all.
    const allScores = await getDb().select().from(scores);
    expect(allScores).toHaveLength(1);
  });

  test("a scoring failure never fails the hand-in", async () => {
    const s = await scenario();
    asStudent();
    const { attempt } = await (await start(s.sitting.id)).json();
    await put(attempt.id, s.mc.id, PICK_CORRECT);

    scoringShouldThrow = true;
    const res = await submit(attempt.id);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.already_submitted).toBe(false);
    expect(body.attempt.status).toBe("submitted");

    const [row] = await getDb().select().from(attempts).where(eq(attempts.id, attempt.id));
    expect(row?.status).toBe("submitted");
    // The throw happened before any insert — no score exists.
    expect(await getDb().select().from(scores)).toHaveLength(0);
  });
});

// Slice 64: match and order options carry per-attempt sealed ids on the wire.
// These tests go through the real delivery route to get them, so what is
// exercised is the actual round trip rather than a reimplementation of the
// sealing on both ends.
describe("sealed option ids round-trip", () => {
  async function deliver(assessmentId: string) {
    const { GET } = await import("../app/api/assessments/[id]/delivery/route");
    const res = await GET(new Request("http://localhost/x"), {
      params: Promise.resolve({ id: assessmentId }),
    });
    return res.json();
  }

  test("a match answer in sealed ids is stored as authoring ids", async () => {
    const s = await scenario();
    asStudent();
    const { attempt } = await (await start(s.sitting.id)).json();
    const bundle = await deliver(s.assessment.id);
    const item = bundle.items.find((i: { type: string }) => i.type === "match");

    const leftFor = (text: string) =>
      item.lefts.find((l: { text: string }) => l.text === text).id;
    const rightFor = (text: string) =>
      item.rights.find((r: { text: string }) => r.text === text).id;

    // The student pairs correctly, in sealed ids.
    const res = await put(attempt.id, s.match.id, {
      type: "match",
      matches: {
        [leftFor("Dog")]: rightFor("Puppy"),
        [leftFor("Cat")]: rightFor("Kitten"),
      },
    });
    expect(res.status).toBe(200);

    // What lands in the column is authoring ids, so the scoring code — which
    // knows nothing about sealing — compares the right things.
    const [row] = await getDb().select().from(responses);
    expect(row!.response).toEqual({ type: "match", matches: { p1: "p1", p2: "p2" } });
  });

  test("an order answer in sealed ids is stored as authoring ids", async () => {
    const s = await scenario();
    asStudent();
    const { attempt } = await (await start(s.sitting.id)).json();
    const bundle = await deliver(s.assessment.id);
    const item = bundle.items.find((i: { type: string }) => i.type === "order");
    const idFor = (label: string) =>
      item.entries.find((e: { label: string }) => e.label === label).id;

    const res = await put(attempt.id, s.order.id, {
      type: "order",
      ordered_ids: [idFor("Third"), idFor("First"), idFor("Second")],
    });
    expect(res.status).toBe(200);

    const [row] = await getDb().select().from(responses);
    expect(row!.response).toEqual({ type: "order", ordered_ids: ["e3", "e1", "e2"] });
  });

  test("an authoring id submitted directly is refused", async () => {
    const s = await scenario();
    asStudent();
    const { attempt } = await (await start(s.sitting.id)).json();

    // A student who guesses p1/p2 gains nothing by sending them.
    const res = await put(attempt.id, s.match.id, {
      type: "match",
      matches: { p1: "p1" },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("unknown_option_id");
    expect((await getDb().select().from(responses)).length).toBe(0);
  });

  test("a fabricated sealed id is refused rather than half-stored", async () => {
    const s = await scenario();
    asStudent();
    const { attempt } = await (await start(s.sitting.id)).json();
    const bundle = await deliver(s.assessment.id);
    const item = bundle.items.find((i: { type: string }) => i.type === "order");

    const res = await put(attempt.id, s.order.id, {
      type: "order",
      ordered_ids: [item.entries[0].id, "deadbeefdeadbeefdeadbeef"],
    });
    expect(res.status).toBe(400);
    // A half-translated response would look legitimate and score as one.
    expect((await getDb().select().from(responses)).length).toBe(0);
  });

  test("ids issued for one attempt do not work in another", async () => {
    const s = await scenario();
    asStudent();
    const { attempt } = await (await start(s.sitting.id)).json();
    const bundle = await deliver(s.assessment.id);
    const item = bundle.items.find((i: { type: string }) => i.type === "order");
    const sealed = item.entries.map((e: { id: string }) => e.id);

    // Same student, a different attempt row: the anchor changes, so the ids do.
    const [otherAssessment] = await getDb()
      .insert(assessments)
      .values({ owner_sub: TEACHER, name: "Other" })
      .returning();
    const [otherItem] = await getDb()
      .insert(items)
      .values({
        assessment_id: otherAssessment!.id,
        position: 1,
        type: "order",
        stem: "Order",
        config: { sequence: [{ id: "e1", label: "A" }, { id: "e2", label: "B" }] },
      })
      .returning();
    const [otherAttempt] = await getDb()
      .insert(attempts)
      .values({
        assessment_id: otherAssessment!.id,
        student_id: s.student.id,
        status: "in_progress",
      })
      .returning();

    const res = await put(otherAttempt!.id, otherItem!.id, {
      type: "order",
      ordered_ids: sealed.slice(0, 2),
    });
    expect(res.status).toBe(400);
    void attempt;
  });
});

// E3 slice 1: a table answer is stored as sent — row and column ids are
// structure, not a key, so nothing is sealed or translated on the way in.
describe("PUT a table response (E3)", () => {
  async function withTable() {
    const s = await scenario();
    const [table] = await getDb()
      .insert(items)
      .values({
        assessment_id: s.assessment.id,
        position: 5,
        type: "table",
        stem: "Fill in",
        config: {
          columns: [{ id: "c1", label: "A" }, { id: "c2", label: "B" }],
          rows: [{ id: "r1", label: "x" }],
          cell_keys: { r1: { c1: "1" } },
        },
      })
      .returning();
    return { ...s, table: table! };
  }

  test("stores the cells verbatim and a second PUT replaces them", async () => {
    const s = await withTable();
    asStudent();
    const attempt = (await (await start(s.sitting.id)).json()).attempt;
    const first = await put(attempt.id, s.table.id, { type: "table", cells: { r1: { c1: "1", c2: "2" } } });
    expect(first.status).toBe(200);
    const second = await put(attempt.id, s.table.id, { type: "table", cells: { r1: { c2: "3" } } });
    expect(second.status).toBe(200);
    const rows = await getDb().select().from(responses).where(eq(responses.item_id, s.table.id));
    expect(rows.length).toBe(1);
    expect(rows[0]!.response).toEqual({ type: "table", cells: { r1: { c2: "3" } } });
  });

  test("an all-blank table is not a response (400), and the wrong type is refused", async () => {
    const s = await withTable();
    asStudent();
    const attempt = (await (await start(s.sitting.id)).json()).attempt;
    expect((await put(attempt.id, s.table.id, { type: "table", cells: {} })).status).toBe(400);
    const mismatch = await put(attempt.id, s.table.id, { type: "short_text", text: "1" });
    expect(mismatch.status).toBe(400);
    expect((await mismatch.json()).error).toBe("response_type_mismatch");
  });
});

// FB slice 1: a fill_blank answer is stored as sent — blank and option ids
// ship as authored, so nothing is unsealed — but every answer must name one
// of the item's blanks and a dropdown answer one of that blank's options.
describe("PUT a fill_blank response (FB)", () => {
  async function withFill() {
    const s = await scenario();
    const [fill] = await getDb()
      .insert(items)
      .values({
        assessment_id: s.assessment.id,
        position: 5,
        type: "fill_blank",
        stem: "The [[b1]] side; the [[b2]] side.",
        config: {
          blanks: [
            {
              id: "b1",
              kind: "dropdown",
              options: [{ id: "o1", text: "windward" }, { id: "o2", text: "leeward" }],
              correct_option_id: "o1",
            },
            { id: "b2", kind: "text", keys: ["dry"] },
          ],
        },
      })
      .returning();
    return { ...s, fill: fill! };
  }

  test("stores the answers verbatim and a second PUT replaces them", async () => {
    const s = await withFill();
    asStudent();
    const attempt = (await (await start(s.sitting.id)).json()).attempt;
    const first = await put(attempt.id, s.fill.id, { type: "fill_blank", answers: { b1: "o2", b2: "arid" } });
    expect(first.status).toBe(200);
    const second = await put(attempt.id, s.fill.id, { type: "fill_blank", answers: { b2: "dry" } });
    expect(second.status).toBe(200);
    const rows = await getDb().select().from(responses).where(eq(responses.item_id, s.fill.id));
    expect(rows.length).toBe(1);
    expect(rows[0]!.response).toEqual({ type: "fill_blank", answers: { b2: "dry" } });
  });

  test("refuses an unknown blank id, an unknown option id, an empty map and the wrong type", async () => {
    const s = await withFill();
    asStudent();
    const attempt = (await (await start(s.sitting.id)).json()).attempt;
    const unknownBlank = await put(attempt.id, s.fill.id, { type: "fill_blank", answers: { b9: "x" } });
    expect(unknownBlank.status).toBe(400);
    expect((await unknownBlank.json()).error).toBe("unknown_option_id");
    const unknownOption = await put(attempt.id, s.fill.id, { type: "fill_blank", answers: { b1: "o9" } });
    expect(unknownOption.status).toBe(400);
    expect((await unknownOption.json()).error).toBe("unknown_option_id");
    expect((await put(attempt.id, s.fill.id, { type: "fill_blank", answers: {} })).status).toBe(400);
    expect((await put(attempt.id, s.fill.id, { type: "fill_blank", answers: { b2: 3 } })).status).toBe(400);
    const mismatch = await put(attempt.id, s.fill.id, { type: "short_text", text: "dry" });
    expect(mismatch.status).toBe(400);
    expect((await mismatch.json()).error).toBe("response_type_mismatch");
  });

  test("a cleared dropdown (\"\") is accepted", async () => {
    const s = await withFill();
    asStudent();
    const attempt = (await (await start(s.sitting.id)).json()).attempt;
    expect((await put(attempt.id, s.fill.id, { type: "fill_blank", answers: { b1: "" } })).status).toBe(200);
  });
});

// Answer history (docs/answer-history-design.md, D-2): the write routes keep
// the value they replace when the rule says so.
describe("answer history on the student write routes", () => {
  async function started() {
    const s = await scenario();
    asStudent();
    const { attempt } = await (await start(s.sitting.id)).json();
    return { ...s, attempt };
  }
  const essay = (text: string) => ({ type: "essay", text });
  const revisions = () =>
    getDb().select().from(response_revisions).orderBy(response_revisions.captured_at);

  test("emptying an essay keeps the text it replaced (shrink)", async () => {
    const s = await started();
    const long = "A thoughtful paragraph about the causes of the war.";
    expect((await put(s.attempt.id, s.essay.id, essay(long))).status).toBe(200);
    // The first PUT replaced nothing.
    expect((await revisions()).length).toBe(0);

    expect((await put(s.attempt.id, s.essay.id, essay(""))).status).toBe(200);
    const kept = await revisions();
    expect(kept.length).toBe(1);
    expect(kept[0]!.reason).toBe("shrink");
    expect(kept[0]!.item_id).toBe(s.essay.id);
    expect((kept[0]!.response as { text: string }).text).toBe(long);
  });

  test("routine saves keep at most one copy a minute", async () => {
    const s = await started();
    await put(s.attempt.id, s.essay.id, essay("One"));
    await put(s.attempt.id, s.essay.id, essay("One two")); // interval: none kept yet
    await put(s.attempt.id, s.essay.id, essay("One two three")); // within the minute
    await put(s.attempt.id, s.essay.id, essay("One two three four"));
    const kept = await revisions();
    expect(kept.length).toBe(1);
    expect(kept[0]!.reason).toBe("interval");
    expect((kept[0]!.response as { text: string }).text).toBe("One");
  });

  test("withdrawing a text answer keeps it; a choice answer has no history", async () => {
    const s = await started();
    await put(s.attempt.id, s.essay.id, essay("Some words"));
    await put(s.attempt.id, s.mc.id, PICK);
    expect((await del(s.attempt.id, s.essay.id)).status).toBe(204);
    expect((await del(s.attempt.id, s.mc.id)).status).toBe(204);
    const kept = await revisions();
    expect(kept.length).toBe(1);
    expect(kept[0]!.reason).toBe("withdrawn");
    expect(kept[0]!.item_id).toBe(s.essay.id);
  });

  test("a refused write keeps nothing", async () => {
    const s = await started();
    await put(s.attempt.id, s.essay.id, essay("Handed in text"));
    await submit(s.attempt.id);
    expect((await put(s.attempt.id, s.essay.id, essay(""))).status).toBe(409);
    expect((await revisions()).length).toBe(0);
  });
});

// RT slice 1 (docs/rich-text-essay-design.md, D-7): a formatted essay's html
// is re-cleaned at ingest and `text` is derived from it; a plain essay drops
// any html the client sent.
describe("PUT a formatted essay (RT slice 1)", () => {
  async function started(richText: boolean) {
    const s = await scenario();
    if (richText) {
      await getDb().update(items).set({ config: { rich_text: true } }).where(eq(items.id, s.essay.id));
    }
    asStudent();
    const { attempt } = await (await start(s.sitting.id)).json();
    return { ...s, attempt };
  }
  const stored = async (attemptId: string, itemId: string) => {
    const [row] = await getDb()
      .select()
      .from(responses)
      .where(and(eq(responses.attempt_id, attemptId), eq(responses.item_id, itemId)));
    return row?.response;
  };

  test("rich_text on: html is cleaned and text is derived from it, whatever the client sent", async () => {
    const s = await started(true);
    const res = await put(s.attempt.id, s.essay.id, {
      type: "essay",
      text: "the client's own count — ignored",
      html: '<div data-indent="first" style="color:red"><b>Bold</b> start<script>x()</script></div><ul><li>one</li><li>two</li></ul>',
    });
    expect(res.status).toBe(200);
    expect(await stored(s.attempt.id, s.essay.id)).toEqual({
      type: "essay",
      text: "Bold start\n• one\n• two",
      html: '<p data-indent="first"><strong>Bold</strong> start</p><ul><li>one</li><li>two</li></ul>',
    });
  });

  test("rich_text on, html that cleans to nothing: stored as an empty text answer without html", async () => {
    const s = await started(true);
    expect(
      (await put(s.attempt.id, s.essay.id, { type: "essay", text: "x", html: "<p><br></p><img src=x>" })).status,
    ).toBe(200);
    expect(await stored(s.attempt.id, s.essay.id)).toEqual({ type: "essay", text: "" });
  });

  test("rich_text on, no html (a client older than v1.6.0): stored as sent", async () => {
    const s = await started(true);
    expect((await put(s.attempt.id, s.essay.id, { type: "essay", text: "plain words" })).status).toBe(200);
    expect(await stored(s.attempt.id, s.essay.id)).toEqual({ type: "essay", text: "plain words" });
  });

  test("rich_text off: any html is dropped and the text is kept as sent", async () => {
    const s = await started(false);
    expect(
      (await put(s.attempt.id, s.essay.id, { type: "essay", text: "my words", html: "<p><b>my</b> words</p>" }))
        .status,
    ).toBe(200);
    expect(await stored(s.attempt.id, s.essay.id)).toEqual({ type: "essay", text: "my words" });
  });

  test("answer history keeps the html with the version it replaced", async () => {
    const s = await started(true);
    const long = "<p><em>A thoughtful paragraph</em> about the causes of the war.</p>";
    expect((await put(s.attempt.id, s.essay.id, { type: "essay", text: "", html: long })).status).toBe(200);
    expect((await put(s.attempt.id, s.essay.id, { type: "essay", text: "", html: "<p>x</p>" })).status).toBe(200);
    const kept = await getDb().select().from(response_revisions);
    expect(kept.length).toBe(1);
    expect(kept[0]!.reason).toBe("shrink");
    expect(kept[0]!.response).toEqual({
      type: "essay",
      text: "A thoughtful paragraph about the causes of the war.",
      html: long,
    });
  });
});

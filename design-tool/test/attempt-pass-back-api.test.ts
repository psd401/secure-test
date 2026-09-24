// Pass back a handed-in attempt (docs/pass-back-design.md, slice 1):
// `lib/api/passBackAttempt.ts` and `POST /api/attempts/[attemptId]/pass-back`.
//
// Harness: sitting-closed.test.ts's — a real student principal off the roster
// fixture and a staff one, switched per call, with the routes driven in process
// against the test DB. Both planes are needed in ONE file because the point of
// the feature is not the status column: it is that the STUDENT can write and
// hand in again afterwards, and a route that flipped a status nothing enforced
// would pass every teacher-side assertion above.
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { closeDb, getDb } from "../db/client";
import {
  access_grants,
  assessments,
  attempt_events,
  attempts,
  items,
  responses,
  scores,
  students,
  test_sessions,
} from "../db/schema";
import { SESSION_COOKIE_NAME } from "../lib/auth/session";
import * as sessionMod from "../lib/auth/session";
import { passBackAttempt } from "../lib/api/passBackAttempt";
import {
  OTHER_TEACHER_EMAIL,
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
    throw new Error(`pass-back tests require the test DB DATABASE_URL; got: ${url}`);
  }
};

const OWNER = "pass-back-teacher";
const OTHER_OWNER = "pass-back-other-teacher";

type Principal = { sub: string; role: string; email?: string } | null;
let principal: Principal = staffPrincipal(OWNER);

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

beforeAll(async () => {
  expectTestDb();
  await seedRoster();
  originalSecret = process.env.DESIGN_TOOL_SESSION_SECRET;
  process.env.DESIGN_TOOL_SESSION_SECRET ||= "pass-back-test-secret-do-not-use";
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

let codeSeq = 0;

/**
 * A handed-in attempt with two answers — an auto-scored MC carrying a `final`,
 * and a hand-scored essay carrying nothing — on an open sitting.
 *
 * @param timeLimitSeconds a limit makes the assessment timed, which is what
 *   turns `ends_at` from optional into required.
 * @param overrideAt an extension already granted, so one case can prove an
 *   override alone makes an UNLIMITED assessment timed for this route.
 * @param status "submitted" unless a case is about the refusal.
 */
async function scenario(
  opts: {
    timeLimitSeconds?: number | null;
    overrideAt?: Date | null;
    status?: "in_progress" | "submitted";
    scoreStatus?: "final" | "proposed" | "research";
  } = {},
) {
  const db = getDb();
  const [assessment] = await db
    .insert(assessments)
    .values({
      owner_sub: OWNER,
      owner_email: TEACHER_EMAIL,
      name: "Pass back",
      status: "published",
      time_limit_seconds: opts.timeLimitSeconds ?? null,
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
  const [essay] = await db
    .insert(items)
    .values({
      assessment_id: assessment!.id,
      position: 1,
      type: "essay",
      stem: "Explain",
    })
    .returning();

  const [sitting] = await db
    .insert(test_sessions)
    .values({
      assessment_id: assessment!.id,
      owner_sub: OWNER,
      owner_email: TEACHER_EMAIL,
      code: `PB${(codeSeq++).toString().padStart(4, "0")}`,
      status: "open",
      expires_at: new Date(Date.now() + 60 * 60_000),
    })
    .returning();

  // One overlay row per (owner, ssid) — a test that builds two scenarios must
  // reuse it rather than trip the unique index. Attempts are unique per
  // (assessment, student), and each scenario brings its own assessment.
  const existing = await db
    .select()
    .from(students)
    .where(eq(students.ssid, STUDENT.ssid))
    .limit(1);
  const student =
    existing[0] ??
    (
      await db
        .insert(students)
        .values({
          owner_sub: OWNER,
          ssid: STUDENT.ssid,
          roster_ps_id: STUDENT.ps_id,
          name: STUDENT.name,
        })
        .returning()
    )[0];

  const status = opts.status ?? "submitted";
  const [attempt] = await db
    .insert(attempts)
    .values({
      assessment_id: assessment!.id,
      student_id: student!.id,
      test_session_id: sitting!.id,
      status,
      // Far enough back that a short limit is already expired, which is the
      // real state of every passed-back attempt on a timed assessment.
      started_at: new Date(Date.now() - 60 * 60_000),
      submitted_at: status === "submitted" ? new Date() : null,
      deadline_override_at: opts.overrideAt ?? null,
    })
    .returning();

  const [mcResponse, essayResponse] = await db
    .insert(responses)
    .values([
      {
        attempt_id: attempt!.id,
        item_id: mc!.id,
        response: { type: "multiple_choice_single", choice_id: "c1" },
      },
      {
        attempt_id: attempt!.id,
        item_id: essay!.id,
        response: { type: "essay", text: "A first draft." },
      },
    ])
    .returning();

  const [score] = await db
    .insert(scores)
    .values({
      response_id: mcResponse!.id,
      method: "auto",
      points: 1,
      max_points: 1,
      scorer: "auto",
      status: opts.scoreStatus ?? "final",
    })
    .returning();

  return {
    assessment: assessment!,
    mc: mc!,
    essay: essay!,
    sitting: sitting!,
    student: student!,
    attempt: attempt!,
    mcResponse: mcResponse!,
    essayResponse: essayResponse!,
    score: score!,
  };
}

const inMinutes = (n: number) => new Date(Date.now() + n * 60_000).toISOString();

async function passBack(attemptId: string, endsAt?: string, raw?: string) {
  const { POST } = await import("../app/api/attempts/[attemptId]/pass-back/route");
  return POST(
    new Request(`http://localhost/api/attempts/${attemptId}/pass-back`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: raw ?? JSON.stringify(endsAt ? { ends_at: endsAt } : {}),
    }),
    { params: Promise.resolve({ attemptId }) },
  );
}

async function attemptRow(id: string) {
  const [row] = await getDb().select().from(attempts).where(eq(attempts.id, id));
  return row!;
}

async function eventsOf(attemptId: string) {
  return getDb()
    .select()
    .from(attempt_events)
    .where(eq(attempt_events.attempt_id, attemptId));
}

async function scoresOf(responseId: string) {
  return getDb().select().from(scores).where(eq(scores.response_id, responseId));
}

// ── The write, on its own ────────────────────────────────────────────────────

describe("passBackAttempt", () => {
  test("finals become superseded and are counted; the flip and the event go with them", async () => {
    const s = await scenario();
    const before = await attemptRow(s.attempt.id);
    const now = new Date();

    const result = await passBackAttempt(getDb(), before, OWNER, { now });
    expect(result.superseded_scores).toBe(1);

    const [score] = await scoresOf(s.mcResponse.id);
    expect(score!.status).toBe("superseded");
    // The number itself is KEPT (D-2) — it is a record, not a deletion.
    expect(score!.points).toBe(1);
    expect(score!.max_points).toBe(1);

    const row = await attemptRow(s.attempt.id);
    expect(row.status).toBe("in_progress");
    expect(row.submitted_at).toBeNull();
    expect(row.submitted_by_sub).toBeNull();
    expect(row.pass_back_count).toBe(1);
    expect(row.updated_at.getTime()).toBe(now.getTime());

    const events = await eventsOf(s.attempt.id);
    expect(events.map((e) => e.kind)).toEqual(["passed_back"]);
    expect(events[0]!.detail).toEqual({
      by: OWNER,
      previously_submitted_at: before.submitted_at!.toISOString(),
      superseded_scores: 1,
      ends_at: null,
    });
  });

  test("a proposed row stays proposed and a research row is untouched", async () => {
    for (const scoreStatus of ["proposed", "research"] as const) {
      const s = await scenario({ scoreStatus });
      const result = await passBackAttempt(getDb(), await attemptRow(s.attempt.id), OWNER);
      expect(result.superseded_scores).toBe(0);
      const [score] = await scoresOf(s.mcResponse.id);
      expect(score!.status).toBe(scoreStatus);
      const db = getDb();
      await db.execute(sql`truncate table assessments restart identity cascade`);
      await db.execute(sql`truncate table students restart identity cascade`);
    }
  });

  test("the count increments each time, and an attempt with no scores passes back fine", async () => {
    const s = await scenario();
    await getDb().delete(scores).where(eq(scores.response_id, s.mcResponse.id));

    const first = await passBackAttempt(getDb(), await attemptRow(s.attempt.id), OWNER);
    expect(first.superseded_scores).toBe(0);
    expect((await attemptRow(s.attempt.id)).pass_back_count).toBe(1);

    // The helper does not refuse — the ROUTE owns that refusal — so calling it
    // twice is the way to prove the counter is an increment, not a set-to-1.
    await passBackAttempt(getDb(), await attemptRow(s.attempt.id), OWNER);
    expect((await attemptRow(s.attempt.id)).pass_back_count).toBe(2);
    expect(await eventsOf(s.attempt.id)).toHaveLength(2);
  });

  test("an ends_at is written to the override and named on the event; without one nothing is erased", async () => {
    const withEnds = await scenario();
    const endsAt = new Date(Date.now() + 90 * 60_000);
    await passBackAttempt(getDb(), await attemptRow(withEnds.attempt.id), OWNER, { endsAt });
    expect((await attemptRow(withEnds.attempt.id)).deadline_override_at!.toISOString()).toBe(
      endsAt.toISOString(),
    );
    const events = await eventsOf(withEnds.attempt.id);
    expect((events[0]!.detail as Record<string, unknown>).ends_at).toBe(endsAt.toISOString());

    const db = getDb();
    await db.execute(sql`truncate table assessments restart identity cascade`);
    await db.execute(sql`truncate table students restart identity cascade`);

    // An extension already on the row survives a pass back that carries none:
    // a `null` write here would take the teacher's earlier decision away.
    const kept = new Date(Date.now() + 30 * 60_000);
    const existing = await scenario({ overrideAt: kept });
    await passBackAttempt(getDb(), await attemptRow(existing.attempt.id), OWNER);
    expect((await attemptRow(existing.attempt.id)).deadline_override_at!.toISOString()).toBe(
      kept.toISOString(),
    );
  });
});

// ── The route ────────────────────────────────────────────────────────────────

describe("POST /api/attempts/[attemptId]/pass-back", () => {
  test("the owner passes an untimed attempt back: the body, the row and the event", async () => {
    const s = await scenario();
    const res = await passBack(s.attempt.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      attempt_id: s.attempt.id,
      status: "in_progress",
      deadline_override_at: null,
      superseded_scores: 1,
    });
    expect((await eventsOf(s.attempt.id)).map((e) => e.kind)).toEqual(["passed_back"]);
  });

  test("an open sitting is NOT a refusal — passing back mid-period is the point", async () => {
    const s = await scenario();
    expect((await passBack(s.attempt.id)).status).toBe(200);
  });

  test("an in-progress attempt is 409 not_submitted, and so is a second press", async () => {
    const open = await scenario({ status: "in_progress" });
    const first = await passBack(open.attempt.id);
    expect(first.status).toBe(409);
    expect(await first.json()).toEqual({ ok: false, error: "not_submitted" });
    // Nothing written: the score still stands and no event was recorded.
    expect((await scoresOf(open.mcResponse.id))[0]!.status).toBe("final");
    expect(await eventsOf(open.attempt.id)).toHaveLength(0);

    const s = await scenario();
    expect((await passBack(s.attempt.id)).status).toBe(200);
    const second = await passBack(s.attempt.id);
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ ok: false, error: "not_submitted" });
    // The one press counted once.
    expect((await attemptRow(s.attempt.id)).pass_back_count).toBe(1);
  });

  test("a timed assessment requires ends_at (400) and writes nothing", async () => {
    const s = await scenario({ timeLimitSeconds: 600 });
    const res = await passBack(s.attempt.id);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: "ends_at_required" });
    expect((await attemptRow(s.attempt.id)).status).toBe("submitted");
    expect((await scoresOf(s.mcResponse.id))[0]!.status).toBe("final");
    expect(await eventsOf(s.attempt.id)).toHaveLength(0);
  });

  test("an override on an UNLIMITED assessment counts as timed", async () => {
    const s = await scenario({ overrideAt: new Date(Date.now() - 10 * 60_000) });
    expect((await passBack(s.attempt.id)).status).toBe(400);
    expect((await passBack(s.attempt.id, inMinutes(60))).status).toBe(200);
  });

  test("an ends_at in the past is 400 ends_at_past and writes nothing", async () => {
    const s = await scenario({ timeLimitSeconds: 600 });
    const res = await passBack(s.attempt.id, inMinutes(-1));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: "ends_at_past" });
    expect((await attemptRow(s.attempt.id)).status).toBe("submitted");
    expect(await eventsOf(s.attempt.id)).toHaveLength(0);
  });

  test("a timed pass back stores the new deadline and returns it", async () => {
    const s = await scenario({ timeLimitSeconds: 600 });
    const endsAt = inMinutes(120);
    const res = await passBack(s.attempt.id, endsAt);
    expect(res.status).toBe(200);
    expect((await res.json()).deadline_override_at).toBe(endsAt);
    expect((await attemptRow(s.attempt.id)).deadline_override_at!.toISOString()).toBe(endsAt);
  });

  test("an unlimited assessment IGNORES an ends_at rather than gaining a deadline", async () => {
    const s = await scenario();
    const res = await passBack(s.attempt.id, inMinutes(60));
    expect(res.status).toBe(200);
    expect((await res.json()).deadline_override_at).toBeNull();
    expect((await attemptRow(s.attempt.id)).deadline_override_at).toBeNull();
  });

  // Remove time limit (2026-09-24): a removed attempt is NOT timed — the pass
  // back asks for no deadline, gives it none, and the removal survives.
  test("a removed limit on a timed assessment: no ends_at needed, stays removed", async () => {
    const s = await scenario({ timeLimitSeconds: 600 });
    await getDb()
      .update(attempts)
      .set({ time_limit_removed: true })
      .where(eq(attempts.id, s.attempt.id));
    const res = await passBack(s.attempt.id, inMinutes(60));
    expect(res.status).toBe(200);
    expect((await res.json()).deadline_override_at).toBeNull();
    const row = await attemptRow(s.attempt.id);
    expect(row.status).toBe("in_progress");
    expect(row.time_limit_removed).toBe(true);
    expect(row.deadline_override_at).toBeNull();
  });

  test("a malformed body is 400 invalid_body; an absent one is fine", async () => {
    const bad = await scenario();
    expect((await passBack(bad.attempt.id, undefined, "{")).status).toBe(400);
    expect((await passBack(bad.attempt.id, undefined, '{"ends_at":123}')).status).toBe(400);
    expect((await passBack(bad.attempt.id, undefined, '{"ends_at":"whenever"}')).status).toBe(400);
    // Still submitted — none of the above got past the parse.
    expect((await attemptRow(bad.attempt.id)).status).toBe("submitted");
    expect((await passBack(bad.attempt.id, undefined, "")).status).toBe(200);
  });

  test("edit is the rung: a run-level grantee gets 404, an edit-level one gets through", async () => {
    const s = await scenario();
    const db = getDb();
    const grant = {
      grantee_email: OTHER_TEACHER_EMAIL,
      scope_kind: "assessment",
      scope_id: s.assessment.id,
      granted_by_sub: OWNER,
      granted_by_email: TEACHER_EMAIL,
    };
    await db.insert(access_grants).values({ ...grant, level: "run", note: "sub" });
    principal = staffPrincipal(OTHER_OWNER, OTHER_TEACHER_EMAIL);
    expect((await passBack(s.attempt.id)).status).toBe(404);
    expect((await attemptRow(s.attempt.id)).status).toBe("submitted");

    principal = staffPrincipal(OWNER);
    await db.delete(access_grants).where(eq(access_grants.scope_id, s.assessment.id));
    await db.insert(access_grants).values({ ...grant, level: "edit", note: "co-teacher" });
    principal = staffPrincipal(OTHER_OWNER, OTHER_TEACHER_EMAIL);
    expect((await passBack(s.attempt.id)).status).toBe(200);
  });

  test("another teacher gets 404; a student 403; no session 401", async () => {
    const s = await scenario();
    principal = staffPrincipal(OTHER_OWNER, OTHER_TEACHER_EMAIL);
    expect((await passBack(s.attempt.id)).status).toBe(404);
    principal = studentPrincipal();
    expect((await passBack(s.attempt.id)).status).toBe(403);
    principal = null;
    expect((await passBack(s.attempt.id)).status).toBe(401);
    principal = staffPrincipal(OWNER);
    expect((await attemptRow(s.attempt.id)).status).toBe("submitted");
  });

  test("an unknown id is 404, a malformed one 400", async () => {
    expect((await passBack("11111111-1111-4111-8111-111111111111")).status).toBe(404);
    expect((await passBack("nope")).status).toBe(400);
  });
});

// ── The student plane afterwards ─────────────────────────────────────────────

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

async function submit(attemptId: string) {
  const { POST } = await import("../app/api/attempts/[attemptId]/submit/route");
  return POST(new Request("http://localhost/x", { method: "POST" }), {
    params: Promise.resolve({ attemptId }),
  });
}

async function getDelivery(assessmentId: string) {
  const { GET } = await import("../app/api/assessments/[id]/delivery/route");
  return GET(new Request(`http://localhost/api/assessments/${assessmentId}/delivery`), {
    params: Promise.resolve({ id: assessmentId }) as Promise<{ id: string }>,
  });
}

describe("the student plane after a pass back", () => {
  test("an untimed attempt takes answers again, and the bundle brings them back", async () => {
    const s = await scenario();
    principal = studentPrincipal();
    // Before: terminal.
    expect(
      (await put(s.attempt.id, s.essay.id, { type: "essay", text: "nope" })).status,
    ).toBe(409);

    principal = staffPrincipal(OWNER);
    expect((await passBack(s.attempt.id)).status).toBe(200);

    principal = studentPrincipal();
    expect(
      (await put(s.attempt.id, s.essay.id, { type: "essay", text: "A second draft." })).status,
    ).toBe(200);

    // P-1 prefill on a passed-back attempt: the student opens it with the work
    // they already did, which is the whole reason this is not Delete attempt.
    const bundle = await (await getDelivery(s.assessment.id)).json();
    expect(bundle.saved_responses[s.essay.id]).toEqual({
      type: "essay",
      text: "A second draft.",
    });
    expect(bundle.saved_responses[s.mc.id]).toEqual({
      type: "multiple_choice_single",
      choice_id: "c1",
    });
  });

  test("a timed attempt takes answers only because of the new deadline", async () => {
    // The route REQUIRES an ends_at here; the helper does not, so passing back
    // without one through the helper is how the requirement is shown to be
    // load-bearing rather than ceremony.
    const s = await scenario({ timeLimitSeconds: 600 });
    await passBackAttempt(getDb(), await attemptRow(s.attempt.id), OWNER);
    principal = studentPrincipal();
    const refused = await put(s.attempt.id, s.essay.id, { type: "essay", text: "x" });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ ok: false, error: "time_expired" });

    principal = staffPrincipal(OWNER);
    await passBackAttempt(getDb(), await attemptRow(s.attempt.id), OWNER, {
      endsAt: new Date(Date.now() + 60 * 60_000),
    });
    principal = studentPrincipal();
    expect(
      (await put(s.attempt.id, s.essay.id, { type: "essay", text: "Later draft." })).status,
    ).toBe(200);
  });

  test("handing in again re-scores the changed answer: a NEW final beside the superseded one", async () => {
    const s = await scenario();
    principal = staffPrincipal(OWNER);
    expect((await passBack(s.attempt.id)).status).toBe(200);

    principal = studentPrincipal();
    // The student changes the MC answer to the WRONG choice — the number has to
    // follow the answer, which is exactly what the old `final` would have
    // blocked (`runAutoScoringPass` skips a response that already has one).
    expect(
      (await put(s.attempt.id, s.mc.id, { type: "multiple_choice_single", choice_id: "c2" }))
        .status,
    ).toBe(200);
    const handedIn = await submit(s.attempt.id);
    expect(handedIn.status).toBe(200);

    const row = await attemptRow(s.attempt.id);
    expect(row.status).toBe("submitted");
    expect(row.submitted_at).not.toBeNull();
    // The record and the new score sit side by side; the index allows exactly
    // one final, and it is the new one.
    const rows = await scoresOf(s.mcResponse.id);
    expect(rows).toHaveLength(2);
    const byStatus = new Map(rows.map((r) => [r.status, r]));
    expect(byStatus.get("superseded")!.points).toBe(1);
    expect(byStatus.get("final")!.points).toBe(0);
  });
});

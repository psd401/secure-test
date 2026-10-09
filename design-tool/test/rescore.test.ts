// Rescore with the current key (docs/rescore-after-key-change-design.md, E11,
// slice 1): `lib/scoring/rescore.ts`, `POST /api/assessments/[id]/rescore`,
// the `rescored` cause, the timeline wording and the Results count.
//
// Harness: change-score.test.ts's — a staff principal mocked at the session
// module, the route driven in process against the test DB.
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { closeDb, getDb } from "../db/client";
import {
  assessments,
  attempt_events,
  attempts,
  gradebook_push_scores,
  gradebook_pushes,
  items,
  responses,
  roster_sections,
  scores,
  students,
} from "../db/schema";
import { SESSION_COOKIE_NAME } from "../lib/auth/session";
import * as sessionMod from "../lib/auth/session";
import { changeFinalScore } from "../lib/api/changeScore";
import { buildTimeline } from "../lib/reporting/timeline";
import { buildResults } from "../lib/scoring/results";
import { applyRescore, loadRescorePlan } from "../lib/scoring/rescore";
import { listSupersededScores } from "../lib/scoring/supersededScores";
import { causeLine } from "../lib/scoring/changeScoreDialog";

const expectTestDb = () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("secure_test_design_tool_test")) {
    throw new Error(`rescore tests require the test DB; got: ${url}`);
  }
};

const OWNER = "rescore-teacher";
const OTHER = "rescore-other-teacher";
let mockSub: string | null = OWNER;

mock.module("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({
    get: (name: string) => (mockSub && name === SESSION_COOKIE_NAME ? { value: "x" } : undefined),
  }),
}));

mock.module("../lib/auth/session", () => ({
  ...sessionMod,
  readSessionFromCookies: async () => (mockSub ? { sub: mockSub, role: "staff" } : null),
}));

let originalSecret: string | undefined;

beforeAll(() => {
  expectTestDb();
  originalSecret = process.env.DESIGN_TOOL_SESSION_SECRET;
  process.env.DESIGN_TOOL_SESSION_SECRET ||= "rescore-test-secret-do-not-use";
});

afterEach(async () => {
  mockSub = OWNER;
  const db = getDb();
  await db.execute(sql`truncate table assessments restart identity cascade`);
  await db.execute(sql`truncate table students restart identity cascade`);
  await db.execute(sql`truncate table roster_sections restart identity cascade`);
});

afterAll(async () => {
  await closeDb();
  if (originalSecret === undefined) delete process.env.DESIGN_TOOL_SESSION_SECRET;
  else process.env.DESIGN_TOOL_SESSION_SECRET = originalSecret;
});

type AttemptStatus = "submitted" | "in_progress";

/**
 * One MC item (key "c2" — the WRONG key the students were scored against was
 * "c1") and one short-text item with no key. Each student answered both; the
 * MC answers were auto-scored against "c1" at hand-in.
 */
async function scene() {
  const db = getDb();
  const [assessment] = await db
    .insert(assessments)
    .values({ owner_sub: OWNER, name: "Rescore", status: "published" })
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
  const [st] = await db
    .insert(items)
    .values({
      assessment_id: assessment!.id,
      position: 1,
      type: "short_text",
      stem: "Name it",
    })
    .returning();

  async function student(
    ssid: string,
    choice: string,
    opts: { status?: AttemptStatus; practice?: boolean; score?: boolean } = {},
  ) {
    const [stu] = await db
      .insert(students)
      .values({ owner_sub: OWNER, ssid, name: `Student ${ssid}` })
      .returning();
    const status = opts.status ?? "submitted";
    const [attempt] = await db
      .insert(attempts)
      .values({
        assessment_id: assessment!.id,
        student_id: stu!.id,
        status,
        practice: opts.practice ?? false,
        submitted_at: status === "submitted" ? new Date() : null,
      })
      .returning();
    const [mcResponse, stResponse] = await db
      .insert(responses)
      .values([
        {
          attempt_id: attempt!.id,
          item_id: mc!.id,
          response: { type: "multiple_choice_single", choice_id: choice },
        },
        {
          attempt_id: attempt!.id,
          item_id: st!.id,
          response: { type: "short_text", text: "cell" },
        },
      ])
      .returning();
    let mcScore: typeof scores.$inferSelect | undefined;
    if (status === "submitted" && opts.score !== false) {
      [mcScore] = await db
        .insert(scores)
        .values({
          response_id: mcResponse!.id,
          method: "auto",
          points: choice === "c1" ? 1 : 0,
          max_points: 1,
          scorer: "auto",
          status: "final",
        })
        .returning();
    }
    return { attempt: attempt!, mcResponse: mcResponse!, stResponse: stResponse!, mcScore };
  }

  async function fixKey() {
    await db.update(items).set({ correct_choice_ids: ["c2"] }).where(eq(items.id, mc!.id));
  }

  return { assessment: assessment!, mc: mc!, st: st!, student, fixKey };
}

async function post(assessmentId: string, body: unknown) {
  const { POST } = await import("../app/api/assessments/[id]/rescore/route");
  return POST(
    new Request(`http://localhost/api/assessments/${assessmentId}/rescore`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: assessmentId }) },
  );
}

async function finals(responseId: string) {
  return getDb()
    .select()
    .from(scores)
    .where(and(eq(scores.response_id, responseId), eq(scores.status, "final")));
}

describe("loadRescorePlan", () => {
  test("nothing to do while the saved key is the one students were scored against", async () => {
    const s = await scene();
    await s.student("R-1", "c1");
    await s.student("R-2", "c2");
    const plan = await loadRescorePlan(getDb(), s.assessment.id);
    expect(plan.changes).toHaveLength(0);
    expect(plan.unchanged).toBe(2);
    expect(plan.students_changed).toBe(0);
    // The keyless short text is still unscorable.
    expect(plan.unscorable).toBe(2);
  });

  test("a fixed key changes every auto final it now scores differently", async () => {
    const s = await scene();
    await s.student("R-1", "c1");
    await s.student("R-2", "c2");
    await s.student("R-3", "c2");
    await s.fixKey();
    const plan = await loadRescorePlan(getDb(), s.assessment.id);
    expect(plan.changed).toBe(3);
    expect(plan.unchanged).toBe(0);
    expect(plan.students_changed).toBe(3);
    expect(plan.questions).toEqual([{ item_id: s.mc.id, position: 0, changed: 3, kept: 0 }]);
  });

  test("a key edited and edited back counts nothing", async () => {
    const s = await scene();
    await s.student("R-1", "c1");
    await s.fixKey();
    await getDb()
      .update(items)
      .set({ correct_choice_ids: ["c1"] })
      .where(eq(items.id, s.mc.id));
    const plan = await loadRescorePlan(getDb(), s.assessment.id);
    expect(plan.students_changed).toBe(0);
  });

  test("a key added after hand-in scores the never-scored answers", async () => {
    const s = await scene();
    await s.student("R-1", "c1");
    await getDb().update(items).set({ correct_answer: "cell" }).where(eq(items.id, s.st.id));
    const plan = await loadRescorePlan(getDb(), s.assessment.id);
    expect(plan.newly_scored).toBe(1);
    expect(plan.changed).toBe(0);
    expect(plan.students_changed).toBe(1);
  });

  test("in-progress and practice attempts are out of scope", async () => {
    const s = await scene();
    await s.student("R-1", "c1", { status: "in_progress" });
    await s.student("R-2", "c1", { practice: true });
    await s.fixKey();
    const plan = await loadRescorePlan(getDb(), s.assessment.id);
    expect(plan.changes).toHaveLength(0);
    expect(plan.students_changed).toBe(0);
  });

  test("a teacher-set score that differs from the new key is kept and counted (D-2)", async () => {
    const s = await scene();
    const a = await s.student("R-1", "c1");
    const b = await s.student("R-2", "c1");
    // The teacher already corrected R-1 by hand; R-2 is still the key's.
    await changeFinalScore(
      getDb(),
      { response_id: a.mcResponse.id, attempt_id: a.attempt.id, item_id: s.mc.id },
      { points: 1, max_points: 1 },
      OWNER,
    );
    void b;
    await s.fixKey();
    const plan = await loadRescorePlan(getDb(), s.assessment.id);
    expect(plan.changed).toBe(1);
    expect(plan.kept).toBe(1);
    expect(plan.questions).toEqual([{ item_id: s.mc.id, position: 0, changed: 1, kept: 1 }]);
  });
});

describe("POST /api/assessments/[id]/rescore", () => {
  test("dry run reports the counts and writes nothing", async () => {
    const s = await scene();
    const a = await s.student("R-1", "c1");
    await s.fixKey();
    const res = await post(s.assessment.id, { dry_run: true });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, dry_run: true, changed: 1, students_changed: 1 });
    const rows = await finals(a.mcResponse.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(a.mcScore!.id);
  });

  test("the write supersedes the old final, writes an auto final, logs the event", async () => {
    const s = await scene();
    const a = await s.student("R-1", "c1");
    const b = await s.student("R-2", "c2");
    await s.fixKey();
    expect((await buildResults(s.assessment.id)).rescore_students).toBe(2);

    const res = await post(s.assessment.id, { dry_run: false });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      ok: true,
      dry_run: false,
      changed: 2,
      written: 2,
      skipped_conflict: 0,
      sections_sent_before: [],
    });

    const [aFinal] = await finals(a.mcResponse.id);
    expect(aFinal).toMatchObject({
      method: "auto",
      points: 0,
      max_points: 1,
      scorer: "auto",
      reviewed_by_sub: OWNER,
    });
    expect(aFinal!.rationale).toEqual({
      rescored: true,
      changed_from: { score_id: a.mcScore!.id, points: 1, method: "auto", scorer: "auto" },
    });
    const [bFinal] = await finals(b.mcResponse.id);
    expect(bFinal!.points).toBe(1);

    const events = await getDb()
      .select()
      .from(attempt_events)
      .where(
        and(eq(attempt_events.attempt_id, a.attempt.id), eq(attempt_events.kind, "score_changed")),
      );
    expect(events).toHaveLength(1);
    expect(events[0]!.detail).toEqual({
      source: "rescore",
      response_id: a.mcResponse.id,
      item_id: s.mc.id,
      from: 1,
      to: 0,
      max: 1,
    });

    const superseded = await listSupersededScores(getDb(), a.attempt.id);
    expect(superseded).toHaveLength(1);
    expect(superseded[0]!.cause).toBe("rescored");
    expect(causeLine(superseded[0]!)).toBe("rescored with the updated key to 0");

    const timeline = buildTimeline(
      events.map((e) => ({ kind: e.kind, at: e.at.toISOString(), detail: e.detail as Record<string, unknown> })),
    );
    expect(JSON.stringify(timeline)).toContain("Rescored with the updated key");

    const after = await buildResults(s.assessment.id);
    expect(after.rescore_students).toBe(0);
    expect(after.rows.map((r) => r.cells[0]!.points)).toEqual([0, 1]);
  });

  test("a teacher-set score is left alone by the write", async () => {
    const s = await scene();
    const a = await s.student("R-1", "c1");
    await s.student("R-2", "c1");
    const changed = await changeFinalScore(
      getDb(),
      { response_id: a.mcResponse.id, attempt_id: a.attempt.id, item_id: s.mc.id },
      { points: 1, max_points: 1 },
      OWNER,
    );
    await s.fixKey();
    const res = await post(s.assessment.id, { dry_run: false });
    expect((await res.json()).written).toBe(1);
    const [aFinal] = await finals(a.mcResponse.id);
    expect(aFinal!.id).toBe(changed.ok ? changed.score.id : "");
    expect(aFinal!.method).toBe("human");
  });

  test("a stale press answers 409 nothing_to_rescore", async () => {
    const s = await scene();
    await s.student("R-1", "c1");
    const res = await post(s.assessment.id, { dry_run: false });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("nothing_to_rescore");
  });

  test("names the sections already sent to a gradebook (D-3)", async () => {
    const s = await scene();
    const a = await s.student("R-1", "c1");
    const db = getDb();
    await db.insert(roster_sections).values({
      ps_id: "SEC-1",
      course_name: "Biology",
      period_expression: "2(A)",
      last_seen_snapshot_id: "snap",
    });
    const [push] = await db
      .insert(gradebook_pushes)
      .values({
        assessment_id: s.assessment.id,
        section_ps_id: "SEC-1",
        target: "powerschool",
        name: "Rescore",
        created_by_sub: OWNER,
        external_assignment_id: "1",
        last_sent_at: new Date(),
      })
      .returning();
    await db
      .insert(gradebook_push_scores)
      .values({ push_id: push!.id, attempt_id: a.attempt.id, points_sent: 1 });
    await s.fixKey();
    const res = await post(s.assessment.id, { dry_run: false });
    const body = await res.json();
    expect(body.sections_sent_before).toHaveLength(1);
    expect(body.sections_sent_before[0]).toContain("Biology");
  });

  test("another teacher gets 404 and nothing is written", async () => {
    const s = await scene();
    const a = await s.student("R-1", "c1");
    await s.fixKey();
    mockSub = OTHER;
    const res = await post(s.assessment.id, { dry_run: false });
    expect(res.status).toBe(404);
    const rows = await finals(a.mcResponse.id);
    expect(rows[0]!.id).toBe(a.mcScore!.id);
  });

  test("a bad body is 400", async () => {
    const s = await scene();
    const res = await post(s.assessment.id, {});
    expect(res.status).toBe(400);
  });

  test("a score the teacher changed after the dry run is kept, not overwritten", async () => {
    // applyRescore re-plans inside its transaction, so a Change between the
    // dialog's dry run and the confirm is seen as a human final. (The flip's
    // own `method = auto` guard covers the narrower race inside the
    // transaction; it is not exercised here.)
    const s = await scene();
    const a = await s.student("R-1", "c1");
    await s.fixKey();
    const plan = await loadRescorePlan(getDb(), s.assessment.id);
    expect(plan.changed).toBe(1);
    await changeFinalScore(
      getDb(),
      { response_id: a.mcResponse.id, attempt_id: a.attempt.id, item_id: s.mc.id },
      { points: 1, max_points: 1 },
      OWNER,
    );
    // The re-plan inside applyRescore now sees a human final: kept, not written.
    const result = await applyRescore(getDb(), s.assessment.id, OWNER);
    expect(result.written).toBe(0);
    expect(result.plan.kept).toBe(1);
  });
});

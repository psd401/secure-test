// Roadmap U-25 slice 1 (docs/bulk-pass-back-and-corrections-design.md):
// "Pass back everyone" — the per-attempt pass back applied to a list of
// attempts on one assessment, whichever sitting each last joined. Harness from
// assessment-hand-in-in-progress-api.test.ts (U-14); the grant rung from
// attempt-pass-back-api.test.ts.
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
import * as headersMod from "next/headers";
import * as sessionMod from "../lib/auth/session";
import { NO_SECTION } from "../lib/scoring/sectionFilter";
import {
  OTHER_TEACHER_EMAIL,
  TEACHER_EMAIL,
  clearRoster,
  seedRoster,
  staffPrincipal,
} from "./helpers/roster";

const expectTestDb = () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("secure_test_design_tool_test")) {
    throw new Error(`assessment pass-back tests require the test DB DATABASE_URL; got: ${url}`);
  }
};

const OWNER = "bulk-pass-back-teacher";
const OTHER_OWNER = "bulk-pass-back-other-teacher";

type Principal = { sub: string; role: string; email?: string } | null;
let principal: Principal = staffPrincipal(OWNER);
let originalSessionSecret: string | undefined;

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

beforeAll(async () => {
  expectTestDb();
  await seedRoster();
  originalSessionSecret = process.env.DESIGN_TOOL_SESSION_SECRET;
  process.env.DESIGN_TOOL_SESSION_SECRET = "test-session-secret-do-not-use";
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
  if (originalSessionSecret === undefined) delete process.env.DESIGN_TOOL_SESSION_SECRET;
  else process.env.DESIGN_TOOL_SESSION_SECRET = originalSessionSecret;
});

interface SeedAttempt {
  status?: "in_progress" | "submitted";
  practice?: boolean;
  /** An extension a teacher granted by hand — makes the attempt timed even
   * on an untimed assessment. */
  overrideMinutesAgo?: number;
}

/**
 * One assessment, one closed sitting, and an attempt per spec — each with one
 * MC answer and, when handed in, one `final` score, so the supersession is
 * observable.
 */
let seedCount = 70;
async function seed(opts: { timeLimitSeconds?: number | null; attempts: SeedAttempt[] }) {
  seedCount++;
  const db = getDb();
  const [assessment] = await db
    .insert(assessments)
    .values({
      owner_sub: OWNER,
      name: "Pass back everyone",
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
        { id: "a", text: "A" },
        { id: "b", text: "B" },
      ],
      correct_choice_ids: ["a"],
    })
    .returning();
  const [sitting] = await db
    .insert(test_sessions)
    .values({
      assessment_id: assessment!.id,
      owner_sub: OWNER,
      code: `P${Math.floor(Math.random() * 100000)}`,
      status: "closed",
      expires_at: new Date(Date.now() + 3_600_000),
    })
    .returning();

  const rows = [];
  for (const [i, spec] of opts.attempts.entries()) {
    const [student] = await db
      .insert(students)
      .values({ owner_sub: OWNER, ssid: `${seedCount}${i}`, name: `Student ${i}` })
      .returning();
    const status = spec.status ?? "submitted";
    const [attempt] = await db
      .insert(attempts)
      .values({
        assessment_id: assessment!.id,
        student_id: student!.id,
        test_session_id: sitting!.id,
        status,
        practice: spec.practice ?? false,
        started_at: new Date(Date.now() - 60 * 60_000),
        submitted_at: status === "submitted" ? new Date() : null,
        deadline_override_at:
          spec.overrideMinutesAgo !== undefined
            ? new Date(Date.now() - spec.overrideMinutesAgo * 60_000)
            : null,
      })
      .returning();
    const [response] = await db
      .insert(responses)
      .values({
        attempt_id: attempt!.id,
        item_id: mc!.id,
        response: { type: "multiple_choice_single", choice_id: "a" },
      })
      .returning();
    if (status === "submitted") {
      await db.insert(scores).values({
        response_id: response!.id,
        method: "auto",
        points: 1,
        max_points: 1,
        scorer: "auto",
        status: "final",
      });
    }
    rows.push(attempt!);
  }
  return { assessment: assessment!, attempts: rows };
}

async function passBackAll(assessmentId: string, attemptIds: unknown, endsAt?: string) {
  const { POST } = await import("../app/api/assessments/[id]/pass-back/route");
  return POST(
    new Request(`http://localhost/api/assessments/${assessmentId}/pass-back`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ attempt_ids: attemptIds, ...(endsAt ? { ends_at: endsAt } : {}) }),
    }),
    { params: Promise.resolve({ id: assessmentId }) },
  );
}

async function passBackSection(assessmentId: string, section: string, endsAt?: string) {
  const { POST } = await import("../app/api/assessments/[id]/pass-back/route");
  return POST(
    new Request(`http://localhost/api/assessments/${assessmentId}/pass-back`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ section, ...(endsAt ? { ends_at: endsAt } : {}) }),
    }),
    { params: Promise.resolve({ id: assessmentId }) },
  );
}

async function listSections(assessmentId: string) {
  const { GET } = await import("../app/api/assessments/[id]/pass-back/route");
  return GET(new Request(`http://localhost/api/assessments/${assessmentId}/pass-back`), {
    params: Promise.resolve({ id: assessmentId }),
  });
}

async function attemptRow(attemptId: string) {
  const [row] = await getDb().select().from(attempts).where(eq(attempts.id, attemptId));
  return row!;
}

const inAnHour = () => new Date(Date.now() + 3_600_000).toISOString();

describe("POST /api/assessments/[id]/pass-back", () => {
  test("passes back every handed-in attempt: in progress, scores superseded, one event each", async () => {
    const a = await seed({ attempts: [{}, {}] });
    const res = await passBackAll(a.assessment.id, a.attempts.map((x) => x.id));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.passed_back).toBe(2);
    expect(body.skipped).toBe(0);
    expect(body.superseded_scores).toBe(2);

    const db = getDb();
    for (const attempt of a.attempts) {
      const row = await attemptRow(attempt.id);
      expect(row.status).toBe("in_progress");
      expect(row.submitted_at).toBeNull();
      expect(row.pass_back_count).toBe(1);
      // Untimed: no deadline appears.
      expect(row.deadline_override_at).toBeNull();
      const events = await db
        .select()
        .from(attempt_events)
        .where(eq(attempt_events.attempt_id, attempt.id));
      expect(events.map((e) => e.kind)).toEqual(["passed_back"]);
    }
    const finals = await db.select().from(scores).where(eq(scores.status, "final"));
    expect(finals).toHaveLength(0);
  });

  test("in-progress, practice and other-assessment ids are skipped and untouched", async () => {
    const a = await seed({
      attempts: [{}, { status: "in_progress" }, { practice: true }],
    });
    const b = await seed({ attempts: [{}] });
    const res = await passBackAll(a.assessment.id, [
      ...a.attempts.map((x) => x.id),
      b.attempts[0]!.id,
    ]);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.passed_back).toBe(1);
    expect(body.skipped).toBe(3);
    expect((await attemptRow(a.attempts[1]!.id)).pass_back_count).toBe(0);
    expect((await attemptRow(a.attempts[2]!.id)).status).toBe("submitted");
    expect((await attemptRow(b.attempts[0]!.id)).status).toBe("submitted");
  });

  test("a second call passes back 0", async () => {
    const a = await seed({ attempts: [{}] });
    expect((await passBackAll(a.assessment.id, [a.attempts[0]!.id])).status).toBe(200);
    const body = await (await passBackAll(a.assessment.id, [a.attempts[0]!.id])).json();
    expect(body.passed_back).toBe(0);
    expect(body.skipped).toBe(1);
    expect((await attemptRow(a.attempts[0]!.id)).pass_back_count).toBe(1);
  });

  test("timed: no deadline is 400 ends_at_required and nothing changes", async () => {
    const a = await seed({ timeLimitSeconds: 600, attempts: [{}, {}] });
    const res = await passBackAll(a.assessment.id, a.attempts.map((x) => x.id));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: "ends_at_required" });
    for (const attempt of a.attempts) {
      expect((await attemptRow(attempt.id)).status).toBe("submitted");
    }
  });

  test("timed: a past deadline is 400 ends_at_past", async () => {
    const a = await seed({ timeLimitSeconds: 600, attempts: [{}] });
    const res = await passBackAll(
      a.assessment.id,
      [a.attempts[0]!.id],
      new Date(Date.now() - 60_000).toISOString(),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: "ends_at_past" });
  });

  test("the deadline goes only to the timed attempts", async () => {
    // Untimed assessment; the second attempt carries a hand-granted extension,
    // which makes it timed (attemptIsTimed) and so requires a deadline.
    const a = await seed({ attempts: [{}, { overrideMinutesAgo: 10 }] });
    expect((await passBackAll(a.assessment.id, a.attempts.map((x) => x.id))).status).toBe(400);

    const endsAt = inAnHour();
    const res = await passBackAll(a.assessment.id, a.attempts.map((x) => x.id), endsAt);
    expect(res.status).toBe(200);
    expect((await attemptRow(a.attempts[0]!.id)).deadline_override_at).toBeNull();
    expect((await attemptRow(a.attempts[1]!.id)).deadline_override_at?.toISOString()).toBe(endsAt);
  });

  test("edit is the rung: a run-level grantee gets 404, an edit-level one gets through", async () => {
    const a = await seed({ attempts: [{}] });
    const db = getDb();
    const grant = {
      grantee_email: OTHER_TEACHER_EMAIL,
      scope_kind: "assessment",
      scope_id: a.assessment.id,
      granted_by_sub: OWNER,
      granted_by_email: TEACHER_EMAIL,
    };
    await db.insert(access_grants).values({ ...grant, level: "run", note: "sub" });
    principal = staffPrincipal(OTHER_OWNER, OTHER_TEACHER_EMAIL);
    expect((await passBackAll(a.assessment.id, [a.attempts[0]!.id])).status).toBe(404);
    expect((await attemptRow(a.attempts[0]!.id)).status).toBe("submitted");

    principal = staffPrincipal(OWNER);
    await db.delete(access_grants).where(eq(access_grants.scope_id, a.assessment.id));
    await db.insert(access_grants).values({ ...grant, level: "edit", note: "co-teacher" });
    principal = staffPrincipal(OTHER_OWNER, OTHER_TEACHER_EMAIL);
    expect((await passBackAll(a.assessment.id, [a.attempts[0]!.id])).status).toBe(200);
  });

  test("another teacher gets 404; a student 403; no session 401", async () => {
    const a = await seed({ attempts: [{}] });
    principal = staffPrincipal(OTHER_OWNER, OTHER_TEACHER_EMAIL);
    expect((await passBackAll(a.assessment.id, [a.attempts[0]!.id])).status).toBe(404);
    principal = { sub: "student-sub", role: "student" };
    expect((await passBackAll(a.assessment.id, [a.attempts[0]!.id])).status).toBe(403);
    principal = null;
    expect((await passBackAll(a.assessment.id, [a.attempts[0]!.id])).status).toBe(401);
    expect((await attemptRow(a.attempts[0]!.id)).status).toBe("submitted");
  });

  test("a malformed body or id is 400", async () => {
    const a = await seed({ attempts: [{}] });
    expect((await passBackAll(a.assessment.id, [])).status).toBe(400);
    expect((await passBackAll(a.assessment.id, ["nope"])).status).toBe(400);
    expect((await passBackAll(a.assessment.id, [a.attempts[0]!.id], "whenever")).status).toBe(400);
    expect((await passBackAll("nope", [a.attempts[0]!.id])).status).toBe(400);
  });

  // 4.1: the Test sessions list's picker. The seeded students have no roster
  // binding, so every row resolves to the Results filter's "no section" —
  // the label resolution itself is buildResults' (results-matrix tests).
  test("section mode: NO_SECTION passes back that section's handed-in attempts only", async () => {
    const a = await seed({ attempts: [{}, {}, { status: "in_progress" }] });
    const res = await passBackSection(a.assessment.id, NO_SECTION);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.passed_back).toBe(2);
    expect((await attemptRow(a.attempts[2]!.id)).pass_back_count).toBe(0);
  });

  test("section mode: a section nobody is in passes back 0", async () => {
    const a = await seed({ attempts: [{}] });
    const body = await (await passBackSection(a.assessment.id, "Period 9")).json();
    expect(body.passed_back).toBe(0);
    expect((await attemptRow(a.attempts[0]!.id)).status).toBe("submitted");
  });

  test("section mode: timed needs a deadline, like the id list", async () => {
    const a = await seed({ timeLimitSeconds: 600, attempts: [{}] });
    expect((await passBackSection(a.assessment.id, NO_SECTION)).status).toBe(400);
    expect((await passBackSection(a.assessment.id, NO_SECTION, inAnHour())).status).toBe(200);
  });

  test("both ids and a section, or neither, is 400", async () => {
    const a = await seed({ attempts: [{}] });
    const { POST } = await import("../app/api/assessments/[id]/pass-back/route");
    for (const body of [{ attempt_ids: [a.attempts[0]!.id], section: NO_SECTION }, {}]) {
      const res = await POST(
        new Request(`http://localhost/api/assessments/${a.assessment.id}/pass-back`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        { params: Promise.resolve({ id: a.assessment.id }) },
      );
      expect(res.status).toBe(400);
    }
    expect((await attemptRow(a.attempts[0]!.id)).status).toBe("submitted");
  });
});

describe("GET /api/assessments/[id]/pass-back", () => {
  test("lists sections with handed-in counts and whether a deadline is needed", async () => {
    const a = await seed({ timeLimitSeconds: 600, attempts: [{}, {}, { status: "in_progress" }] });
    const res = await listSections(a.assessment.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      sections: [{ section: NO_SECTION, handed_in: 2, timed: true }],
    });
  });

  test("nobody handed in is an empty list", async () => {
    const a = await seed({ attempts: [{ status: "in_progress" }] });
    expect((await (await listSections(a.assessment.id)).json()).sections).toEqual([]);
  });

  test("edit level: a run-level grantee gets 404", async () => {
    const a = await seed({ attempts: [{}] });
    await getDb().insert(access_grants).values({
      grantee_email: OTHER_TEACHER_EMAIL,
      scope_kind: "assessment",
      scope_id: a.assessment.id,
      granted_by_sub: OWNER,
      granted_by_email: TEACHER_EMAIL,
      level: "run",
      note: "sub",
    });
    principal = staffPrincipal(OTHER_OWNER, OTHER_TEACHER_EMAIL);
    expect((await listSections(a.assessment.id)).status).toBe(404);
  });
});

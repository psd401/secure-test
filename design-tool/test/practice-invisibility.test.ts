// Practice sittings (docs/practice-sitting-design.md, D-4): the ONE test that
// holds the invisibility guarantee — "a guarantee is a test, not a
// convention".
//
// One assessment, one class attempt and one practice attempt, both made
// through the real routes (a student joins the class sitting; the owner
// starts a practice sitting and joins it on their own staff session), both
// answered, both handed in and auto-scored. Then every class reader is asked
// in turn, and each must return ONLY the class attempt:
//
//   buildResults (default, include_in_progress)   the matrix's data
//   GET /api/assessments/[id]/results (+ ?format=csv)
//   the results page (matrix + analytics footer), rendered
//   GET /api/assessments/[id]/review-queue
//   the print report (+ its summary page), rendered
//   the work packet, rendered
//   loadItemAnalytics                              the analytics footer
//   POST /api/test-sessions/[id]/hand-in-all       on the CLASS sitting
//   selectCorpusResponses                          the scoring corpus
//   attendanceForSitting                           on the CLASS sitting
//   loadOverlay + GET /api/students                the Students list
//
// And the one reader that DOES show it: the per-student page, opened on the
// practice attempt.
//
// Every assertion checks both halves — the class student is there AND the
// practice principal is not — so a reader that returned nothing at all would
// fail rather than pass by accident.
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { closeDb, getDb } from "../db/client";
import {
  assessments,
  attempts,
  items,
  roster_sections,
  type AttemptRow,
  type TestSessionRow,
} from "../db/schema";
import { SESSION_COOKIE_NAME } from "../lib/auth/session";
import * as sessionMod from "../lib/auth/session";
import { sectionLabel, loadOverlay } from "../lib/roster/teacherRoster";
import { buildResults, resultsToCsv } from "../lib/scoring/results";
import { selectCorpusResponses } from "../lib/scoring/corpus";
import { attendanceForSitting } from "../lib/api/sittingAttendance";
import { practiceOverlayName } from "../lib/api/resolveStudent";
import {
  STUDENT,
  TEACHER_EMAIL,
  clearRoster,
  seedRoster,
  staffPrincipal,
  studentPrincipal,
  type TestPrincipal,
} from "./helpers/roster";

const expectTestDb = () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("secure_test_design_tool_test")) {
    throw new Error(`practice-invisibility tests require the test DB; got: ${url}`);
  }
};

const OWNER = "practice-invisibility-owner";
let principal: TestPrincipal | null = null;

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
  readStaffSessionFromCookies: async () =>
    principal && principal.role === "staff" ? principal : null,
}));

const asOwner = () => {
  principal = staffPrincipal(OWNER, TEACHER_EMAIL);
};

async function call(
  modPath: string,
  method: string,
  url: string,
  params: Record<string, string> = {},
  body?: unknown,
): Promise<Response> {
  const mod = (await import(modPath)) as Record<string, Function>;
  return (await mod[method]!(
    new Request(`http://localhost${url}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    { params: Promise.resolve(params) },
  )) as Response;
}

// ── the scene ────────────────────────────────────────────────────────────────

const PRACTICE_NAME = practiceOverlayName({ email: TEACHER_EMAIL });
let assessmentId = "";
let mcId = "";
let essayId = "";
let classSitting: TestSessionRow;
let practiceSitting: TestSessionRow;
let classAttempt: AttemptRow;
let practiceAttempt: AttemptRow;
let SECTION = "";

async function answerAndJoin(sittingId: string): Promise<AttemptRow> {
  const joined = await call("../app/api/attempts/route", "POST", "/api/attempts", {}, {
    test_session_id: sittingId,
  });
  expect(joined.status).toBe(201);
  const { attempt } = (await joined.json()) as { attempt: AttemptRow };
  for (const [itemId, response] of [
    [mcId, { type: "multiple_choice_single", choice_id: "a" }],
    [essayId, { type: "essay", text: "An answer worth reading." }],
  ] as const) {
    const put = await call(
      "../app/api/attempts/[attemptId]/responses/[itemId]/route",
      "PUT",
      `/api/attempts/${attempt.id}/responses/${itemId}`,
      { attemptId: attempt.id, itemId },
      { response },
    );
    expect(put.status).toBe(200);
  }
  return attempt;
}

beforeAll(async () => {
  expectTestDb();
  const db = getDb();
  await db.execute(sql`truncate table assessments restart identity cascade`);
  await db.execute(sql`truncate table students restart identity cascade`);
  await seedRoster();
  const [section] = await db
    .select()
    .from(roster_sections)
    .where(eq(roster_sections.ps_id, "5001"))
    .limit(1);
  SECTION = sectionLabel(section!);

  const [a] = await db
    .insert(assessments)
    .values({
      owner_sub: OWNER,
      owner_email: TEACHER_EMAIL,
      name: "Practice invisibility",
      status: "published",
    })
    .returning();
  assessmentId = a!.id;
  const [mc, essay] = await db
    .insert(items)
    .values([
      {
        assessment_id: assessmentId,
        position: 0,
        type: "multiple_choice_single",
        stem: "Pick one",
        choices: [
          { id: "a", text: "A" },
          { id: "b", text: "B" },
        ],
        correct_choice_ids: ["a"],
      },
      // Human-scored by default: lands in the review queue and the corpus.
      { assessment_id: assessmentId, position: 1, type: "essay", stem: "Write" },
    ])
    .returning();
  mcId = mc!.id;
  essayId = essay!.id;

  // The class sitting, for section 5001; the student joins and answers but
  // does not hand in (hand-in-all does that below).
  asOwner();
  const cs = await call("../app/api/test-sessions/route", "POST", "/api/test-sessions", {}, {
    assessment_id: assessmentId,
    section_ps_id: "5001",
  });
  expect(cs.status).toBe(201);
  classSitting = ((await cs.json()) as { test_session: TestSessionRow }).test_session;
  principal = studentPrincipal(STUDENT.email);
  classAttempt = await answerAndJoin(classSitting.id);

  // The practice sitting (D-1), and the owner sits it on their own session.
  asOwner();
  const ps = await call("../app/api/test-sessions/route", "POST", "/api/test-sessions", {}, {
    assessment_id: assessmentId,
    kind: "practice",
  });
  expect(ps.status).toBe(201);
  practiceSitting = ((await ps.json()) as { test_session: TestSessionRow }).test_session;
  expect(practiceSitting.kind).toBe("practice");
  expect(practiceSitting.practice_for_sub).toBe(OWNER);
  practiceAttempt = await answerAndJoin(practiceSitting.id);
  expect(practiceAttempt.practice).toBe(true);
  expect(classAttempt.practice).toBe(false);

  // Close the class sitting and hand everyone in — the hand-in-all reader.
  asOwner();
  const closed = await call(
    "../app/api/test-sessions/[sessionId]/close/route",
    "POST",
    `/api/test-sessions/${classSitting.id}/close`,
    { sessionId: classSitting.id },
  );
  expect(closed.status).toBe(200);
});

afterAll(async () => {
  const db = getDb();
  await db.execute(sql`truncate table assessments restart identity cascade`);
  await db.execute(sql`truncate table students restart identity cascade`);
  await clearRoster();
  await closeDb();
});

describe("practice attempts are invisible to every class reader (D-4)", () => {
  test("hand-in-all on the CLASS sitting hands in the class attempt only", async () => {
    asOwner();
    const res = await call(
      "../app/api/test-sessions/[sessionId]/hand-in-all/route",
      "POST",
      `/api/test-sessions/${classSitting.id}/hand-in-all`,
      { sessionId: classSitting.id },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { attempts: { attempt_id: string }[] };
    expect(body.attempts.map((a) => a.attempt_id)).toEqual([classAttempt.id]);
    const [p] = await getDb().select().from(attempts).where(eq(attempts.id, practiceAttempt.id));
    expect(p!.status).toBe("in_progress");

    // Now the practice attempt is handed in by its teacher, through the
    // student route, and auto-scored like any hand-in — the rest of this
    // suite reads a SCORED, handed-in practice attempt.
    const submitted = await call(
      "../app/api/attempts/[attemptId]/submit/route",
      "POST",
      `/api/attempts/${practiceAttempt.id}/submit`,
      { attemptId: practiceAttempt.id },
    );
    expect(submitted.status).toBe(200);
    asOwner();
  });

  test("buildResults — the matrix's rows, with and without in-progress", async () => {
    for (const opts of [{}, { include_in_progress: true }]) {
      const results = await buildResults(assessmentId, opts);
      expect(results.rows.map((r) => r.attempt_id)).toEqual([classAttempt.id]);
    }
    // The one opt-in (the per-student page) does see it.
    const withPractice = await buildResults(assessmentId, { include_practice: true });
    expect(withPractice.rows.map((r) => r.attempt_id).sort()).toEqual(
      [classAttempt.id, practiceAttempt.id].sort(),
    );
  });

  test("GET results JSON + CSV", async () => {
    const json = await call(
      "../app/api/assessments/[id]/results/route",
      "GET",
      `/api/assessments/${assessmentId}/results`,
      { id: assessmentId },
    );
    const body = JSON.stringify(await json.json());
    expect(body).toContain(classAttempt.id);
    expect(body).not.toContain(practiceAttempt.id);

    const csv = await call(
      "../app/api/assessments/[id]/results/route",
      "GET",
      `/api/assessments/${assessmentId}/results?format=csv`,
      { id: assessmentId },
    );
    const text = await csv.text();
    expect(text).toContain("Ada Fixture");
    expect(text).not.toContain(PRACTICE_NAME);
    expect(resultsToCsv(await buildResults(assessmentId))).toBe(text);
  });

  test("the results page (matrix + analytics footer)", async () => {
    const { default: ResultsPage } = await import("../app/dashboard/[id]/results/page");
    const html = renderToStaticMarkup(
      await ResultsPage({
        params: Promise.resolve({ id: assessmentId }),
        searchParams: Promise.resolve({}),
      }),
    );
    expect(html).toContain("Ada Fixture");
    expect(html).not.toContain(PRACTICE_NAME);
    expect(html).not.toContain(practiceAttempt.id);
  });

  test("the analytics footer's own query", async () => {
    const { loadItemAnalytics } = await import("../app/dashboard/[id]/results/analyticsQuery");
    const { submitted_count } = await loadItemAnalytics(assessmentId);
    expect(submitted_count).toBe(1);
  });

  test("GET review-queue", async () => {
    const res = await call(
      "../app/api/assessments/[id]/review-queue/route",
      "GET",
      `/api/assessments/${assessmentId}/review-queue`,
      { id: assessmentId },
    );
    expect(res.status).toBe(200);
    const { entries } = (await res.json()) as { entries: { attempt_id: string }[] };
    expect(entries.length).toBeGreaterThan(0);
    expect(new Set(entries.map((e) => e.attempt_id))).toEqual(new Set([classAttempt.id]));
  });

  test("the print report and its summary page", async () => {
    const { default: PrintPage } = await import("../app/dashboard/[id]/results/print/page");
    const html = renderToStaticMarkup(
      await PrintPage({
        params: Promise.resolve({ id: assessmentId }),
        searchParams: Promise.resolve({}),
      }),
    );
    expect(html).toContain("Ada Fixture");
    expect(html).not.toContain(PRACTICE_NAME);

    // The family-facing single page cannot be opened on a practice attempt.
    const single = renderToStaticMarkup(
      await PrintPage({
        params: Promise.resolve({ id: assessmentId }),
        searchParams: Promise.resolve({ attempt: practiceAttempt.id }),
      }),
    );
    expect(single).not.toContain(PRACTICE_NAME);
  });

  test("the work packet", async () => {
    const { default: WorkPage } = await import("../app/dashboard/[id]/results/work/page");
    const html = renderToStaticMarkup(
      await WorkPage({
        params: Promise.resolve({ id: assessmentId }),
        searchParams: Promise.resolve({ section: SECTION }),
      }),
    );
    expect(html).toContain("Ada Fixture");
    expect(html).not.toContain(PRACTICE_NAME);
  });

  test("the scoring corpus selection", async () => {
    const rows = await selectCorpusResponses(getDb(), { assessment: assessmentId, withHumanFinal: false });
    expect(rows.length).toBe(1);
    const [r] = await getDb().select().from(attempts).where(eq(attempts.id, rows[0]!.response.attempt_id));
    expect(r!.id).toBe(classAttempt.id);
  });

  test("attendanceForSitting on the CLASS sitting", async () => {
    const attendance = await attendanceForSitting(getDb(), classSitting);
    const ids = attendance.rows.map((r) => r.attempt_id).filter(Boolean);
    expect(ids).toContain(classAttempt.id);
    expect(ids).not.toContain(practiceAttempt.id);
    expect(attendance.rows.map((r) => r.name)).not.toContain(PRACTICE_NAME);
  });

  test("the Students list (the overlay page and GET /api/students)", async () => {
    const overlay = await loadOverlay(getDb(), OWNER);
    expect(overlay.map((o) => o.name)).toContain("Ada Fixture");
    expect(overlay.map((o) => o.name)).not.toContain(PRACTICE_NAME);

    const res = await call("../app/api/students/route", "GET", "/api/students");
    const { students } = (await res.json()) as { students: { name: string }[] };
    expect(students.map((s) => s.name)).toContain("Ada Fixture");
    expect(students.map((s) => s.name)).not.toContain(PRACTICE_NAME);
  });

  test("the per-student page is the one reader that DOES show it", async () => {
    const { default: AttemptPage } = await import(
      "../app/dashboard/[id]/results/[attemptId]/page"
    );
    const html = renderToStaticMarkup(
      await AttemptPage({
        params: Promise.resolve({ id: assessmentId, attemptId: practiceAttempt.id }),
      }),
    );
    expect(html).toContain(PRACTICE_NAME);
  });
});

// Gradebook push slice 2b (docs/gradebook-push-design.md): authorizeSend, the
// section's candidates and `POST /api/assessments/[id]/gradebook-send` +
// `GET …/gradebook-categories` end to end against the mock PowerSchool.
//
// The roster is the fictional fixture (test/helpers/roster.ts): teacher.one
// teaches 5001 (Algebra 1; section DCID 85001, year 31, term 3100, their
// users_dcid 8301); ada (1001, DCID 81001) and ben (1002, DCID 81002) are
// enrolled in it; cy (1003) is in teacher.two's 5002. All ids synthetic.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { closeDb, getDb } from "../db/client";
import {
  access_grants,
  assessments,
  attempt_events,
  attempts,
  gradebook_push_scores,
  gradebook_pushes,
  gradebook_section_prefs,
  items,
  responses,
  roster_section_teachers,
  roster_sections,
  roster_students,
  scores,
  students,
  test_sessions,
} from "../db/schema";
import { SESSION_COOKIE_NAME, type SessionPayload } from "../lib/auth/session";
import * as sessionMod from "../lib/auth/session";
import { authorizeSend } from "../lib/gradebook/authorizeSend";
import { loadSectionCandidates } from "../lib/gradebook/mapping";
import { mockPowerSchool } from "../lib/gradebook/powerschool";
import { todayPacific } from "../lib/gradebook/sendPowerSchool";
import { setLogSink } from "../lib/log";
import {
  BIOLOGY_STUDENT,
  OTHER_STUDENT,
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
    throw new Error(`gradebook-send tests require the test DB DATABASE_URL; got: ${url}`);
  }
};

const OWNER = "gradebook-owner";
const CO = "gradebook-co-teacher";
const ADMIN_EMAIL = "gradebook.admin@psd401.net";

type Principal = (SessionPayload & { role: string }) | null;
let principal: Principal = staffPrincipal(OWNER);

mock.module("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({
    get: (name: string) => (principal && name === SESSION_COOKIE_NAME ? { value: "x" } : undefined),
  }),
}));

mock.module("../lib/auth/session", () => ({
  ...sessionMod,
  readSessionFromCookies: async () => principal,
}));

const logLines: string[] = [];
let restoreSink: ((line: string) => void) | null = null;

beforeAll(async () => {
  expectTestDb();
  await seedRoster();
  restoreSink = setLogSink((line) => logLines.push(line));
});

beforeEach(() => {
  logLines.length = 0;
  mockPowerSchool.reset();
});

afterEach(async () => {
  principal = staffPrincipal(OWNER);
  delete process.env.ADMIN_EMAILS;
  const db = getDb();
  await db.execute(sql`truncate table assessments restart identity cascade`);
  await db.execute(sql`truncate table students restart identity cascade`);
  await db.execute(sql`truncate table access_grants restart identity cascade`);
  await db.execute(sql`truncate table gradebook_section_prefs`);
  // Undo the per-test roster edits.
  await db.delete(roster_section_teachers).where(eq(roster_section_teachers.teacher_ps_id, "399"));
  await db.update(roster_students).set({ dcid: "81002" }).where(eq(roster_students.ps_id, OTHER_STUDENT.ps_id));
  await db.update(roster_sections).set({ dcid: "85001" }).where(eq(roster_sections.ps_id, "5001"));
});

afterAll(async () => {
  if (restoreSink) setLogSink(restoreSink);
  await clearRoster();
  await closeDb();
});

// ── Scene ───────────────────────────────────────────────────────────────────

let codeSeq = 0;

async function scene() {
  const db = getDb();
  const [assessment] = await db
    .insert(assessments)
    .values({ owner_sub: OWNER, owner_email: TEACHER_EMAIL, name: "Unit 3 test", status: "published" })
    .returning();
  const itemRows = await db
    .insert(items)
    .values(
      [0, 1].map((position) => ({
        assessment_id: assessment!.id,
        position,
        type: "multiple_choice_single" as const,
        stem: `Q${position + 1}`,
        choices: [
          { id: "c1", text: "one" },
          { id: "c2", text: "two" },
        ],
        correct_choice_ids: ["c1"],
      })),
    )
    .returning();
  const sitting = async (section: string) =>
    (
      await db
        .insert(test_sessions)
        .values({
          assessment_id: assessment!.id,
          owner_sub: OWNER,
          owner_email: TEACHER_EMAIL,
          code: `GB${(codeSeq++).toString().padStart(4, "0")}`,
          status: "closed",
          section_ps_id: section,
          expires_at: new Date(Date.now() + 60 * 60_000),
        })
        .returning()
    )[0]!;
  return { assessment: assessment!, items: itemRows, algebra: await sitting("5001"), biology: await sitting("5002") };
}

type Scene = Awaited<ReturnType<typeof scene>>;

/** A handed-in attempt; `points[i]` null = that response has no final score. */
async function attempt(
  s: Scene,
  who: { ps_id: string; ssid: string },
  sittingId: string,
  points: Array<number | null>,
) {
  const db = getDb();
  // One overlay row per (owner, roster student), reused across assessments.
  const [existing] = await db
    .select()
    .from(students)
    .where(and(eq(students.owner_sub, OWNER), eq(students.roster_ps_id, who.ps_id)))
    .limit(1);
  const student =
    existing ??
    (
      await db
        .insert(students)
        .values({ owner_sub: OWNER, ssid: who.ssid, roster_ps_id: who.ps_id, name: "" })
        .returning()
    )[0];
  const [row] = await db
    .insert(attempts)
    .values({
      assessment_id: s.assessment.id,
      student_id: student!.id,
      test_session_id: sittingId,
      status: "submitted",
      submitted_at: new Date(),
    })
    .returning();
  for (const [i, p] of points.entries()) {
    const [response] = await db
      .insert(responses)
      .values({
        attempt_id: row!.id,
        item_id: s.items[i]!.id,
        response: { type: "multiple_choice_single", choice_id: "c1" },
      })
      .returning();
    if (p !== null) {
      await db.insert(scores).values({
        response_id: response!.id,
        method: "auto",
        points: p,
        max_points: 1,
        scorer: "auto",
        status: "final",
      });
    }
  }
  return row!;
}

async function scoreAll(attemptId: string, points: number) {
  const db = getDb();
  const rs = await db.select().from(responses).where(eq(responses.attempt_id, attemptId));
  for (const r of rs) {
    await db.delete(scores).where(eq(scores.response_id, r.id));
    await db.insert(scores).values({
      response_id: r.id,
      method: "auto",
      points,
      max_points: 1,
      scorer: "teacher",
      status: "final",
    });
  }
}

async function send(assessmentId: string, body: Record<string, unknown>) {
  const { POST } = await import("../app/api/assessments/[id]/gradebook-send/route");
  return POST(
    new Request(`http://localhost/api/assessments/${assessmentId}/gradebook-send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: assessmentId }) },
  );
}

async function categories(assessmentId: string, query: string) {
  const { GET } = await import("../app/api/assessments/[id]/gradebook-categories/route");
  return GET(new Request(`http://localhost/api/assessments/${assessmentId}/gradebook-categories?${query}`), {
    params: Promise.resolve({ id: assessmentId }),
  });
}

const BASE_BODY = { target: "powerschool", section_ps_id: "5001", category_id: "602", due_date: "2026-09-28" };

/** teacher.two teaching 5001 today, as a co-teacher (not in the fixture). */
async function addCoTeacherRow() {
  await getDb()
    .insert(roster_section_teachers)
    .values({
      section_ps_id: "5001",
      teacher_ps_id: "399",
      teacher_email: OTHER_TEACHER_EMAIL,
      role_name: "Co-Teacher",
      start_date: "2020-09-01",
      end_date: "2099-06-30",
      users_dcid: "8399",
      last_seen_snapshot_id: "test",
    });
}

async function grant(assessmentId: string, level: "run" | "edit") {
  await getDb().insert(access_grants).values({
    grantee_email: OTHER_TEACHER_EMAIL,
    scope_kind: "assessment",
    scope_id: assessmentId,
    level,
    granted_by_sub: OWNER,
    granted_by_email: TEACHER_EMAIL,
  });
}

// ── authorizeSend ───────────────────────────────────────────────────────────

describe("authorizeSend", () => {
  const db = getDb();
  const owner = () => staffPrincipal(OWNER) as SessionPayload;
  const co = () => staffPrincipal(CO, OTHER_TEACHER_EMAIL) as SessionPayload;

  test("the owner on a section they teach: ids from the roster", async () => {
    const s = await scene();
    const r = await authorizeSend(db, owner(), s.assessment.id, "5001");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.teacher).toEqual({ sub: OWNER, email: TEACHER_EMAIL, users_dcid: "8301" });
    expect(r.section).toEqual({ ps_id: "5001", dcid: "85001", year_id: "31", term_id: "3100" });
    expect(r.actor_sub).toBeNull();
  });

  test("the owner on a section they do not teach → 404", async () => {
    const s = await scene();
    const r = await authorizeSend(db, owner(), s.assessment.id, "5002");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(404);
  });

  test("a co-teacher needs BOTH the edit grant and a current roster row", async () => {
    const s = await scene();
    // Roster row, no grant.
    await addCoTeacherRow();
    let r = await authorizeSend(db, co(), s.assessment.id, "5001");
    expect(r.ok).toBe(false);
    // Grant + roster row: allowed, as their OWN users_dcid.
    await grant(s.assessment.id, "edit");
    r = await authorizeSend(db, co(), s.assessment.id, "5001");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.teacher.users_dcid).toBe("8399");
    // Grant, no roster row: refused.
    await db.delete(roster_section_teachers).where(eq(roster_section_teachers.teacher_ps_id, "399"));
    r = await authorizeSend(db, co(), s.assessment.id, "5001");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(404);
  });

  test("a run-level grantee (a substitute) → 404, even on the roster", async () => {
    const s = await scene();
    await addCoTeacherRow();
    await grant(s.assessment.id, "run");
    const r = await authorizeSend(db, co(), s.assessment.id, "5001");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(404);
  });

  test("admin act-as: allowed as the target teacher, actor_sub carried; a plain admin → 404", async () => {
    const s = await scene();
    const actingAs = {
      ...staffPrincipal(OWNER),
      actor_sub: "gradebook-admin",
      actor_email: ADMIN_EMAIL,
    } as SessionPayload;
    const r = await authorizeSend(db, actingAs, s.assessment.id, "5001");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.teacher.sub).toBe(OWNER);
      expect(r.actor_sub).toBe("gradebook-admin");
    }

    process.env.ADMIN_EMAILS = ADMIN_EMAIL;
    const plainAdmin = staffPrincipal("gradebook-admin", ADMIN_EMAIL) as SessionPayload;
    const denied = await authorizeSend(db, plainAdmin, s.assessment.id, "5001");
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.response.status).toBe(404);
  });
});

// ── Candidates ──────────────────────────────────────────────────────────────

describe("loadSectionCandidates", () => {
  test("the section's handed-in attempts with each student's DCID; other sections excluded", async () => {
    const s = await scene();
    const a = await attempt(s, STUDENT, s.algebra.id, [1, 1]);
    const b = await attempt(s, OTHER_STUDENT, s.algebra.id, [1, null]);
    await attempt(s, BIOLOGY_STUDENT, s.biology.id, [1, 1]);
    const { candidates, max_points } = await loadSectionCandidates(getDb(), s.assessment.id, "5001");
    expect(max_points).toBe(2);
    expect(candidates.map((c) => [c.attempt_id, c.student_number, c.student_dcid, c.total_points, c.unscored_count])).toEqual([
      [a.id, "1001", "81001", 2, 0],
      [b.id, "1002", "81002", 1, 1],
    ]);
  });
});

// ── The send, end to end on the mock ────────────────────────────────────────

describe("POST /api/assessments/[id]/gradebook-send", () => {
  test("first send: creates the assignment, writes the fully scored, holds back the rest", async () => {
    const s = await scene();
    const ada = await attempt(s, STUDENT, s.algebra.id, [1, 1]);
    await attempt(s, OTHER_STUDENT, s.algebra.id, [1, null]);

    const res = await send(s.assessment.id, BASE_BODY);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      ok: true,
      target: "powerschool",
      assignment_created: true,
      sent: 1,
      updated: 0,
      skipped_unchanged: 0,
      held_back: { count: 1, reasons: { unscored: 1, not_on_roster: 0, no_dcid: 0 } },
      failed: [],
      notes: [],
    });

    const calls = mockPowerSchool.calls;
    expect(calls.map((c) => c.method)).toEqual(["listCategories", "createAssignment", "writeScores"]);
    expect(calls[0]).toMatchObject({ usersDcid: "8301", yearId: "31" });
    expect(calls[1]!.body).toEqual({
      _assignmentsections: [
        {
          sectionsdcid: 85001,
          name: "Unit 3 test",
          duedate: "2026-09-28",
          scoretype: "POINTS",
          scoreentrypoints: 2,
          totalpointvalue: 2,
          weight: 1,
          iscountedinfinalgrade: true,
          isscoringneeded: true,
          publishoption: "Immediately",
          _assignmentcategoryassociations: [{ teachercategoryid: 602, isprimary: true }],
        },
      ],
    });
    expect(calls[2]).toMatchObject({ usersDcid: "8301", termId: "3100" });
    const writes = (calls[2]!.body!.assignment_scores as Record<string, unknown>[]);
    expect(writes.map((w) => [w.studentsdcid, w.scorepoints])).toEqual([[81001, 2]]);

    const db = getDb();
    const [push] = await db.select().from(gradebook_pushes);
    expect(push!.external_assignment_id).toBe(body.external_assignment_id);
    expect(push!.created_by_sub).toBe(OWNER);
    expect(push!.actor_sub).toBeNull();
    expect(push!.last_result).toMatchObject({ sent: 1, held_back: { count: 1 } });
    const pushScores = await db.select().from(gradebook_push_scores);
    expect(pushScores.map((p) => [p.attempt_id, p.points_sent])).toEqual([[ada.id, 2]]);
    // The live score write returns no assignmentscoreid (2026-09-29).
    expect(pushScores[0]!.external_score_id).toBeNull();

    const events = await db.select().from(attempt_events).where(eq(attempt_events.kind, "gradebook_sent"));
    expect(events.map((e) => [e.attempt_id, e.detail])).toEqual([
      [ada.id, { target: "powerschool", external_assignment_id: body.external_assignment_id, points: 2 }],
    ]);
    const [pref] = await db.select().from(gradebook_section_prefs);
    expect(pref).toMatchObject({ staff_sub: OWNER, section_ps_id: "5001", target: "powerschool", category_id: "602" });

    // No student number in any log line.
    expect(logLines.join("\n")).not.toContain("1001");
  });

  test("re-send: unchanged skipped, newly scored sent, changed updated in place; name ignored", async () => {
    const s = await scene();
    const ada = await attempt(s, STUDENT, s.algebra.id, [1, 1]);
    const ben = await attempt(s, OTHER_STUDENT, s.algebra.id, [1, null]);
    const first = await (await send(s.assessment.id, BASE_BODY)).json();

    mockPowerSchool.calls.length = 0;
    let body = await (await send(s.assessment.id, { ...BASE_BODY, name: "Renamed" })).json();
    expect(body).toMatchObject({ assignment_created: false, sent: 0, updated: 0, skipped_unchanged: 1 });
    expect(body.external_assignment_id).toBe(first.external_assignment_id);
    // Nothing to write: no PowerSchool call at all.
    expect(mockPowerSchool.calls).toEqual([]);

    await scoreAll(ben.id, 1);
    await scoreAll(ada.id, 0);
    body = await (await send(s.assessment.id, BASE_BODY)).json();
    expect(body).toMatchObject({ sent: 1, updated: 1, skipped_unchanged: 0, held_back: { count: 0 } });
    expect(mockPowerSchool.calls.map((c) => c.method)).toEqual(["writeScores"]);
    const rows = mockPowerSchool.calls[0]!.body!.assignment_scores as Record<string, unknown>[];
    const adaRow = rows.find((r) => r.studentsdcid === 81001)!;
    const benRow = rows.find((r) => r.studentsdcid === 81002)!;
    expect(adaRow.scorepoints).toBe(0);
    // No id is known (the live write returns none); the write updates in place.
    expect("assignmentscoreid" in adaRow).toBe(false);
    expect("assignmentscoreid" in benRow).toBe(false);
    expect(mockPowerSchool.scores.get(`${first.external_assignment_id}:81001`)?.points).toBe(0);

    const db = getDb();
    expect((await db.select().from(gradebook_pushes)).length).toBe(1);
    const [adaScore] = await db
      .select()
      .from(gradebook_push_scores)
      .where(eq(gradebook_push_scores.attempt_id, ada.id));
    expect(adaScore!.points_sent).toBe(0);
    const events = await db
      .select()
      .from(attempt_events)
      .where(and(eq(attempt_events.kind, "gradebook_sent"), eq(attempt_events.attempt_id, ada.id)));
    expect(events.length).toBe(2);
  });

  test("a student with no DCID is held back no_dcid; the due date defaults to today (PT)", async () => {
    const s = await scene();
    await attempt(s, STUDENT, s.algebra.id, [1, 1]);
    await attempt(s, OTHER_STUDENT, s.algebra.id, [1, 1]);
    await getDb().update(roster_students).set({ dcid: null }).where(eq(roster_students.ps_id, OTHER_STUDENT.ps_id));
    const { due_date: _omit, ...noDate } = BASE_BODY;
    const body = await (await send(s.assessment.id, noDate)).json();
    expect(body).toMatchObject({ sent: 1, held_back: { count: 1, reasons: { no_dcid: 1 } } });
    const create = mockPowerSchool.calls.find((c) => c.method === "createAssignment")!;
    const section = (create.body!._assignmentsections as Record<string, unknown>[])[0]!;
    expect(section.duedate).toBe(todayPacific());
  });

  test("everything held back: no assignment is created", async () => {
    const s = await scene();
    await attempt(s, STUDENT, s.algebra.id, [1, null]);
    const body = await (await send(s.assessment.id, BASE_BODY)).json();
    expect(body).toMatchObject({ assignment_created: false, sent: 0, held_back: { count: 1 } });
    expect(mockPowerSchool.calls).toEqual([]);
    expect(await getDb().select().from(gradebook_pushes)).toEqual([]);
  });

  test("a passed-back attempt's earlier score stays; the summary says so (8.3)", async () => {
    const s = await scene();
    const ada = await attempt(s, STUDENT, s.algebra.id, [1, 1]);
    await send(s.assessment.id, BASE_BODY);
    await getDb()
      .update(attempts)
      .set({ status: "in_progress", submitted_at: null, pass_back_count: 1 })
      .where(eq(attempts.id, ada.id));
    const body = await (await send(s.assessment.id, BASE_BODY)).json();
    expect(body.notes).toHaveLength(1);
    expect(body.notes[0]).toContain("passed back");
  });

  test("a 409 on the score write: every row failed with the body verbatim; nothing recorded; log masked", async () => {
    const s = await scene();
    await attempt(s, STUDENT, s.algebra.id, [1, 1]);
    const verbatim = '{"message":"Validation failed","studentsdcid":81001}';
    mockPowerSchool.failNext("writeScores", 409, verbatim);
    const res = await send(s.assessment.id, BASE_BODY);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ sent: 0, assignment_created: true, failed: [{ student_number: "1001", reason: verbatim }] });
    expect(await getDb().select().from(gradebook_push_scores)).toEqual([]);
    // No success → no remembered destination.
    expect(await getDb().select().from(gradebook_section_prefs)).toEqual([]);
    const errorLine = logLines.map((l) => JSON.parse(l)).find((l) => l.event === "gradebook_push_failed");
    expect(errorLine).toMatchObject({ level: "error", stage: "scores", status: 409 });
    expect(logLines.join("\n")).not.toContain("81001");
    expect(logLines.join("\n")).not.toContain("1001");
  });

  test("a create failure leaves no claim behind and surfaces a 409 body", async () => {
    const s = await scene();
    await attempt(s, STUDENT, s.algebra.id, [1, 1]);
    mockPowerSchool.failNext("createAssignment", 409, '{"message":"duedate outside term"}');
    const res = await send(s.assessment.id, BASE_BODY);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ ok: false, error: "create_failed", detail: '{"message":"duedate outside term"}' });
    expect(await getDb().select().from(gradebook_pushes)).toEqual([]);
    // A retry goes through.
    expect((await (await send(s.assessment.id, BASE_BODY)).json()).sent).toBe(1);
  });

  test("an assignment deleted in PowerSchool: the push is retired and the next send creates anew", async () => {
    const s = await scene();
    const ben = await attempt(s, OTHER_STUDENT, s.algebra.id, [1, null]);
    await attempt(s, STUDENT, s.algebra.id, [1, 1]);
    const first = await (await send(s.assessment.id, BASE_BODY)).json();
    mockPowerSchool.deleteAssignment(first.external_assignment_id);
    await scoreAll(ben.id, 1);
    const body = await (await send(s.assessment.id, BASE_BODY)).json();
    expect(body.failed).toEqual([{ student_number: "1002", reason: "assignment_missing" }]);
    const [retired] = await getDb().select().from(gradebook_pushes);
    expect(retired!.archived_at).not.toBeNull();

    const again = await (await send(s.assessment.id, BASE_BODY)).json();
    expect(again).toMatchObject({ assignment_created: true, sent: 2 });
    expect(again.external_assignment_id).not.toBe(first.external_assignment_id);
  });

  test("a student PowerSchool has no association for is held out; the rest are written", async () => {
    const s = await scene();
    const ada = await attempt(s, STUDENT, s.algebra.id, [1, 1]);
    await attempt(s, OTHER_STUDENT, s.algebra.id, [1, 1]);
    // Ben left the class in PowerSchool; our roster has not caught up.
    mockPowerSchool.unassociated.add("81002");
    const body = await (await send(s.assessment.id, BASE_BODY)).json();
    expect(body).toMatchObject({ sent: 1, updated: 0 });
    expect(body.failed).toEqual([{ student_number: "1002", reason: "not_in_powerschool_section" }]);
    expect(mockPowerSchool.calls.map((c) => c.method)).toEqual(["listCategories", "createAssignment", "writeScores", "writeScores"]);
    const pushScores = await getDb().select().from(gradebook_push_scores);
    expect(pushScores.map((p) => p.attempt_id)).toEqual([ada.id]);
  });

  test("every student unassociated: nothing written, each held out", async () => {
    const s = await scene();
    await attempt(s, STUDENT, s.algebra.id, [1, 1]);
    mockPowerSchool.unassociated.add("81001");
    const body = await (await send(s.assessment.id, BASE_BODY)).json();
    expect(body.failed).toEqual([{ student_number: "1001", reason: "not_in_powerschool_section" }]);
    expect(await getDb().select().from(gradebook_push_scores)).toEqual([]);
  });

  test("a first send already in flight → 409 send_in_progress", async () => {
    const s = await scene();
    await attempt(s, STUDENT, s.algebra.id, [1, 1]);
    await getDb().insert(gradebook_pushes).values({
      assessment_id: s.assessment.id,
      section_ps_id: "5001",
      target: "powerschool",
      name: "Unit 3 test",
      created_by_sub: OWNER,
    });
    const res = await send(s.assessment.id, BASE_BODY);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("send_in_progress");
  });

  test("a claim left by a crashed first send is taken over after the stale window", async () => {
    const s = await scene();
    await attempt(s, STUDENT, s.algebra.id, [1, 1]);
    await getDb().insert(gradebook_pushes).values({
      assessment_id: s.assessment.id,
      section_ps_id: "5001",
      target: "powerschool",
      name: "Unit 3 test",
      created_by_sub: OWNER,
      created_at: new Date(Date.now() - 3 * 60_000),
    });
    const body = await (await send(s.assessment.id, BASE_BODY)).json();
    expect(body).toMatchObject({ assignment_created: true, sent: 1 });
    const rows = await getDb().select().from(gradebook_pushes);
    expect(rows.length).toBe(1);
    expect(rows[0]!.external_assignment_id).toBe(body.external_assignment_id);
  });

  test("refusals: unknown / inactive category, missing section DCID, schoology, bad body, not the teacher", async () => {
    const s = await scene();
    await attempt(s, STUDENT, s.algebra.id, [1, 1]);

    let res = await send(s.assessment.id, { ...BASE_BODY, category_id: "999" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("unknown_category");

    mockPowerSchool.setCategories("8301", [
      { id: "602", name: "Test", categorytype: "district", districtteachercategoryid: 2, isactive: false, defaultpublishoption: null },
    ]);
    res = await send(s.assessment.id, BASE_BODY);
    expect((await res.json()).error).toBe("unknown_category");
    mockPowerSchool.reset();

    await getDb().update(roster_sections).set({ dcid: null }).where(eq(roster_sections.ps_id, "5001"));
    res = await send(s.assessment.id, BASE_BODY);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ ok: false, error: "missing_dcid", detail: { missing: ["section_dcid"] } });
    await getDb().update(roster_sections).set({ dcid: "85001" }).where(eq(roster_sections.ps_id, "5001"));

    res = await send(s.assessment.id, { ...BASE_BODY, target: "schoology" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("unsupported_target");

    res = await send(s.assessment.id, { ...BASE_BODY, due_date: "28/09/2026" });
    expect(res.status).toBe(400);
    res = await send(s.assessment.id, { ...BASE_BODY, section_ps_id: "" });
    expect(res.status).toBe(400);

    principal = staffPrincipal(CO, OTHER_TEACHER_EMAIL);
    expect((await send(s.assessment.id, BASE_BODY)).status).toBe(404);
    principal = studentPrincipal();
    expect((await send(s.assessment.id, BASE_BODY)).status).toBe(403);
    principal = null;
    expect((await send(s.assessment.id, BASE_BODY)).status).toBe(401);
    expect(mockPowerSchool.calls.filter((c) => c.method !== "listCategories")).toEqual([]);
  });

  test("a co-teacher sends as themselves; an act-as send records the admin", async () => {
    const s = await scene();
    await attempt(s, STUDENT, s.algebra.id, [1, 1]);
    await addCoTeacherRow();
    await grant(s.assessment.id, "edit");
    principal = staffPrincipal(CO, OTHER_TEACHER_EMAIL);
    const body = await (await send(s.assessment.id, BASE_BODY)).json();
    expect(body.sent).toBe(1);
    expect(mockPowerSchool.calls.every((c) => c.usersDcid === "8399")).toBe(true);
    const [pref] = await getDb().select().from(gradebook_section_prefs);
    expect(pref!.staff_sub).toBe(CO);

    // Act-as on a second assessment.
    const t = await scene();
    await attempt(t, STUDENT, t.algebra.id, [1, 1]);
    principal = { ...staffPrincipal(OWNER), actor_sub: "gradebook-admin", actor_email: ADMIN_EMAIL };
    expect((await (await send(t.assessment.id, BASE_BODY)).json()).sent).toBe(1);
    const [push] = await getDb().select().from(gradebook_pushes).where(eq(gradebook_pushes.assessment_id, t.assessment.id));
    expect(push!.created_by_sub).toBe(OWNER);
    expect(push!.actor_sub).toBe("gradebook-admin");
  });
});

// ── The categories route ────────────────────────────────────────────────────

describe("GET /api/assessments/[id]/gradebook-categories", () => {
  test("active categories, the D-6 default, and the remembered destination", async () => {
    const s = await scene();
    await attempt(s, STUDENT, s.algebra.id, [1, 1]);
    let res = await categories(s.assessment.id, "target=powerschool&section_ps_id=5001");
    expect(res.status).toBe(200);
    let body = await res.json();
    expect(body.default_category_id).toBe("602");
    expect(body.categories.map((c: { name: string }) => c.name)).toEqual(["Classwork", "Labs", "Project", "Quiz", "Test"]);
    expect(body.remembered).toBeNull();

    await send(s.assessment.id, { ...BASE_BODY, category_id: "611" });
    body = await (await categories(s.assessment.id, "target=powerschool&section_ps_id=5001")).json();
    expect(body.remembered).toEqual({ target: "powerschool", category_id: "611" });

    // D-6: the Test copy inactive → no default.
    mockPowerSchool.setCategories("8301", [
      { id: "602", name: "Test", categorytype: "district", districtteachercategoryid: 2, isactive: false, defaultpublishoption: null },
      { id: "650", name: "Summative", categorytype: "user", districtteachercategoryid: null, isactive: true, defaultpublishoption: null },
    ]);
    body = await (await categories(s.assessment.id, "target=powerschool&section_ps_id=5001")).json();
    expect(body.default_category_id).toBeNull();
    expect(body.categories.map((c: { id: string }) => c.id)).toEqual(["650"]);
  });

  test("the same refusals as the send", async () => {
    const s = await scene();
    expect((await categories(s.assessment.id, "target=powerschool&section_ps_id=5002")).status).toBe(404);
    expect((await categories(s.assessment.id, "target=schoology&section_ps_id=5001")).status).toBe(400);
    expect((await categories(s.assessment.id, "target=fax&section_ps_id=5001")).status).toBe(400);
    expect((await categories(s.assessment.id, "target=powerschool")).status).toBe(400);
    mockPowerSchool.failNext("listCategories", 500, "boom");
    expect((await categories(s.assessment.id, "target=powerschool&section_ps_id=5001")).status).toBe(502);
  });
});

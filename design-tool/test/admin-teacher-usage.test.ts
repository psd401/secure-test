// `/admin/usage` (lib/admin/teacherUsage.ts): the per-teacher volume counts
// an admin sorts to find champions. What matters: practice sittings and
// unsubmitted attempts do not count, a sitting is credited to its owner, the
// window cuts on the right timestamp, and the school year starts Sept 1
// Pacific.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { closeDb, getDb } from "../db/client";
import {
  assessment_shares,
  assessments,
  attempts,
  class_insight_reports,
  competency_assignments,
  feedback,
  gradebook_pushes,
  item_sets,
  roster_students,
  students,
  test_sessions,
} from "../db/schema";
import {
  filterUsage,
  parseUsageParams,
  schoolYearStart,
  sortUsage,
  teacherUsage,
  windowSince,
  type TeacherUsageRow,
} from "../lib/admin/teacherUsage";

const A = "usage-teacher-a";
const B = "usage-teacher-b";
const SUB = "usage-substitute";
const PS_ID = "usage-roster-1";
const LONG_AGO = new Date("2024-01-15T12:00:00Z");
const RECENT = new Date("2026-10-15T12:00:00Z");

beforeAll(() => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("secure_test_design_tool_test")) {
    throw new Error(`admin-teacher-usage tests require the test DB; got: ${url}`);
  }
});

afterEach(async () => {
  const db = getDb();
  await db.execute(sql`truncate table assessments restart identity cascade`);
  await db.execute(sql`truncate table students restart identity cascade`);
  await db.execute(sql`truncate table feedback restart identity cascade`);
  await db.delete(roster_students).where(eq(roster_students.ps_id, PS_ID));
});

afterAll(async () => {
  await closeDb();
});

let codeN = 0;
async function sitting(
  owner: string,
  assessmentId: string,
  opts: { kind?: "class" | "practice"; at?: Date; createdBy?: string } = {},
) {
  const [s] = await getDb()
    .insert(test_sessions)
    .values({
      assessment_id: assessmentId,
      owner_sub: owner,
      owner_email: `${owner}@example.org`,
      created_by_sub: opts.createdBy ?? null,
      kind: opts.kind ?? "class",
      practice_for_sub: opts.kind === "practice" ? owner : null,
      code: `USG${String(++codeN).padStart(3, "0")}`,
      expires_at: new Date(Date.now() + 3600_000),
      created_at: opts.at ?? RECENT,
    })
    .returning();
  return s!;
}

async function student(owner: string, name: string) {
  const [s] = await getDb().insert(students).values({ owner_sub: owner, name }).returning();
  return s!;
}

async function attempt(
  sessionId: string,
  assessmentId: string,
  studentId: string,
  opts: { submitted?: boolean; at?: Date } = {},
) {
  const submitted = opts.submitted ?? true;
  await getDb()
    .insert(attempts)
    .values({
      assessment_id: assessmentId,
      student_id: studentId,
      test_session_id: sessionId,
      status: submitted ? "submitted" : "in_progress",
      submitted_at: submitted ? (opts.at ?? RECENT) : null,
    });
}

async function seed() {
  const db = getDb();
  const [aOne, aTwo, bOne] = await db
    .insert(assessments)
    .values([
      { owner_sub: A, owner_email: `${A}@example.org`, name: "A1", created_at: RECENT },
      { owner_sub: A, owner_email: `${A}@example.org`, name: "A2", created_at: LONG_AGO },
      { owner_sub: B, name: "B1", created_at: RECENT },
    ])
    .returning();

  // A: two class sittings (one run by a substitute), one practice sitting.
  // One attempt per (assessment, student), so the repeat student sits A2.
  const s1 = await sitting(A, aOne!.id);
  const s2 = await sitting(A, aTwo!.id, { createdBy: SUB });
  const practice = await sitting(A, aTwo!.id, { kind: "practice" });
  const [x, y, z] = await Promise.all([student(A, "x"), student(A, "y"), student(A, "z")]);
  await attempt(s1.id, aOne!.id, x.id);
  await attempt(s1.id, aOne!.id, y.id);
  await attempt(s1.id, aOne!.id, z.id, { submitted: false }); // in progress: not counted
  await attempt(s2.id, aTwo!.id, x.id); // same student again: one student, two attempts
  await attempt(practice.id, aTwo!.id, z.id); // practice: not counted

  // B: one old sitting with one old submission.
  const s3 = await sitting(B, bOne!.id, { at: LONG_AGO });
  const w = await student(B, "w");
  await attempt(s3.id, bOne!.id, w.id, { at: LONG_AGO });
}

function bySub(rows: TeacherUsageRow[]) {
  return Object.fromEntries(rows.map((r) => [r.sub, r]));
}

describe("teacherUsage", () => {
  test("all time: counts class sittings and submitted attempts, credited to the owner", async () => {
    await seed();
    const rows = bySub(await teacherUsage(getDb(), { since: null }));

    expect(Object.keys(rows).sort()).toEqual([A, B]); // the substitute gets no row
    expect(rows[A]).toMatchObject({
      email: `${A}@example.org`,
      assessments: 2,
      sittings: 2,
      students: 2,
      attempts: 3,
    });
    expect(rows[A]!.lastActive).toEqual(RECENT);
    expect(rows[B]).toMatchObject({ assessments: 1, sittings: 1, students: 1, attempts: 1 });
    // B's assessment has no email; the sitting's fills it in.
    expect(rows[B]!.email).toBe(`${B}@example.org`);
  });

  test("a window drops activity before its start", async () => {
    await seed();
    const rows = bySub(
      await teacherUsage(getDb(), { since: new Date("2026-09-01T00:00:00Z") }),
    );
    expect(rows[A]).toMatchObject({ assessments: 1, sittings: 2, students: 2, attempts: 3 });
    // B's newer assessment still counts; the old sitting and attempt do not.
    expect(rows[B]).toMatchObject({ assessments: 1, sittings: 0, students: 0, attempts: 0 });
  });

  test("breadth: each feature counted by its creator; featuresUsed counts non-zero features", async () => {
    const db = getDb();
    const [a] = await db
      .insert(assessments)
      .values({ owner_sub: A, name: "A1", created_at: RECENT })
      .returning();
    const [set] = await db.insert(item_sets).values({ assessment_id: a!.id }).returning();
    await db.insert(roster_students).values({ ps_id: PS_ID, enroll_status: 0, last_seen_snapshot_id: "usage-test" });

    // A: two pushes (one made while an admin acted as A), a share, an insight
    // report, a competency assignment. Four features; feedback unused.
    await db.insert(gradebook_pushes).values([
      {
        assessment_id: a!.id,
        section_ps_id: "s1",
        target: "powerschool",
        name: "P1",
        created_by_sub: A,
        created_at: RECENT,
      },
      {
        assessment_id: a!.id,
        section_ps_id: "s2",
        target: "powerschool",
        name: "P2",
        created_by_sub: A,
        actor_sub: "usage-admin",
        created_at: RECENT,
      },
    ]);
    await db.insert(assessment_shares).values({
      assessment_id: a!.id,
      recipient_email: `${B}@example.org`,
      shared_by_sub: A,
      shared_by_email: `${A}@example.org`,
      created_at: RECENT,
    });
    await db.insert(class_insight_reports).values({
      assessment_id: a!.id,
      section_key: "s1",
      report: {},
      pseudonyms: {},
      item_ids: {},
      pack_hash: "h",
      model_id: "mock",
      prompt_version: "v",
      created_by_sub: A,
      created_at: RECENT,
    });
    await db.insert(competency_assignments).values({
      assessment_id: a!.id,
      student_ps_id: PS_ID,
      item_set_id: set!.id,
      proctor_email: `${B}@example.org`,
      assigned_by_sub: A,
      assigned_by_email: `${A}@example.org`,
      created_at: RECENT,
    });
    // B: only feedback, long ago. A row appears from feedback alone,
    // labelled by the feedback's email.
    await db.insert(feedback).values({
      sub: B,
      email: `${B}@example.org`,
      role: "teacher",
      path: "/",
      message: "hi",
      created_at: LONG_AGO,
    });

    const all = bySub(await teacherUsage(db, { since: null }));
    expect(all[A]).toMatchObject({
      email: `${A}@example.org`, // the share's email fills the assessment's null
      gradebookPushes: 2,
      sharesSent: 1,
      insightReports: 1,
      competencyAssignments: 1,
      feedbackSent: 0,
      featuresUsed: 4,
    });
    expect(all[B]).toMatchObject({ email: `${B}@example.org`, feedbackSent: 1, featuresUsed: 1 });
    expect(all[B]!.lastActive).toEqual(LONG_AGO);
    expect(all["usage-admin"]).toBeUndefined(); // act-as credits the teacher, not the admin

    const recent = bySub(await teacherUsage(db, { since: new Date("2026-09-01T00:00:00Z") }));
    expect(recent[B]).toBeUndefined();
    expect(recent[A]!.featuresUsed).toBe(4);
  });

  test("no activity returns no rows", async () => {
    expect(await teacherUsage(getDb(), { since: null })).toEqual([]);
  });
});

describe("sortUsage", () => {
  const row = (sub: string, over: Partial<TeacherUsageRow>): TeacherUsageRow => ({
    sub,
    email: `${sub}@example.org`,
    assessments: 0,
    sittings: 0,
    students: 0,
    attempts: 0,
    gradebookPushes: 0,
    sharesSent: 0,
    insightReports: 0,
    competencyAssignments: 0,
    feedbackSent: 0,
    featuresUsed: 0,
    lastActive: null,
    ...over,
  });

  test("descending on the chosen column, ties by email", () => {
    const rows = [
      row("c", { students: 5, sittings: 1 }),
      row("a", { students: 5, sittings: 9 }),
      row("b", { students: 9, sittings: 2 }),
    ];
    expect(sortUsage(rows, "students").map((r) => r.sub)).toEqual(["b", "a", "c"]);
    expect(sortUsage(rows, "sittings").map((r) => r.sub)).toEqual(["a", "b", "c"]);
    const broad = [row("x", { featuresUsed: 1 }), row("y", { featuresUsed: 4 })];
    expect(sortUsage(broad, "features_used").map((r) => r.sub)).toEqual(["y", "x"]);
  });

  test("last active puts never-active last", () => {
    const rows = [row("n", {}), row("o", { lastActive: LONG_AGO }), row("r", { lastActive: RECENT })];
    expect(sortUsage(rows, "last_active").map((r) => r.sub)).toEqual(["r", "o", "n"]);
  });
});

describe("filterUsage", () => {
  const row = (sub: string, email: string | null) => ({ sub, email }) as TeacherUsageRow;
  const rows = [row("a", "Bea@example.org"), row("b", "al@example.org"), row("c", null)];

  test("matches the email case-insensitively and drops rows with none", () => {
    expect(filterUsage(rows, "bEA@").map((r) => r.sub)).toEqual(["a"]);
    expect(filterUsage(rows, "example").map((r) => r.sub)).toEqual(["a", "b"]);
  });

  test("an empty search keeps every row", () => {
    expect(filterUsage(rows, "")).toHaveLength(3);
  });
});

describe("params and windows", () => {
  test("unknown params fall back to students / school year", () => {
    expect(parseUsageParams({})).toEqual({ sort: "students", window: "year", q: "" });
    expect(parseUsageParams({ sort: "drop table", window: "x" })).toEqual({
      sort: "students",
      window: "year",
      q: "",
    });
    expect(parseUsageParams({ sort: "sittings", window: "30d" })).toEqual({
      sort: "sittings",
      window: "30d",
      q: "",
    });
  });

  test("the search is trimmed and capped", () => {
    expect(parseUsageParams({ q: "  bea  " }).q).toBe("bea");
    expect(parseUsageParams({ q: "x".repeat(300) }).q).toHaveLength(200);
  });

  test("school year starts Sept 1 Pacific", () => {
    // Midnight Sept 1 PDT = 07:00 UTC.
    expect(schoolYearStart(new Date("2026-11-06T12:00:00Z"))).toEqual(
      new Date("2026-09-01T07:00:00Z"),
    );
    // Aug 31 evening Pacific is still last year (already Sept 1 in UTC).
    expect(schoolYearStart(new Date("2026-09-01T05:00:00Z"))).toEqual(
      new Date("2025-09-01T07:00:00Z"),
    );
    expect(schoolYearStart(new Date("2027-03-01T12:00:00Z"))).toEqual(
      new Date("2026-09-01T07:00:00Z"),
    );
  });

  test("windowSince", () => {
    const now = new Date("2026-11-06T12:00:00Z");
    expect(windowSince("all", now)).toBeNull();
    expect(windowSince("30d", now)).toEqual(new Date("2026-10-07T12:00:00Z"));
    expect(windowSince("year", now)).toEqual(new Date("2026-09-01T07:00:00Z"));
  });
});

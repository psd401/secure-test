// Slice 40: results matrix + generic CSV export. Totals must count FINAL
// scores only — proposed AI scores surface as pending state, never points.
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import type { Rubric } from "@secure-test/schema";
import { closeDb, getDb } from "../db/client";
import {
  assessments,
  attempts,
  items,
  responses,
  scores,
  students,
  test_sessions,
} from "../db/schema";
import { SESSION_COOKIE_NAME } from "../lib/auth/session";
import * as sessionMod from "../lib/auth/session";
import { buildResults, resultsToCsv } from "../lib/scoring/results";
import {
  BIOLOGY_STUDENT,
  OTHER_STUDENT,
  STUDENT,
  TEACHER_EMAIL,
  clearRoster,
  seedRoster,
} from "./helpers/roster";

const expectTestDb = () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("secure_test_design_tool_test")) {
    throw new Error(`results tests require the test DB DATABASE_URL; got: ${url}`);
  }
};

let originalSessionSecret: string | undefined;
let mockSub: string | null = null;

mock.module("next/headers", () => ({
  // Slice 58: requireSession now reads an Authorization bearer header as
  // well as the cookie, so the mocked module has to provide headers().
  headers: async () => new Headers(),
  cookies: async () => ({
    get: (name: string) => (mockSub && name === SESSION_COOKIE_NAME ? { value: "x" } : undefined),
  }),
}));

mock.module("../lib/auth/session", () => ({
  ...sessionMod,
  readSessionFromCookies: async () =>
    mockSub ? { sub: mockSub, role: "staff" } : null,
}));

const OWNER = "results-teacher";

beforeAll(() => {
  expectTestDb();
  originalSessionSecret = process.env.DESIGN_TOOL_SESSION_SECRET;
  process.env.DESIGN_TOOL_SESSION_SECRET = "test-session-secret-do-not-use";
  mockSub = OWNER;
});

afterEach(async () => {
  mockSub = OWNER;
  const db = getDb();
  await db.execute(sql`truncate table assessments restart identity cascade`);
  await db.execute(sql`truncate table students restart identity cascade`);
});

afterAll(async () => {
  await closeDb();
  if (originalSessionSecret === undefined) {
    delete process.env.DESIGN_TOOL_SESSION_SECRET;
  } else {
    process.env.DESIGN_TOOL_SESSION_SECRET = originalSessionSecret;
  }
});

const RUBRIC: Rubric = {
  style: "holistic",
  criteria: [
    {
      id: "overall",
      name: "Overall",
      levels: [
        { id: "l1", label: "Emerging", points: 2 },
        { id: "l2", label: "Proficient", points: 4 },
      ],
    },
  ],
};

// One assessment, two students:
//   - Alice ("With, comma" name to exercise CSV quoting): MC final 1/1,
//     essay AI-proposed (pending, excluded), short_text unscored.
//   - Bob: MC final 0/1, essay human final 4/4, no short_text response.
async function seedResultsScenario() {
  const db = getDb();
  const [assessment] = await db
    .insert(assessments)
    .values({ owner_sub: OWNER, name: "Results" })
    .returning();
  const a = assessment!;
  const itemRows = await db
    .insert(items)
    .values([
      {
        assessment_id: a.id,
        position: 0,
        type: "multiple_choice_single",
        stem: "MC",
        choices: [
          { id: "a", text: "A" },
          { id: "b", text: "B" },
        ],
        correct_choice_ids: ["a"],
      },
      {
        assessment_id: a.id,
        position: 1,
        type: "essay",
        stem: "Essay",
        config: { rubric: RUBRIC, scoring_method: "ai" },
      },
      {
        assessment_id: a.id,
        position: 2,
        type: "short_text",
        stem: "Short",
        correct_answer: "x",
        config: { scoring_method: "human" },
      },
    ])
    .returning();
  const studentRows = await db
    .insert(students)
    .values([
      { owner_sub: OWNER, ssid: "111", name: 'Alice "A", comma' },
      { owner_sub: OWNER, ssid: "222", name: "Bob" },
    ])
    .returning();
  const submittedAt = new Date("2026-07-09T17:00:00Z");
  const attemptRows = await db
    .insert(attempts)
    .values(
      studentRows.map((s) => ({
        assessment_id: a.id,
        student_id: s.id,
        status: "submitted" as const,
        submitted_at: submittedAt,
      })),
    )
    .returning();
  const [aliceAttempt, bobAttempt] = attemptRows;

  const responseRows = await db
    .insert(responses)
    .values([
      // Alice: all three items
      {
        attempt_id: aliceAttempt!.id,
        item_id: itemRows[0]!.id,
        response: { type: "multiple_choice_single", choice_id: "a" },
      },
      {
        attempt_id: aliceAttempt!.id,
        item_id: itemRows[1]!.id,
        response: { type: "essay", text: "Alice essay." },
      },
      {
        attempt_id: aliceAttempt!.id,
        item_id: itemRows[2]!.id,
        response: { type: "short_text", text: "y" },
      },
      // Bob: MC + essay only (no short_text response)
      {
        attempt_id: bobAttempt!.id,
        item_id: itemRows[0]!.id,
        response: { type: "multiple_choice_single", choice_id: "b" },
      },
      {
        attempt_id: bobAttempt!.id,
        item_id: itemRows[1]!.id,
        response: { type: "essay", text: "Bob essay." },
      },
    ])
    .returning();

  await db.insert(scores).values([
    // Alice MC: auto final correct
    {
      response_id: responseRows[0]!.id,
      method: "auto",
      points: 1,
      max_points: 1,
      scorer: "auto",
      status: "final",
    },
    // Alice essay: AI proposed only — must NOT count
    {
      response_id: responseRows[1]!.id,
      method: "ai",
      points: 4,
      max_points: 4,
      scorer: "mock",
      status: "proposed",
    },
    // Bob MC: auto final wrong
    {
      response_id: responseRows[3]!.id,
      method: "auto",
      points: 0,
      max_points: 1,
      scorer: "auto",
      status: "final",
    },
    // Bob essay: human final
    {
      response_id: responseRows[4]!.id,
      method: "human",
      points: 4,
      max_points: 4,
      scorer: OWNER,
      status: "final",
      reviewed_by_sub: OWNER,
    },
  ]);
  return { db, assessment: a };
}

// Security sweep finding: `attempts.student_id` is a plain FK with no tenant
// constraint, so owning the ASSESSMENT does not imply owning the STUDENT an
// attempt points at. Without an owner_sub predicate on the roster lookup, a
// cross-tenant attempt would leak that student's name and SSID into results
// and the CSV export. Not reachable today (nothing writes attempts outside
// tests and the prod-guarded seeder) — this test IS the reachable path, and it
// is what keeps the predicate from being dropped as redundant later.
describe("buildResults — cross-tenant roster isolation", () => {
  test("a student owned by another teacher never surfaces", async () => {
    const { db, assessment } = await seedResultsScenario();

    // Re-home Alice to a different teacher, leaving her attempt in place —
    // a cross-owner attempt the results query must fail closed on.
    await db
      .update(students)
      .set({ owner_sub: "some-other-teacher" })
      .where(eq(students.ssid, "111"));

    const results = await buildResults(assessment.id, OWNER);

    // The attempt row still appears (it belongs to this assessment), but the
    // foreign student's identity does not.
    expect(results.rows).toHaveLength(2);
    const leaked = results.rows.find((r) => r.student.ssid === "111");
    expect(leaked).toBeUndefined();

    const anon = results.rows.find((r) => r.student.name === "(unknown)")!;
    expect(anon).toBeDefined();
    expect(anon.student.ssid).toBe("");
    // Scores still compute — the fix withholds identity, it does not break
    // the report.
    expect(anon.total_points).toBe(1);

    // Bob is this teacher's student and is unaffected.
    expect(results.rows.find((r) => r.student.ssid === "222")).toBeDefined();

    // And nothing leaks through the CSV path either.
    const csv = resultsToCsv(results);
    expect(csv).not.toContain("111");
    expect(csv).not.toContain("Alice");
  });
});

describe("buildResults", () => {
  test("totals count finals only; statuses classify every cell", async () => {
    const { assessment } = await seedResultsScenario();
    const results = await buildResults(assessment.id, OWNER);

    expect(results.items).toHaveLength(3);
    expect(results.rows).toHaveLength(2);

    const alice = results.rows.find((r) => r.student.ssid === "111")!;
    expect(alice.cells.map((c) => c.status)).toEqual([
      "final",
      "proposed_pending",
      "unscored",
    ]);
    expect(alice.total_points).toBe(1); // proposed 4 points NOT counted
    expect(alice.scored_max_points).toBe(1);
    expect(alice.unscored_count).toBe(2);

    const bob = results.rows.find((r) => r.student.ssid === "222")!;
    expect(bob.cells.map((c) => c.status)).toEqual([
      "final",
      "final",
      "no_response",
    ]);
    expect(bob.total_points).toBe(4);
    expect(bob.scored_max_points).toBe(5);
    expect(bob.unscored_count).toBe(0);
  });

  test("empty assessment produces empty rows", async () => {
    const db = getDb();
    const [empty] = await db
      .insert(assessments)
      .values({ owner_sub: OWNER, name: "Empty" })
      .returning();
    const results = await buildResults(empty!.id, OWNER);
    expect(results.rows).toEqual([]);
    expect(results.items).toEqual([]);
  });
});

describe("resultsToCsv", () => {
  test("golden CSV: quoting, blanks for non-final, CRLF", async () => {
    const { assessment } = await seedResultsScenario();
    const csv = resultsToCsv(await buildResults(assessment.id, OWNER));
    // R0.3 header: student_number,name,email,section,submitted_at,Q1..Qn,
    // total,max,percent,unscored. This fixture's students carry no roster
    // binding, so student_number/email/section are blank; `max` is the
    // assessment-level constant (D-R1: 1 + 4 + 1 = 6, not the scored-only
    // sum); `percent` (D-R2) is blank for Alice (unscored 2) and 67 for Bob
    // (4/6 rounded, unscored 0).
    const expected =
      [
        "student_number,name,email,section,submitted_at,Q1,Q2,Q3,total,max,percent,unscored",
        ',"Alice ""A"", comma",,,2026-07-09T17:00:00.000Z,1,,,1,6,,2',
        ",Bob,,,2026-07-09T17:00:00.000Z,0,4,,4,6,67,0",
      ].join("\r\n") + "\r\n";
    expect(csv).toBe(expected);
  });
});

// R0.3 (docs/reporting-design.md): identifiers on the results path — the
// roster join for student number / email, the section fallback order, the
// D-R1 assessment-level denominator, and D-R2's blank-until-fully-scored
// percent. Uses the shared fictional roster fixture (test/helpers/roster.ts):
// teacher.one@psd401.net currently teaches 5001 (Algebra 1, period 3(A)) and
// 5003 (English 9, period 1(A)); Ada (1001, STUDENT) is in both, Ben (1002,
// OTHER_STUDENT) only in 5001; Cy (1003, BIOLOGY_STUDENT) is in 5002
// (Biology), taught only by teacher.two.
describe("buildResults — R0.3 identifiers, section fallback, denominator, percent", () => {
  afterEach(async () => {
    await clearRoster();
  });

  const TABLE_CELL_KEYS = { r1: { c1: "x", c2: "y" } };

  async function seedR03Scenario() {
    await seedRoster();
    const db = getDb();
    const [assessment] = await db
      .insert(assessments)
      .values({ owner_sub: OWNER, name: "R0.3" })
      .returning();
    const a = assessment!;
    const itemRows = await db
      .insert(items)
      .values([
        {
          assessment_id: a.id,
          position: 0,
          type: "multiple_choice_single",
          stem: "MC",
          choices: [
            { id: "a", text: "A" },
            { id: "b", text: "B" },
          ],
          correct_choice_ids: ["a"],
        },
        {
          assessment_id: a.id,
          position: 1,
          type: "essay",
          stem: "Essay",
          config: { rubric: RUBRIC, scoring_method: "human" }, // max 4
        },
        {
          assessment_id: a.id,
          position: 2,
          type: "table",
          stem: "Table",
          config: {
            columns: [
              { id: "c1", label: "C1" },
              { id: "c2", label: "C2" },
            ],
            rows: [{ id: "r1", label: "R1" }],
            cell_keys: TABLE_CELL_KEYS, // 2 keyed cells
          },
        },
      ])
      .returning();

    const [aliceOverlay, bobOverlay, carolOverlay] = await db
      .insert(students)
      .values([
        { owner_sub: OWNER, roster_ps_id: STUDENT.ps_id, name: "Alice Overlay" },
        { owner_sub: OWNER, roster_ps_id: OTHER_STUDENT.ps_id, name: "Bob Overlay" },
        { owner_sub: OWNER, roster_ps_id: BIOLOGY_STUDENT.ps_id, name: "Carol Overlay" },
      ])
      .returning();

    // Alice's sitting names a section (5003, English 9) — must win over the
    // enrollment fallback, which would otherwise pick 5001 (Algebra 1, the
    // first of her two sections sorted by section ps_id).
    const [sitting] = await db
      .insert(test_sessions)
      .values({
        assessment_id: a.id,
        owner_sub: OWNER,
        owner_email: TEACHER_EMAIL,
        section_ps_id: "5003",
        code: "R03TEST",
        status: "open",
        expires_at: new Date(Date.now() + 3600_000),
      })
      .returning();

    const submittedAt = new Date("2026-07-09T17:00:00Z");
    const attemptRows = await db
      .insert(attempts)
      .values([
        {
          assessment_id: a.id,
          student_id: aliceOverlay!.id,
          test_session_id: sitting!.id,
          status: "submitted" as const,
          submitted_at: submittedAt,
        },
        // Bob's attempt names no sitting section — enrollment fallback.
        {
          assessment_id: a.id,
          student_id: bobOverlay!.id,
          status: "submitted" as const,
          submitted_at: submittedAt,
        },
        // Carol is enrolled only in 5002, taught by teacher.two, not this
        // assessment's owner (teacher.one) — neither fallback should resolve
        // a section for her, and teacher.two's section must never leak.
        {
          assessment_id: a.id,
          student_id: carolOverlay!.id,
          status: "submitted" as const,
          submitted_at: submittedAt,
        },
      ])
      .returning();
    const [aliceAttempt, bobAttempt, carolAttempt] = attemptRows;

    // Alice: every item finalized (unscored 0) — exercises D-R2's filled
    // percent. MC 1/1, essay 4/4, table 2/2 => total 7 of max 7 => 100%.
    const aliceResponses = await db
      .insert(responses)
      .values([
        {
          attempt_id: aliceAttempt!.id,
          item_id: itemRows[0]!.id,
          response: { type: "multiple_choice_single", choice_id: "a" },
        },
        {
          attempt_id: aliceAttempt!.id,
          item_id: itemRows[1]!.id,
          response: { type: "essay", text: "Alice essay." },
        },
        {
          attempt_id: aliceAttempt!.id,
          item_id: itemRows[2]!.id,
          response: { type: "table", cells: { r1: { c1: "x", c2: "y" } } },
        },
      ])
      .returning();
    // Bob: MC final, table response left unscored (unscored 1) — exercises
    // D-R2's blank percent while anything is still unscored.
    const bobResponses = await db
      .insert(responses)
      .values([
        {
          attempt_id: bobAttempt!.id,
          item_id: itemRows[0]!.id,
          response: { type: "multiple_choice_single", choice_id: "a" },
        },
        {
          attempt_id: bobAttempt!.id,
          item_id: itemRows[2]!.id,
          response: { type: "table", cells: { r1: { c1: "x", c2: "" } } },
        },
      ])
      .returning();

    await db.insert(scores).values([
      { response_id: aliceResponses[0]!.id, method: "auto", points: 1, max_points: 1, scorer: "auto", status: "final" },
      { response_id: aliceResponses[1]!.id, method: "human", points: 4, max_points: 4, scorer: OWNER, status: "final", reviewed_by_sub: OWNER },
      { response_id: aliceResponses[2]!.id, method: "auto", points: 2, max_points: 2, scorer: "auto", status: "final" },
      { response_id: bobResponses[0]!.id, method: "auto", points: 1, max_points: 1, scorer: "auto", status: "final" },
      // bobResponses[1] (table) deliberately carries no score row.
    ]);

    return { db, assessment: a, aliceAttempt: aliceAttempt!, bobAttempt: bobAttempt!, carolAttempt: carolAttempt! };
  }

  test("roster join resolves student number and email", async () => {
    const { assessment } = await seedR03Scenario();
    const results = await buildResults(assessment.id, OWNER, TEACHER_EMAIL);
    const alice = results.rows.find((r) => r.student.student_number === STUDENT.ps_id)!;
    expect(alice).toBeDefined();
    expect(alice.student.email).toBe(STUDENT.email);
    const bob = results.rows.find((r) => r.student.student_number === OTHER_STUDENT.ps_id)!;
    expect(bob).toBeDefined();
    expect(bob.student.email).toBe(OTHER_STUDENT.email);
  });

  test("section fallback: sitting section wins over enrollment", async () => {
    const { assessment } = await seedR03Scenario();
    const results = await buildResults(assessment.id, OWNER, TEACHER_EMAIL);
    const alice = results.rows.find((r) => r.student.student_number === STUDENT.ps_id)!;
    expect(alice.student.section).toBe("English 9 · 1(A)");
  });

  test("section fallback: falls back to the owner's current enrollment when the sitting names no section", async () => {
    const { assessment } = await seedR03Scenario();
    const results = await buildResults(assessment.id, OWNER, TEACHER_EMAIL);
    const bob = results.rows.find((r) => r.student.student_number === OTHER_STUDENT.ps_id)!;
    expect(bob.student.section).toBe("Algebra 1 · 3(A)");
  });

  test("section fallback: blank when neither the sitting nor the owner's current sections name one, and another owner's section never leaks", async () => {
    const { assessment } = await seedR03Scenario();
    const results = await buildResults(assessment.id, OWNER, TEACHER_EMAIL);
    const carol = results.rows.find((r) => r.student.student_number === BIOLOGY_STUDENT.ps_id)!;
    expect(carol.student.section).toBeNull();
    // Belt and suspenders: teacher.two's "Biology" section must not surface
    // anywhere in this owner's results.
    expect(results.rows.some((r) => r.student.section?.includes("Biology"))).toBe(false);
  });

  test("D-R1: max is the assessment-level constant denominator, not the scored-only sum", async () => {
    const { assessment } = await seedR03Scenario();
    const results = await buildResults(assessment.id, OWNER, TEACHER_EMAIL);
    // 1 (MC) + 4 (rubric essay, max level points) + 2 (2 keyed table cells).
    for (const row of results.rows) {
      expect(row.max_points).toBe(7);
    }
  });

  test("D-R2: percent is blank while unscored > 0, filled once everything is scored", async () => {
    const { assessment } = await seedR03Scenario();
    const results = await buildResults(assessment.id, OWNER, TEACHER_EMAIL);
    const alice = results.rows.find((r) => r.student.student_number === STUDENT.ps_id)!;
    expect(alice.unscored_count).toBe(0);
    expect(alice.percent).toBe(100); // 7/7

    const bob = results.rows.find((r) => r.student.student_number === OTHER_STUDENT.ps_id)!;
    expect(bob.unscored_count).toBe(1);
    expect(bob.percent).toBeNull();
  });
});

describe("GET /api/assessments/:id/results", () => {
  async function getResults(id: string, query = "") {
    const { GET } = await import("../app/api/assessments/[id]/results/route");
    return GET(
      new Request(`http://localhost/api/assessments/${id}/results${query}`),
      { params: Promise.resolve({ id }) },
    );
  }

  test("JSON matrix round-trips; CSV format sets headers", async () => {
    const { assessment } = await seedResultsScenario();
    const res = await getResults(assessment.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      results: { rows: Array<{ total_points: number }> };
    };
    expect(body.results.rows).toHaveLength(2);

    const csvRes = await getResults(assessment.id, "?format=csv");
    expect(csvRes.status).toBe(200);
    expect(csvRes.headers.get("content-type")).toContain("text/csv");
    expect(csvRes.headers.get("content-disposition")).toContain(
      'filename="Results results.csv"',
    );
    const text = await csvRes.text();
    expect(
      text.startsWith("student_number,name,email,section,submitted_at,Q1,Q2,Q3"),
    ).toBe(true);
  });

  test("403 for another teacher", async () => {
    const { assessment } = await seedResultsScenario();
    mockSub = "someone-else";
    const res = await getResults(assessment.id);
    expect(res.status).toBe(403);
  });
});

// Review fix (2026-08-14): spreadsheet formula triggers in student-
// controlled fields are neutralized with a leading apostrophe.
describe("resultsToCsv formula-injection neutralization (review fix)", () => {
  test("a =HYPERLINK student name cannot execute as a formula", async () => {
    const { db, assessment } = await seedResultsScenario();
    await db
      .update(students)
      .set({ name: '=HYPERLINK("http://evil","click")' })
      .where(eq(students.ssid, "111"));
    const csv = resultsToCsv(await buildResults(assessment.id, OWNER));
    expect(csv).toContain(`'=HYPERLINK`);
    expect(csv).not.toMatch(/[^']=HYPERLINK/);
  });
});

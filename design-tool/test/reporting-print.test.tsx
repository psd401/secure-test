// R2 print report (docs/reporting-design.md): the structure of
// /dashboard/[id]/results/print — summary page, one page per student, the
// page-break markers, the ?attempt= single-page mode, the ?section= filter,
// and the owner-only posture (another teacher gets 404, not a Forbidden page
// that confirms the assessment exists).
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { sql } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { closeDb, getDb } from "../db/client";
import {
  assessments,
  attempt_events,
  attempts,
  items,
  responses,
  scores,
  students,
} from "../db/schema";
import { SESSION_COOKIE_NAME } from "../lib/auth/session";
import * as sessionMod from "../lib/auth/session";
import { formatDateTime } from "../lib/ui/format";

const expectTestDb = () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("secure_test_design_tool_test")) {
    throw new Error(`print-report tests require the test DB DATABASE_URL; got: ${url}`);
  }
};

const OWNER = "print-report-teacher";
const OTHER_TEACHER = "print-report-other-teacher";
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
  readStaffSessionFromCookies: async () =>
    mockSub ? { sub: mockSub, role: "staff", email: null } : null,
}));

// Imported AFTER the module mocks so the page picks them up.
const { default: ResultsPrintPage } = await import(
  "../app/dashboard/[id]/results/print/page"
);

let originalSessionSecret: string | undefined;

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

async function render(
  id: string,
  search: Record<string, string> = {},
): Promise<string> {
  const element = await ResultsPrintPage({
    params: Promise.resolve({ id }),
    searchParams: Promise.resolve(search),
  });
  return renderToStaticMarkup(element);
}

/**
 * One assessment, two items (MC worth 1, essay with no rubric worth 1), two
 * students, both handed in:
 *   - Ada: MC 1/1 final, essay 1/1 final  → complete, 2/2, 100%
 *   - Ben: MC 0/1 final, essay unscored   → 0/2, 1 unscored
 * Ada's attempt carries two focus_loss events and a lockdown_end; Ben's none.
 */
async function seedPrintScenario() {
  const db = getDb();
  const [assessment] = await db
    .insert(assessments)
    .values({ owner_sub: OWNER, name: "Print Report Fixture" })
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
        config: { scoring_method: "human" },
      },
    ])
    .returning();
  const studentRows = await db
    .insert(students)
    .values([
      { owner_sub: OWNER, ssid: "p-1", name: "Ada Print" },
      { owner_sub: OWNER, ssid: "p-2", name: "Ben Print" },
    ])
    .returning();
  const attemptRows = await db
    .insert(attempts)
    .values([
      {
        assessment_id: a.id,
        student_id: studentRows[0]!.id,
        status: "submitted" as const,
        started_at: new Date("2026-09-03T16:00:00Z"),
        submitted_at: new Date("2026-09-03T17:00:00Z"),
      },
      {
        assessment_id: a.id,
        student_id: studentRows[1]!.id,
        status: "submitted" as const,
        started_at: new Date("2026-09-04T16:00:00Z"),
        submitted_at: new Date("2026-09-04T18:30:00Z"),
      },
    ])
    .returning();
  const [adaAttempt, benAttempt] = attemptRows;

  const responseRows = await db
    .insert(responses)
    .values([
      {
        attempt_id: adaAttempt!.id,
        item_id: itemRows[0]!.id,
        response: { type: "multiple_choice_single", choice_id: "a" },
      },
      {
        attempt_id: adaAttempt!.id,
        item_id: itemRows[1]!.id,
        // Free text: the report must never print this string.
        response: { type: "essay", text: "SECRET-ESSAY-PROSE" },
      },
      {
        attempt_id: benAttempt!.id,
        item_id: itemRows[0]!.id,
        response: { type: "multiple_choice_single", choice_id: "b" },
      },
      {
        attempt_id: benAttempt!.id,
        item_id: itemRows[1]!.id,
        response: { type: "essay", text: "SECRET-ESSAY-PROSE-TWO" },
      },
    ])
    .returning();

  await db.insert(scores).values([
    {
      response_id: responseRows[0]!.id,
      method: "auto",
      points: 1,
      max_points: 1,
      scorer: "auto",
      status: "final",
    },
    {
      response_id: responseRows[1]!.id,
      method: "human",
      points: 1,
      max_points: 1,
      scorer: OWNER,
      status: "final",
      reviewed_by_sub: OWNER,
    },
    {
      response_id: responseRows[2]!.id,
      method: "auto",
      points: 0,
      max_points: 1,
      scorer: "auto",
      status: "final",
    },
    // Ben's essay: nothing final — he stays incomplete.
  ]);

  await db.insert(attempt_events).values([
    { attempt_id: adaAttempt!.id, kind: "focus_loss" },
    { attempt_id: adaAttempt!.id, kind: "focus_loss" },
    { attempt_id: adaAttempt!.id, kind: "lockdown_end" },
  ]);

  return { db, assessment: a, adaAttempt: adaAttempt!, benAttempt: benAttempt! };
}

describe("print report — owner only", () => {
  test("another teacher gets notFound(), not a page that confirms the id", async () => {
    const { assessment } = await seedPrintScenario();
    mockSub = OTHER_TEACHER;
    let digest = "";
    try {
      await render(assessment.id);
      throw new Error("expected notFound()");
    } catch (err) {
      digest = String((err as { digest?: string }).digest ?? "");
    }
    expect(digest).toContain("404");
  });

  test("an id that is not a uuid is 404 before any query", async () => {
    let digest = "";
    try {
      await render("not-a-uuid");
      throw new Error("expected notFound()");
    } catch (err) {
      digest = String((err as { digest?: string }).digest ?? "");
    }
    expect(digest).toContain("404");
  });

  test("an assessment that does not exist is the same 404", async () => {
    let digest = "";
    try {
      await render("11111111-1111-4111-8111-111111111111");
      throw new Error("expected notFound()");
    } catch (err) {
      digest = String((err as { digest?: string }).digest ?? "");
    }
    expect(digest).toContain("404");
  });
});

describe("print report — structure", () => {
  test("summary page carries the title, N, the means and the per-item table", async () => {
    const { assessment } = await seedPrintScenario();
    const html = await render(assessment.id);

    expect(html).toContain("Print Report Fixture");
    expect(html).toContain("All sections");
    expect(html).toContain("2 handed in");
    // Only Ada is complete: mean total 2 / 2, 100%.
    expect(html).toContain("2 / 2");
    expect(html).toContain("100%");
    expect(html).toContain("1 of 2 still have unscored items");
    // Per-item table: Q1 mean 0.5 → 50%; Q2 one final of 1 → 100%.
    expect(html).toContain("Multiple choice");
    expect(html).toContain("Essay");
    expect(html).toContain("0.5");
    expect(html).toContain("50%");
    expect(html).toContain("Mean points");
    expect(html).toContain("p-value");
  });

  test("P5-3: an item nothing has scored still prints its real Max, not —", async () => {
    // The old `summarizeItems` read an item's max off a scored cell, so a
    // question with zero final scores showed "—" for Max even though its
    // constant denominator is known. `analytics.ts` supplies the constant
    // regardless of scoring state.
    const db = getDb();
    const [assessment] = await db
      .insert(assessments)
      .values({ owner_sub: OWNER, name: "Unscored Item Fixture" })
      .returning();
    const [item] = await db
      .insert(items)
      .values({
        assessment_id: assessment!.id,
        position: 0,
        type: "essay",
        stem: "Ungraded essay",
        config: { scoring_method: "human" },
      })
      .returning();
    const [student] = await db
      .insert(students)
      .values({ owner_sub: OWNER, ssid: "u-1", name: "Uma Unscored" })
      .returning();
    const [attempt] = await db
      .insert(attempts)
      .values({
        assessment_id: assessment!.id,
        student_id: student!.id,
        status: "submitted" as const,
        started_at: new Date("2026-09-03T16:00:00Z"),
        submitted_at: new Date("2026-09-03T16:30:00Z"),
      })
      .returning();
    await db.insert(responses).values({
      attempt_id: attempt!.id,
      item_id: item!.id,
      response: { type: "essay", text: "not yet scored" },
    });
    // Deliberately no `scores` row: the item has zero final scores.

    const html = await render(assessment!.id);
    // The essay's constant max is 1 (no rubric) — it must print, not "—",
    // even though nothing has scored it yet (mean/p-value legitimately do).
    expect(html).toContain('<td class="num">1</td>');
  });

  test("one page per student, in the matrix's order, with the break marker", async () => {
    const { assessment } = await seedPrintScenario();
    const html = await render(assessment.id);

    const ada = html.indexOf("Ada Print");
    const ben = html.indexOf("Ben Print");
    expect(ada).toBeGreaterThan(-1);
    expect(ben).toBeGreaterThan(ada);
    // Two student pages, each its own break-before section.
    expect(html.split('class="student-page"').length - 1).toBe(2);
    expect(html).toContain("page-break-before: always");
    expect(html).toContain("break-before: page");
  });

  test("a student page shows marks, the score line and the integrity line", async () => {
    const { assessment } = await seedPrintScenario();
    const html = await render(assessment.id);

    // P5-1: hand-in time is Pacific (lib/ui/format), not the server's UTC.
    // Ada's attempt is 2026-09-03T17:00:00Z = 10:00 AM Pacific — a UTC
    // render would show 5:00 PM instead.
    expect(html).toContain(`Handed in ${formatDateTime("2026-09-03T17:00:00Z")}`);
    expect(formatDateTime("2026-09-03T17:00:00Z")).toMatch(/^Sep 3.*10:00 AM$/);
    expect(html).toContain("10:00 AM");
    expect(html).not.toContain("5:00 PM");

    // Ada: 2 / 2 · 100%, both marks final.
    expect(html).toContain("1/1");
    // Ben: 0/1 on the MC, an em dash for the unscored essay, 1 unscored.
    expect(html).toContain("0/1");
    expect(html).toContain("—");
    expect(html).toContain("1 unscored");
    // Integrity, in plain words, per attempt. P5-2: Ada's event is an
    // ordinary lockdown_end, so it reads "ended", not "ended by the student"
    // (that phrase belongs to emergency_exit).
    expect(html).toContain("Left the test window 2 times");
    expect(html).toContain("Secure session ended");
    expect(html).not.toContain("Secure session ended by the student");
    expect(html).toContain("No integrity events");
  });

  test("never a free-text response", async () => {
    const { assessment } = await seedPrintScenario();
    const html = await render(assessment.id);
    expect(html).not.toContain("SECRET-ESSAY-PROSE");
    expect(html).not.toContain("SECRET-ESSAY-PROSE-TWO");
  });

  test("the screen-only bar has the print button and the way back", async () => {
    const { assessment } = await seedPrintScenario();
    const html = await render(assessment.id);
    expect(html).toContain("Print / Save as PDF");
    expect(html).toContain(`/dashboard/${assessment.id}/results`);
    expect(html).toContain("window.print()");
  });
});

describe("print report — ?attempt= single-student mode", () => {
  test("one page, no summary page, no other student", async () => {
    const { assessment, adaAttempt } = await seedPrintScenario();
    const html = await render(assessment.id, { attempt: adaAttempt.id });

    expect(html).toContain("Ada Print");
    expect(html).not.toContain("Ben Print");
    // No summary block: no cohort line, no per-item analytics table.
    expect(html).not.toContain("2 handed in");
    expect(html).not.toContain("p-value");
    // The lone page still names the assessment.
    expect(html).toContain("Print Report Fixture");
    expect(html.split('class="student-page"').length - 1).toBe(1);
  });

  test("an attempt id on another assessment renders nothing rather than leaking", async () => {
    const { assessment } = await seedPrintScenario();
    const html = await render(assessment.id, {
      attempt: "22222222-2222-4222-8222-222222222222",
    });
    expect(html).toContain("No handed-in attempts to report.");
    expect(html).not.toContain("Ada Print");
  });
});

describe("print report — D-6 rubric feedback on the single-attempt view", () => {
  const FEEDBACK_RUBRIC = {
    style: "analytic" as const,
    criteria: [
      {
        id: "c1",
        name: "Thesis",
        levels: [
          { id: "l1", label: "Strong", points: 4 },
          { id: "l2", label: "Weak", points: 1 },
        ],
      },
    ],
    student_visibility: { with_feedback: true },
  };
  const FEEDBACK_RATIONALE = {
    criterion_scores: [
      { criterion_id: "c1", level_id: "l1", points: 4, rationale: "Clear, specific claim." },
    ],
    overall_rationale: "Strong work overall.",
  };

  async function seedRubricEssayScenario(opts: {
    withFeedback: boolean;
    status: "final" | "proposed";
  }) {
    const db = getDb();
    const [assessment] = await db
      .insert(assessments)
      .values({ owner_sub: OWNER, name: "Rubric Feedback Fixture" })
      .returning();
    const a = assessment!;
    const [item] = await db
      .insert(items)
      .values({
        assessment_id: a.id,
        position: 0,
        type: "essay",
        stem: "Essay",
        config: {
          scoring_method: "human",
          rubric: {
            ...FEEDBACK_RUBRIC,
            student_visibility: { with_feedback: opts.withFeedback },
          },
        },
      })
      .returning();
    const [student] = await db
      .insert(students)
      .values({ owner_sub: OWNER, ssid: "rf-1", name: "Rae Feedback" })
      .returning();
    const [attempt] = await db
      .insert(attempts)
      .values({
        assessment_id: a.id,
        student_id: student!.id,
        status: "submitted" as const,
        started_at: new Date("2026-09-11T16:00:00Z"),
        submitted_at: new Date("2026-09-11T17:00:00Z"),
      })
      .returning();
    const [response] = await db
      .insert(responses)
      .values({
        attempt_id: attempt!.id,
        item_id: item!.id,
        response: { type: "essay", text: "SECRET-ESSAY-PROSE-FEEDBACK" },
      })
      .returning();
    await db.insert(scores).values({
      response_id: response!.id,
      method: "ai",
      points: 4,
      max_points: 4,
      rationale: FEEDBACK_RATIONALE,
      scorer: "bedrock",
      status: opts.status,
      reviewed_by_sub: opts.status === "final" ? OWNER : null,
    });
    return { assessment: a, attempt: attempt! };
  }

  test("flag on + a final score prints the framing line, the level label, points and rationale", async () => {
    const { assessment, attempt } = await seedRubricEssayScenario({
      withFeedback: true,
      status: "final",
    });
    const html = await render(assessment.id, { attempt: attempt.id });

    expect(html).toContain("Scored with a rubric; the comments below explain each score.");
    expect(html).toContain("Feedback");
    expect(html).toContain("Thesis");
    // The level LABEL prints, never the raw id "l1".
    expect(html).toContain("Strong");
    expect(html).not.toContain(">l1<");
    expect(html).toContain("Clear, specific claim.");
    expect(html).toContain("Strong work overall.");
    // Still never the free-text response.
    expect(html).not.toContain("SECRET-ESSAY-PROSE-FEEDBACK");
  });

  test("flag off prints the score only — no feedback block, no framing line", async () => {
    const { assessment, attempt } = await seedRubricEssayScenario({
      withFeedback: false,
      status: "final",
    });
    const html = await render(assessment.id, { attempt: attempt.id });

    expect(html).not.toContain("Scored with a rubric");
    expect(html).not.toContain("Clear, specific claim.");
    expect(html).not.toContain("Strong work overall.");
    // The mark itself still prints as always.
    expect(html).toContain("4/4");
  });

  test("a proposed-only score never prints feedback, even with the flag on", async () => {
    const { assessment, attempt } = await seedRubricEssayScenario({
      withFeedback: true,
      status: "proposed",
    });
    const html = await render(assessment.id, { attempt: attempt.id });

    expect(html).not.toContain("Scored with a rubric");
    expect(html).not.toContain("Clear, specific claim.");
    expect(html).not.toContain("Strong work overall.");
  });

  test("the section (multi-student) view never shows feedback, even with the flag on", async () => {
    const { assessment } = await seedRubricEssayScenario({
      withFeedback: true,
      status: "final",
    });
    const html = await render(assessment.id);

    expect(html).not.toContain("Scored with a rubric");
    expect(html).not.toContain("Clear, specific claim.");
  });
});

describe("print report — ?section= filter", () => {
  test("a section nobody resolves to reports nobody", async () => {
    const { assessment } = await seedPrintScenario();
    // Neither student has a roster binding, so both resolve to a null section.
    const html = await render(assessment.id, { section: "Biology · 3" });
    expect(html).toContain("Biology · 3");
    expect(html).toContain("0 handed in");
    expect(html).not.toContain("Ada Print");
    expect(html).not.toContain("Ben Print");
  });

  test("no section param prints every student under All sections", async () => {
    const { assessment } = await seedPrintScenario();
    const html = await render(assessment.id);
    expect(html).toContain("All sections");
    expect(html).toContain("Ada Print");
    expect(html).toContain("Ben Print");
  });
});

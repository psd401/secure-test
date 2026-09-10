// R1 (docs/reporting-design.md): the three teacher surfaces — the Results
// link on the Assessments list, the matrix's section filter and Complete
// marker, and the per-student attempt page.
//
// The pages are async server components with no async children, so awaiting
// the page function gives an element tree renderToStaticMarkup can render —
// the same shape the error-boundary tests use.
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
  test_sessions,
} from "../db/schema";
import { SESSION_COOKIE_NAME } from "../lib/auth/session";
import * as sessionMod from "../lib/auth/session";
import { buildResults } from "../lib/scoring/results";
import {
  OTHER_STUDENT,
  STUDENT,
  TEACHER_EMAIL,
  clearRoster,
  seedRoster,
} from "./helpers/roster";

const expectTestDb = () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("secure_test_design_tool_test")) {
    throw new Error(`reporting-views tests require the test DB; got: ${url}`);
  }
};

const OWNER = "reporting-views-teacher";
let principal: { sub: string; role: string; email?: string } | null = null;

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

beforeAll(async () => {
  expectTestDb();
  await seedRoster();
  principal = { sub: OWNER, role: "staff", email: TEACHER_EMAIL };
});

afterEach(async () => {
  principal = { sub: OWNER, role: "staff", email: TEACHER_EMAIL };
  const db = getDb();
  await db.execute(sql`truncate table assessments restart identity cascade`);
  await db.execute(sql`truncate table students restart identity cascade`);
});

afterAll(async () => {
  await clearRoster();
  await closeDb();
});

const SUBMITTED_AT = new Date("2026-09-07T21:40:00Z");

/**
 * One assessment carrying every item type, two handed-in attempts:
 *   Alice — a sitting in section 5003, an answer to every item, one final
 *           auto score, one final human score, one AI PROPOSAL (so her row
 *           is not complete).
 *   Bob   — no sitting (section falls back to his enrollment), one answer,
 *           fully scored, so his row is Complete.
 */
async function seedScene() {
  const db = getDb();
  const [assessment] = await db
    .insert(assessments)
    .values({ owner_sub: OWNER, name: "Unit 3 check", status: "published" })
    .returning();

  const itemRows = await db
    .insert(items)
    .values([
      {
        assessment_id: assessment!.id,
        position: 0,
        type: "multiple_choice_single",
        stem: "Pick the metal",
        choices: [
          { id: "a", text: "Copper" },
          { id: "b", text: "Neon" },
        ],
        correct_choice_ids: ["a"],
      },
      {
        assessment_id: assessment!.id,
        position: 1,
        type: "essay",
        stem: "Explain your reasoning",
      },
      {
        assessment_id: assessment!.id,
        position: 2,
        type: "short_text",
        stem: "Name the capital",
        correct_answer: "Olympia",
      },
      {
        assessment_id: assessment!.id,
        position: 3,
        type: "match",
        stem: "Match them",
        config: {
          pairs: [
            { id: "p1", left: "Water", right: "H2O" },
            { id: "p2", left: "Salt", right: "NaCl" },
          ],
        },
      },
      {
        assessment_id: assessment!.id,
        position: 4,
        type: "order",
        stem: "Put these in order",
        config: {
          sequence: [
            { id: "e1", label: "Sprout" },
            { id: "e2", label: "Flower" },
          ],
        },
      },
      {
        assessment_id: assessment!.id,
        position: 5,
        type: "hotspot",
        stem: "Mark the nucleus",
        config: {
          regions: [{ id: "r1", x: 0.1, y: 0.1, w: 0.2, h: 0.2 }],
          correct_region_ids: ["r1"],
        },
      },
      {
        assessment_id: assessment!.id,
        position: 6,
        type: "drawing_upload",
        stem: "Sketch the graph",
      },
      {
        assessment_id: assessment!.id,
        position: 7,
        type: "table",
        stem: "Fill the table",
        config: {
          columns: [{ id: "c1", label: "Mass" }],
          rows: [{ id: "r1", label: "Sample" }],
          cell_keys: { r1: { c1: "12" } },
        },
      },
    ])
    .returning();

  const [alice, bob] = await db
    .insert(students)
    .values([
      { owner_sub: OWNER, roster_ps_id: STUDENT.ps_id, name: "Alice Overlay" },
      { owner_sub: OWNER, roster_ps_id: OTHER_STUDENT.ps_id, name: "Bob Overlay" },
    ])
    .returning();

  const [sitting] = await db
    .insert(test_sessions)
    .values({
      assessment_id: assessment!.id,
      owner_sub: OWNER,
      owner_email: TEACHER_EMAIL,
      section_ps_id: "5003",
      code: "RV01TST",
      status: "open",
      expires_at: new Date(Date.now() + 3600_000),
    })
    .returning();

  const [aliceAttempt, bobAttempt] = await db
    .insert(attempts)
    .values([
      {
        assessment_id: assessment!.id,
        student_id: alice!.id,
        test_session_id: sitting!.id,
        status: "submitted" as const,
        submitted_at: SUBMITTED_AT,
      },
      {
        assessment_id: assessment!.id,
        student_id: bob!.id,
        status: "submitted" as const,
        submitted_at: SUBMITTED_AT,
      },
    ])
    .returning();

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
        response: { type: "essay", text: "Because the metal conducts." },
      },
      {
        attempt_id: aliceAttempt!.id,
        item_id: itemRows[2]!.id,
        response: { type: "short_text", text: "Olympia" },
      },
      {
        attempt_id: aliceAttempt!.id,
        item_id: itemRows[3]!.id,
        response: { type: "match", matches: { p1: "p1", p2: "p1" } },
      },
      {
        attempt_id: aliceAttempt!.id,
        item_id: itemRows[4]!.id,
        response: { type: "order", ordered_ids: ["e2", "e1"] },
      },
      {
        attempt_id: aliceAttempt!.id,
        item_id: itemRows[5]!.id,
        response: { type: "hotspot", region_ids: ["r1"] },
      },
      {
        attempt_id: aliceAttempt!.id,
        item_id: itemRows[6]!.id,
        response: { type: "drawing_upload", upload_id: "upload-abc" },
      },
      {
        attempt_id: aliceAttempt!.id,
        item_id: itemRows[7]!.id,
        response: { type: "table", cells: { r1: { c1: "12" } } },
      },
    ])
    .returning();

  await db.insert(scores).values([
    {
      response_id: aliceResponses[0]!.id,
      method: "auto",
      points: 1,
      max_points: 1,
      scorer: "auto",
      status: "final",
    },
    {
      response_id: aliceResponses[1]!.id,
      method: "human",
      points: 3,
      max_points: 4,
      scorer: OWNER,
      rationale: { overall_rationale: "Clear reasoning, thin evidence." },
      status: "final",
    },
    // A PROPOSAL: shown on the page, never counted anywhere.
    {
      response_id: aliceResponses[2]!.id,
      method: "ai",
      points: 1,
      max_points: 1,
      scorer: "model-x",
      rationale: { overall_rationale: "Matches the expected answer." },
      status: "proposed",
    },
  ]);

  const [bobResponse] = await db
    .insert(responses)
    .values({
      attempt_id: bobAttempt!.id,
      item_id: itemRows[0]!.id,
      response: { type: "multiple_choice_single", choice_id: "b" },
    })
    .returning();
  await db.insert(scores).values({
    response_id: bobResponse!.id,
    method: "auto",
    points: 0,
    max_points: 1,
    scorer: "auto",
    status: "final",
  });

  await db.insert(attempt_events).values([
    {
      attempt_id: aliceAttempt!.id,
      kind: "lockdown_begin",
      at: new Date("2026-09-07T21:00:00Z"),
    },
    { attempt_id: aliceAttempt!.id, kind: "focus_loss", at: new Date("2026-09-07T21:14:00Z") },
    {
      attempt_id: aliceAttempt!.id,
      kind: "focus_regained",
      at: new Date("2026-09-07T21:15:00Z"),
    },
    {
      attempt_id: aliceAttempt!.id,
      kind: "emergency_exit",
      at: new Date("2026-09-07T21:39:00Z"),
    },
  ]);

  return {
    assessment: assessment!,
    aliceAttempt: aliceAttempt!,
    bobAttempt: bobAttempt!,
  };
}

async function renderResults(assessmentId: string, section?: string) {
  const { default: ResultsPage } = await import("../app/dashboard/[id]/results/page");
  const element = await ResultsPage({
    params: Promise.resolve({ id: assessmentId }),
    searchParams: Promise.resolve(section === undefined ? {} : { section }),
  });
  return renderToStaticMarkup(element);
}

async function renderAttempt(assessmentId: string, attemptId: string) {
  const { default: AttemptPage } = await import(
    "../app/dashboard/[id]/results/[attemptId]/page"
  );
  const element = await AttemptPage({
    params: Promise.resolve({ id: assessmentId, attemptId }),
  });
  return renderToStaticMarkup(element);
}

describe("the Assessments list", () => {
  test("a published assessment carries a Results link; a draft does not", async () => {
    const db = getDb();
    const [published] = await db
      .insert(assessments)
      .values({ owner_sub: OWNER, name: "Published one", status: "published" })
      .returning();
    const [draft] = await db
      .insert(assessments)
      .values({ owner_sub: OWNER, name: "Draft one", status: "draft" })
      .returning();

    const { default: DashboardPage } = await import("../app/dashboard/page");
    const html = renderToStaticMarkup(
      await DashboardPage({ searchParams: Promise.resolve({}) }),
    );

    expect(html).toContain(`/dashboard/${published!.id}/results`);
    expect(html).toContain(">Results</a>");
    expect(html).not.toContain(`/dashboard/${draft!.id}/results`);
  });

  // D-4 (docs/archive-and-delete-design.md): the two lists partition the
  // teacher's assessments — the default view never shows an archived row,
  // and ?archived=1 shows only them.
  test("archived assessments are hidden by default and shown on ?archived=1", async () => {
    const db = getDb();
    const [live] = await db
      .insert(assessments)
      .values({ owner_sub: OWNER, name: "Live one", status: "draft" })
      .returning();
    const [archived] = await db
      .insert(assessments)
      .values({
        owner_sub: OWNER,
        name: "Archived one",
        status: "draft",
        archived_at: new Date("2026-09-05T00:00:00Z"),
      })
      .returning();

    const { default: DashboardPage } = await import("../app/dashboard/page");

    const defaultHtml = renderToStaticMarkup(
      await DashboardPage({ searchParams: Promise.resolve({}) }),
    );
    expect(defaultHtml).toContain(live!.name);
    expect(defaultHtml).not.toContain(archived!.name);
    expect(defaultHtml).toContain("Show archived (1)");
    expect(defaultHtml).not.toContain("Hide archived");

    const archivedHtml = renderToStaticMarkup(
      await DashboardPage({ searchParams: Promise.resolve({ archived: "1" }) }),
    );
    expect(archivedHtml).toContain(archived!.name);
    expect(archivedHtml).not.toContain(live!.name);
    expect(archivedHtml).toContain("Archived");
    expect(archivedHtml).toContain("Hide archived");
    expect(archivedHtml).not.toContain("Show archived");
  });
});

describe("the results matrix", () => {
  test("every student's name opens their attempt page", async () => {
    const scene = await seedScene();
    const html = await renderResults(scene.assessment.id);
    expect(html).toContain(
      `/dashboard/${scene.assessment.id}/results/${scene.aliceAttempt.id}`,
    );
    expect(html).toContain(
      `/dashboard/${scene.assessment.id}/results/${scene.bobAttempt.id}`,
    );
  });

  test("the Complete marker is text plus a glyph, and only on a fully scored row", async () => {
    const scene = await seedScene();
    const html = await renderResults(scene.assessment.id);
    // Bob: one answer, finalized => complete. Alice: an AI proposal and six
    // unscored answers => not.
    expect(html).toContain("✓ Complete");
    expect(html).toContain("to score");
    expect(html.match(/✓ Complete/g)).toHaveLength(1);
  });

  test("the section filter narrows the rows and offers every section present", async () => {
    const scene = await seedScene();
    const results = await buildResults(scene.assessment.id, OWNER, TEACHER_EMAIL);
    const aliceSection = results.rows.find(
      (r) => r.attempt_id === scene.aliceAttempt.id,
    )!.student.section!;
    const bobSection = results.rows.find(
      (r) => r.attempt_id === scene.bobAttempt.id,
    )!.student.section!;
    expect(aliceSection).not.toBe(bobSection);

    const all = await renderResults(scene.assessment.id);
    expect(all).toContain("All sections");
    expect(all).toContain(aliceSection);
    expect(all).toContain(bobSection);

    const filtered = await renderResults(scene.assessment.id, aliceSection);
    expect(filtered).toContain(scene.aliceAttempt.id);
    expect(filtered).not.toContain(scene.bobAttempt.id);
  });

  test("a section with nobody in it says so rather than showing an empty grid", async () => {
    const scene = await seedScene();
    const html = await renderResults(scene.assessment.id, "Nowhere · 9");
    expect(html).toContain("No handed-in work in that section");
  });

  test("the analytics footer reports the distractor counts with the key marked", async () => {
    const scene = await seedScene();
    const html = await renderResults(scene.assessment.id);
    expect(html).toContain("How the class did, question by question");
    // Q1: Alice picked the key (a), Bob picked b. Mean 0.5 of 1 => p 50%,
    // answered 2 of 2 => 100%.
    expect(html).toContain("Copper");
    expect(html).toContain("50%");
    expect(html).toContain("(2 of 2)");
  });
});

describe("the per-student attempt page", () => {
  test("the header carries the identity, the hand-in time and the total", async () => {
    const scene = await seedScene();
    const html = await renderAttempt(scene.assessment.id, scene.aliceAttempt.id);
    expect(html).toContain("Alice Overlay");
    expect(html).toContain(STUDENT.ps_id);
    expect(html).toContain("Handed in");
    // Roadmap 2026-09 delete attempt: the owner's button is on the page.
    expect(html).toContain("Delete attempt");
    // 4 of 12 (MC 1 + essay 4 + six 1-pointers + a 1-cell table) with the
    // short_text proposal uncounted, so a "n unscored" count, not a percent.
    expect(html).toContain("unscored");
  });

  test("every item type renders the student's answer", async () => {
    const scene = await seedScene();
    const html = await renderAttempt(scene.assessment.id, scene.aliceAttempt.id);
    expect(html).toContain("Copper"); // MC choice text, not its id
    expect(html).toContain("Because the metal conducts."); // essay
    expect(html).toContain("Olympia"); // short text
    expect(html).toContain("Water → H2O"); // match, resolved to pair text
    expect(html).toContain("1. Flower"); // order, in the order given
    expect(html).toContain("Region r1"); // hotspot
    expect(html).toContain("Fill the table"); // table stem
    expect(html).toContain(">12<"); // the table cell the student typed
  });

  test("a drawing is served full size from the owner-scoped upload route", async () => {
    const scene = await seedScene();
    const html = await renderAttempt(scene.assessment.id, scene.aliceAttempt.id);
    expect(html).toMatch(/src="\/api\/responses\/[0-9a-f-]+\/upload"/);
    // Full size here: the queue's max-h-48 cap is deliberately absent.
    expect(html).not.toContain("max-h-48");
  });

  test("the final score names its method and shows the teacher's rationale", async () => {
    const scene = await seedScene();
    const html = await renderAttempt(scene.assessment.id, scene.aliceAttempt.id);
    expect(html).toContain("auto-scored");
    expect(html).toContain("scored by you");
    expect(html).toContain("Clear reasoning, thin evidence.");
  });

  test("an AI proposal is shown as a proposal and marked not counted", async () => {
    const scene = await seedScene();
    const html = await renderAttempt(scene.assessment.id, scene.aliceAttempt.id);
    expect(html).toContain("AI proposal: 1 / 1 (not counted)");
  });

  test("the integrity timeline pairs the focus gap and names the exit", async () => {
    const scene = await seedScene();
    const html = await renderAttempt(scene.assessment.id, scene.aliceAttempt.id);
    expect(html).toContain("Secure session started 2:00 PM");
    expect(html).toContain("Left the test window 2:14 PM · back 2:15 PM (1 min)");
    expect(html).toContain("Secure session ended by the student 2:39 PM");
  });

  test("an attempt with no events says so", async () => {
    const scene = await seedScene();
    const html = await renderAttempt(scene.assessment.id, scene.bobAttempt.id);
    expect(html).toContain("sent no session events");
  });

  test("another teacher's assessment is not found, not forbidden", async () => {
    const scene = await seedScene();
    principal = { sub: "someone-else", role: "staff", email: "teacher.two@psd401.net" };
    await expect(
      renderAttempt(scene.assessment.id, scene.aliceAttempt.id),
    ).rejects.toThrow();
  });

  test("an attempt id from a different assessment is not found", async () => {
    const scene = await seedScene();
    const db = getDb();
    const [other] = await db
      .insert(assessments)
      .values({ owner_sub: OWNER, name: "Other", status: "published" })
      .returning();
    await expect(renderAttempt(other!.id, scene.aliceAttempt.id)).rejects.toThrow();
  });
});

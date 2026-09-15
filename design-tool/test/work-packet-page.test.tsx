// Slice 1 of docs/student-work-export-design.md: the packet page rendered
// headless — one page per handed-in student, the checkbox glyph on EVERY
// choice, the teacher / AI score blocks, the anonymous labels and the tear-off
// key page, and the owner-only posture. The repo has no DOM harness, so the
// page is awaited and its element tree rendered, the same way
// reporting-print.test.tsx does it.
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { closeDb, getDb } from "../db/client";
import {
  assessments,
  assets,
  attempts,
  item_sets,
  items,
  responses,
  roster_sections,
  scores,
  students,
  test_sessions,
} from "../db/schema";
import { SESSION_COOKIE_NAME } from "../lib/auth/session";
import * as sessionMod from "../lib/auth/session";
import { sectionLabel } from "../lib/roster/teacherRoster";
import { OTHER_STUDENT, STUDENT, TEACHER_EMAIL, clearRoster, seedRoster } from "./helpers/roster";

const expectTestDb = () => {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("secure_test_design_tool_test")) {
    throw new Error(`work-packet page tests require the test DB; got: ${url}`);
  }
};

const OWNER = "work-packet-teacher";
const OTHER_TEACHER = "work-packet-other-teacher";
let principal: { sub: string; role: string; email?: string | null } | null = null;

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

const { default: StudentWorkPacketPage } = await import(
  "../app/dashboard/[id]/results/work/page"
);

// The section both attempts resolve to: the sitting names 5001, so the label
// is that roster section's, whatever the fixture calls it.
let SECTION = "";

beforeAll(async () => {
  expectTestDb();
  await seedRoster();
  const [row] = await getDb()
    .select()
    .from(roster_sections)
    .where(eq(roster_sections.ps_id, "5001"))
    .limit(1);
  SECTION = sectionLabel(row!);
  principal = { sub: OWNER, role: "staff", email: TEACHER_EMAIL };
});

afterEach(async () => {
  principal = { sub: OWNER, role: "staff", email: TEACHER_EMAIL };
  const db = getDb();
  await db.execute(sql`truncate table assessments restart identity cascade`);
  await db.execute(sql`truncate table students restart identity cascade`);
  await db.execute(sql`truncate table assets restart identity cascade`);
});

afterAll(async () => {
  await clearRoster();
  await closeDb();
});

async function render(
  id: string,
  search: Record<string, string> = {},
): Promise<string> {
  const element = await StudentWorkPacketPage({
    params: Promise.resolve({ id }),
    searchParams: Promise.resolve(search),
  });
  return renderToStaticMarkup(element);
}

// Slice 2's toolbar lists EVERY item's Qn + stem excerpt in its checklist,
// regardless of `?items=` / `?questions=`, so a stem string can legitimately
// appear there even when the printed packet itself excludes that question.
// Assertions about what actually PRINTS are scoped to this slice of the html.
function packetBody(html: string): string {
  const at = html.indexOf('<main class="packet"');
  return at === -1 ? html : html.slice(at);
}

/**
 * One assessment with every item type, two students in the same section, both
 * handed in through the same sitting:
 *
 *   Ada Fixture (ps 1001) — an answer to every item; on the essay a HUMAN
 *     final, an AI PROPOSAL and a `research` row (the corpus's), so the packet
 *     has to print two of the three and never the third.
 *   Ben Sample (ps 1002)  — the multi-select and the essay only.
 *
 * The multi-select's choices are three, one of them picked, so the checkbox
 * assertions have a ☑ and two ☐ to find.
 */
async function seedPacketScene() {
  const db = getDb();
  const [assessment] = await db
    .insert(assessments)
    .values({ owner_sub: OWNER, name: "Work Packet Fixture", status: "published" })
    .returning();
  const a = assessment!;

  const itemRows = await db
    .insert(items)
    .values([
      {
        assessment_id: a.id,
        position: 0,
        type: "multiple_choice_multi",
        stem: "STEM-MC-MULTI pick every metal",
        choices: [
          { id: "c1", text: "CHOICE-COPPER" },
          { id: "c2", text: "CHOICE-NEON" },
          { id: "c3", text: "CHOICE-IRON" },
        ],
        correct_choice_ids: ["c1", "c3"],
      },
      {
        assessment_id: a.id,
        position: 1,
        type: "essay",
        stem: "STEM-ESSAY explain your reasoning",
        config: {
          scoring_method: "human",
          rubric: {
            style: "analytic",
            criteria: [
              {
                id: "focus",
                name: "CRITERION-FOCUS",
                levels: [
                  { id: "hi", label: "Strong", points: 4 },
                  { id: "lo", label: "Weak", points: 1 },
                ],
              },
            ],
          },
        },
      },
      {
        assessment_id: a.id,
        position: 2,
        type: "short_text",
        stem: "STEM-SHORT name the capital",
        correct_answer: "Olympia",
      },
      {
        assessment_id: a.id,
        position: 3,
        type: "multiple_choice_single",
        stem: "STEM-MC-SINGLE pick one",
        choices: [
          { id: "s1", text: "CHOICE-YES" },
          { id: "s2", text: "CHOICE-NO" },
        ],
        correct_choice_ids: ["s1"],
      },
      {
        assessment_id: a.id,
        position: 4,
        type: "match",
        stem: "STEM-MATCH match them",
        config: {
          pairs: [
            { id: "p1", left: "Water", right: "H2O" },
            { id: "p2", left: "Salt", right: "NaCl" },
          ],
        },
      },
      {
        assessment_id: a.id,
        position: 5,
        type: "order",
        stem: "STEM-ORDER put these in order",
        config: {
          sequence: [
            { id: "e1", label: "Sprout" },
            { id: "e2", label: "Flower" },
          ],
        },
      },
      {
        assessment_id: a.id,
        position: 6,
        type: "hotspot",
        stem: "STEM-HOTSPOT mark the nucleus",
        config: {
          regions: [{ id: "r1", x: 0.1, y: 0.1, w: 0.2, h: 0.2 }],
          correct_region_ids: ["r1"],
        },
      },
      {
        assessment_id: a.id,
        position: 7,
        type: "drawing_upload",
        stem: "STEM-DRAWING sketch the graph",
      },
      {
        assessment_id: a.id,
        position: 8,
        type: "table",
        stem: "STEM-TABLE fill the table",
        config: {
          columns: [{ id: "tc1", label: "Mass" }],
          rows: [{ id: "tr1", label: "Sample" }],
          cell_keys: { tr1: { tc1: "12" } },
        },
      },
    ])
    .returning();

  const [ada, ben] = await db
    .insert(students)
    .values([
      { owner_sub: OWNER, roster_ps_id: STUDENT.ps_id, name: "Fixture, Ada" },
      { owner_sub: OWNER, roster_ps_id: OTHER_STUDENT.ps_id, name: "Sample, Ben" },
    ])
    .returning();

  const [sitting] = await db
    .insert(test_sessions)
    .values({
      assessment_id: a.id,
      owner_sub: OWNER,
      owner_email: TEACHER_EMAIL,
      section_ps_id: "5001",
      code: "WP01TST",
      status: "closed",
      expires_at: new Date("2026-09-14T23:00:00Z"),
    })
    .returning();

  const attemptRows = await db
    .insert(attempts)
    .values([
      {
        assessment_id: a.id,
        student_id: ada!.id,
        test_session_id: sitting!.id,
        status: "submitted" as const,
        started_at: new Date("2026-09-14T16:00:00Z"),
        submitted_at: new Date("2026-09-14T17:00:00Z"),
      },
      {
        assessment_id: a.id,
        student_id: ben!.id,
        test_session_id: sitting!.id,
        status: "submitted" as const,
        started_at: new Date("2026-09-14T16:00:00Z"),
        submitted_at: new Date("2026-09-14T17:05:00Z"),
      },
    ])
    .returning();
  const [adaAttempt, benAttempt] = attemptRows;

  const adaResponses = await db
    .insert(responses)
    .values([
      {
        attempt_id: adaAttempt!.id,
        item_id: itemRows[0]!.id,
        response: { type: "multiple_choice_multi", choice_ids: ["c1"] },
      },
      {
        attempt_id: adaAttempt!.id,
        item_id: itemRows[1]!.id,
        response: { type: "essay", text: "ADA-ESSAY-PROSE line one\nline two" },
      },
      {
        attempt_id: adaAttempt!.id,
        item_id: itemRows[2]!.id,
        response: { type: "short_text", text: "Olympia" },
      },
      {
        attempt_id: adaAttempt!.id,
        item_id: itemRows[3]!.id,
        response: { type: "multiple_choice_single", choice_id: "s1" },
      },
      {
        attempt_id: adaAttempt!.id,
        item_id: itemRows[4]!.id,
        response: { type: "match", matches: { p1: "p1", p2: "p1" } },
      },
      {
        attempt_id: adaAttempt!.id,
        item_id: itemRows[5]!.id,
        response: { type: "order", ordered_ids: ["e2", "e1"] },
      },
      {
        attempt_id: adaAttempt!.id,
        item_id: itemRows[6]!.id,
        response: { type: "hotspot", region_ids: ["r1"] },
      },
      {
        attempt_id: adaAttempt!.id,
        item_id: itemRows[7]!.id,
        response: { type: "drawing_upload", upload_id: "upload-abc" },
      },
      {
        attempt_id: adaAttempt!.id,
        item_id: itemRows[8]!.id,
        response: { type: "table", cells: { tr1: { tc1: "12" } } },
      },
    ])
    .returning();

  await db.insert(responses).values([
    {
      attempt_id: benAttempt!.id,
      item_id: itemRows[0]!.id,
      response: { type: "multiple_choice_multi", choice_ids: ["c2", "c3"] },
    },
    {
      attempt_id: benAttempt!.id,
      item_id: itemRows[1]!.id,
      response: { type: "essay", text: "BEN-ESSAY-PROSE" },
    },
  ]);

  // Ada's essay carries all three statuses at once — the teacher's final, the
  // AI's live proposal, and a corpus research row that must never print.
  await db.insert(scores).values([
    {
      response_id: adaResponses[1]!.id,
      method: "human",
      points: 3,
      max_points: 4,
      scorer: OWNER,
      status: "final",
      reviewed_by_sub: OWNER,
      rationale: {
        criterion_scores: [
          { criterion_id: "focus", level_id: "hi", points: 3, rationale: "HUMAN-WHY" },
        ],
        overall_rationale: "HUMAN-OVERALL",
      },
    },
    {
      response_id: adaResponses[1]!.id,
      method: "ai",
      points: 2,
      max_points: 4,
      scorer: "bedrock",
      status: "proposed",
      created_at: new Date("2026-09-14T18:00:00Z"),
      rationale: {
        criterion_scores: [
          { criterion_id: "focus", level_id: "lo", points: 2, rationale: "AI-WHY" },
        ],
        overall_rationale: "AI-OVERALL",
      },
    },
    {
      response_id: adaResponses[1]!.id,
      method: "ai",
      points: 1,
      max_points: 4,
      scorer: "bedrock",
      status: "research",
      created_at: new Date("2026-09-14T19:00:00Z"),
      rationale: {
        criterion_scores: [
          { criterion_id: "focus", level_id: "hi", points: 1, rationale: "RESEARCH-WHY" },
        ],
        overall_rationale: "RESEARCH-OVERALL",
      },
    },
    {
      response_id: adaResponses[0]!.id,
      method: "auto",
      points: 0,
      max_points: 1,
      scorer: "auto",
      status: "final",
    },
  ]);

  return { assessment: a, items: itemRows, adaAttempt: adaAttempt!, benAttempt: benAttempt! };
}

describe("work packet — owner only", () => {
  test("another teacher gets notFound(), not a page that confirms the id", async () => {
    const { assessment } = await seedPacketScene();
    principal = { sub: OTHER_TEACHER, role: "staff", email: "teacher.two@psd401.net" };
    let digest = "";
    try {
      await render(assessment.id, { section: SECTION });
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
});

describe("work packet — the section is required", () => {
  test("no section renders the chooser: the sections as links, nothing printable", async () => {
    const { assessment } = await seedPacketScene();
    const html = await render(assessment.id);

    expect(html).toContain("Print student work");
    expect(html).toContain(SECTION);
    expect(html).toContain("2 handed in");
    expect(html).toContain(
      `/dashboard/${assessment.id}/results/work?section=${encodeURIComponent(SECTION)}`,
    );
    // No packet at all: no student page, and no student work.
    expect(html).not.toContain('class="student-page"');
    expect(html).not.toContain("ADA-ESSAY-PROSE");
  });

  test("a section nobody resolves to prints nobody, and says so", async () => {
    const { assessment } = await seedPacketScene();
    const html = await render(assessment.id, { section: "Nonexistent · 9" });
    expect(html).toContain("has handed this in yet");
    expect(html).not.toContain('class="student-page"');
    expect(html).not.toContain("ADA-ESSAY-PROSE");
  });
});

describe("work packet — one page per student, every item type", () => {
  test("two student pages, named, in last-name order, with the break marker", async () => {
    const { assessment } = await seedPacketScene();
    const html = await render(assessment.id, { section: SECTION });

    expect(html.split('class="student-page').length - 1).toBe(2);
    const ada = html.indexOf("Fixture, Ada");
    const ben = html.indexOf("Sample, Ben");
    expect(ada).toBeGreaterThan(-1);
    expect(ben).toBeGreaterThan(ada);
    expect(html).toContain("break-before: page");
    // The request's one hard number.
    expect(html).toContain("margin: 1in");
    // The strip: the counts and the print button.
    expect(html).toContain("Print / Save as PDF");
    expect(html).toContain("window.print()");
    expect(html).toContain(`2 of 2 students in ${SECTION} handed in`);
  });

  test("this page DOES print free text, unlike the report", async () => {
    const { assessment } = await seedPacketScene();
    const html = await render(assessment.id, { section: SECTION });
    expect(html).toContain("ADA-ESSAY-PROSE");
    expect(html).toContain("BEN-ESSAY-PROSE");
    // pre-line keeps the student's own line breaks.
    expect(html).toContain("white-space: pre-line");
  });

  test("every item type draws: choices, text, match, order, hotspot, drawing, table", async () => {
    const { assessment } = await seedPacketScene();
    const html = await render(assessment.id, { section: SECTION });

    expect(html).toContain("STEM-MC-MULTI");
    expect(html).toContain("STEM-MATCH");
    expect(html).toContain("Water → H2O");
    expect(html).toContain("1. Flower");
    expect(html).toContain("Region r1");
    expect(html).toContain("/upload");
    // The table grid, with the key beside the student's cell.
    expect(html).toContain("Mass");
    expect(html).toContain("expected 12");
    // The short-text key still reads as the teacher's expected answer.
    expect(html).toContain("Olympia");
    // An item with no answer says so rather than printing an empty block.
    expect(html).toContain("No answer.");
  });

  test("EVERY choice prints with a checkbox glyph, the chosen one ticked", async () => {
    const { assessment } = await seedPacketScene();
    const html = await render(assessment.id, { section: SECTION });

    // The multi-select: Ada picked CHOICE-COPPER only, so one ☑ and two ☐.
    expect(html).toContain("☑");
    expect(html).toContain("☐");
    expect(html).toContain("CHOICE-COPPER");
    expect(html).toContain("CHOICE-NEON");
    expect(html).toContain("CHOICE-IRON");
    const adaPage = html.slice(html.indexOf("Fixture, Ada"), html.indexOf("Sample, Ben"));
    expect(adaPage).toContain("☑</span>CHOICE-COPPER");
    expect(adaPage).toContain("☐</span>CHOICE-NEON");
    expect(adaPage).toContain("☐</span>CHOICE-IRON");
  });

  test("?items= narrows the packet to the chosen questions", async () => {
    const { assessment, items: itemRows } = await seedPacketScene();
    const html = await render(assessment.id, {
      section: SECTION,
      items: itemRows[1]!.id,
    });
    const body = packetBody(html);
    expect(body).toContain("STEM-ESSAY");
    expect(body).not.toContain("STEM-MC-MULTI");
    expect(body).not.toContain("STEM-TABLE");
    // The toolbar's checklist still lists every item, narrowed or not.
    expect(html).toContain("STEM-MC-MULTI");
  });

  test("?questions=0 drops the stems and prints only what was chosen", async () => {
    const { assessment } = await seedPacketScene();
    const html = await render(assessment.id, { section: SECTION, questions: "0" });
    const body = packetBody(html);

    expect(body).not.toContain("STEM-ESSAY");
    expect(body).not.toContain("STEM-MC-MULTI");
    // Answers stay — including the free text and the SELECTED choice text.
    expect(body).toContain("ADA-ESSAY-PROSE");
    expect(body).toContain("CHOICE-COPPER");
    // No checkbox lines, so an option this student did not choose is not
    // printed at all — Ada picked COPPER only, so NEON is absent from her page
    // (it is on Ben's, because he picked it).
    const adaPage = body.slice(body.indexOf("Fixture, Ada"), body.indexOf("Sample, Ben"));
    expect(adaPage).toContain("CHOICE-COPPER");
    expect(adaPage).not.toContain("CHOICE-NEON");
    expect(body).not.toContain("☐");
  });
});

describe("work packet — scores", () => {
  test("scores=both prints the teacher block and the AI proposal, never the research row", async () => {
    const { assessment } = await seedPacketScene();
    const html = await render(assessment.id, { section: SECTION, scores: "both" });

    expect(html).toContain("Teacher score");
    expect(html).toContain("3 / 4");
    expect(html).toContain("HUMAN-WHY");
    expect(html).toContain("HUMAN-OVERALL");
    expect(html).toContain("AI proposal");
    expect(html).toContain("2 / 4");
    expect(html).toContain("AI-WHY");
    expect(html).toContain("AI-OVERALL");
    // The corpus row's points and rationale never appear — it is the NEWEST
    // ai row, so only the status filter keeps it off the page.
    expect(html).not.toContain("1 / 4");
    expect(html).not.toContain("RESEARCH-WHY");
    expect(html).not.toContain("RESEARCH-OVERALL");
    // Ben's essay has no score of either kind: both placeholders print.
    expect(html).toContain("No teacher score");
    expect(html).toContain("No AI score");
    // The auto final on the MC reads as the teacher's, because their key made it.
    expect(html).toContain("Auto score (your answer key)");
    // The criterion name resolves through the rubric, never a raw level id.
    expect(html).toContain("CRITERION-FOCUS");
    expect(html).not.toContain(">hi<");
  });

  test("scores=none is the default: no score block anywhere", async () => {
    const { assessment } = await seedPacketScene();
    const html = await render(assessment.id, { section: SECTION });
    expect(html).not.toContain("Teacher score");
    expect(html).not.toContain("AI proposal");
    expect(html).not.toContain("No teacher score");
  });

  test("scores=teacher and scores=ai each drop the other side", async () => {
    const { assessment } = await seedPacketScene();
    const teacherOnly = await render(assessment.id, {
      section: SECTION,
      scores: "teacher",
    });
    expect(teacherOnly).toContain("Teacher score");
    expect(teacherOnly).not.toContain("AI proposal");
    expect(teacherOnly).not.toContain("AI-OVERALL");

    const aiOnly = await render(assessment.id, { section: SECTION, scores: "ai" });
    expect(aiOnly).toContain("AI proposal");
    expect(aiOnly).not.toContain("Teacher score");
    expect(aiOnly).not.toContain("HUMAN-OVERALL");
  });

  test("an unreadable scores value falls back to none instead of erroring", async () => {
    const { assessment } = await seedPacketScene();
    const html = await render(assessment.id, { section: SECTION, scores: "everything" });
    expect(html).not.toContain("Teacher score");
    expect(html).toContain("ADA-ESSAY-PROSE");
  });
});

describe("work packet — anonymous mode (D-1)", () => {
  test("labels replace names on the student pages, and the key page maps both", async () => {
    const { assessment } = await seedPacketScene();
    const html = await render(assessment.id, { section: SECTION, anon: "1" });

    expect(html).toContain("Student 01");
    expect(html).toContain("Student 02");
    // Three sections now: two students and the key page.
    expect(html.split('class="student-page').length - 1).toBe(3);

    // No name anywhere above the key page.
    const keyAt = html.indexOf("Teacher key — do not distribute");
    expect(keyAt).toBeGreaterThan(-1);
    const packet = html.slice(0, keyAt);
    expect(packet).not.toContain("Fixture, Ada");
    expect(packet).not.toContain("Sample, Ben");
    // Nor a student number.
    expect(packet).not.toContain(STUDENT.ps_id);

    // The key page carries the mapping, the print date, the count and the caveat.
    const key = html.slice(keyAt);
    expect(key).toContain("Fixture, Ada");
    expect(key).toContain("Sample, Ben");
    expect(key).toContain(SECTION);
    expect(key).toContain("2 handed-in attempts");
    expect(key).toContain("the labels can");

    // The work itself still prints — that is the point of the packet.
    expect(html).toContain("ADA-ESSAY-PROSE");
  });

  test("named mode has no key page at all", async () => {
    const { assessment } = await seedPacketScene();
    const html = await render(assessment.id, { section: SECTION });
    expect(html).not.toContain("Teacher key");
    expect(html).not.toContain("Student 01");
    expect(html.split('class="student-page').length - 1).toBe(2);
  });
});

describe("work packet — slice 2's toolbar", () => {
  test("the section select carries every handed-in section, the current one selected", async () => {
    const { assessment } = await seedPacketScene();
    const html = await render(assessment.id, { section: SECTION });
    expect(html).toContain('<select id="packet-section" name="section">');
    expect(html).toContain(`<option value="${SECTION}" selected="">`);
  });

  test("every item shows as a checked checkbox by default, labelled Qn + a stem excerpt", async () => {
    const { assessment, items: itemRows } = await seedPacketScene();
    const html = await render(assessment.id, { section: SECTION });
    for (const item of itemRows) {
      const label = `Q${item.position + 1} — `;
      expect(html).toContain(label);
    }
    // Every checklist checkbox is checked when ?items= is absent.
    const checklistBoxes = html.match(/<input type="checkbox" name="items"[^>]*>/g) ?? [];
    expect(checklistBoxes.length).toBe(itemRows.length);
    for (const box of checklistBoxes) expect(box).toContain('checked=""');
  });

  test("?items= checks only the named items in the checklist", async () => {
    const { assessment, items: itemRows } = await seedPacketScene();
    const html = await render(assessment.id, {
      section: SECTION,
      items: itemRows[1]!.id,
    });
    const essayBox = html.match(
      new RegExp(`<input type="checkbox" name="items"[^>]*value="${itemRows[1]!.id}"/>`),
    )?.[0];
    const otherBox = html.match(
      new RegExp(`<input type="checkbox" name="items"[^>]*value="${itemRows[0]!.id}"/>`),
    )?.[0];
    expect(essayBox).toContain('checked=""');
    expect(otherBox).not.toContain('checked=""');
  });

  test("Select all links to the same query with ?items= dropped", async () => {
    const { assessment, items: itemRows } = await seedPacketScene();
    const html = await render(assessment.id, {
      section: SECTION,
      items: itemRows[1]!.id,
      scores: "both",
    });
    const expectedQuery = new URLSearchParams({
      section: SECTION,
      questions: "1",
      scores: "both",
    }).toString();
    expect(html).toContain(
      `href="/dashboard/${assessment.id}/results/work?${expectedQuery.replace(/&/g, "&amp;")}">Select all</a>`,
    );
    // The narrowed item itself is absent from the link (no items= at all).
    const legendEnd = html.indexOf("</legend>");
    expect(html.slice(0, legendEnd)).not.toContain("items=");
  });

  test("the scores radio follows ?scores=, and the anonymous checkbox follows ?anon=", async () => {
    const { assessment } = await seedPacketScene();
    const html = await render(assessment.id, { section: SECTION, scores: "ai", anon: "1" });
    expect(html).toContain('<input type="radio" name="scores" checked="" value="ai"/>');
    expect(html).not.toContain('<input type="radio" name="scores" checked="" value="none"/>');
    expect(html).toContain('<input type="checkbox" name="anon" checked="" value="1"/>');
  });

  test("questions=0 renders the hidden field plus an UNCHECKED questions box (the last-value trick)", async () => {
    const { assessment } = await seedPacketScene();
    const html = await render(assessment.id, { section: SECTION, questions: "0" });
    expect(html).toContain('<input type="hidden" name="questions" value="0"/>');
    expect(html).toContain('<input type="checkbox" name="questions" value="1"/>');
    expect(html).not.toContain('<input type="checkbox" name="questions" value="1" checked=""/>');
  });

  test("questions on (the default) checks the questions box", async () => {
    const { assessment } = await seedPacketScene();
    const html = await render(assessment.id, { section: SECTION });
    expect(html).toContain('<input type="checkbox" name="questions" checked="" value="1"/>');
  });
});

describe("work packet — a set's stimulus, sources and pictures", () => {
  /**
   * One set with an introduction, two labelled sources and a hotspot picture,
   * shared by two questions — so the stimulus has to print ONCE, above the
   * first of them, and the image refs have to resolve owner-scoped.
   */
  async function seedSetScene() {
    const db = getDb();
    const [assessment] = await db
      .insert(assessments)
      .values({ owner_sub: OWNER, name: "Set Packet Fixture" })
      .returning();
    const a = assessment!;
    const [asset] = await db
      .insert(assets)
      .values({
        owner_sub: OWNER,
        content_type: "image/png",
        size_bytes: 12,
        sha256: "wp-set-fixture-sha",
        storage_provider: "local",
        storage_key: "wp/set-fixture.png",
      })
      .returning();
    const [set] = await db
      .insert(item_sets)
      .values({
        assessment_id: a.id,
        stimulus_text: "STIMULUS-LEAD read both sources",
        sources: [
          { label: "Source A", text: "SOURCE-A-BODY" },
          { label: "Source B", text: `SOURCE-B-BODY ![chart](asset:${asset!.id})` },
        ],
        layout: "side_by_side",
      })
      .returning();
    const itemRows = await db
      .insert(items)
      .values([
        {
          assessment_id: a.id,
          item_set_id: set!.id,
          position: 0,
          type: "essay",
          stem: "SET-Q1",
        },
        {
          assessment_id: a.id,
          item_set_id: set!.id,
          position: 1,
          type: "hotspot",
          stem: "SET-Q2",
          config: {
            image_asset_id: asset!.id,
            regions: [{ id: "r1", x: 0.1, y: 0.1, w: 0.2, h: 0.2 }],
          },
        },
      ])
      .returning();
    const [student] = await db
      .insert(students)
      .values({ owner_sub: OWNER, roster_ps_id: STUDENT.ps_id, name: "Fixture, Ada" })
      .returning();
    const [sitting] = await db
      .insert(test_sessions)
      .values({
        assessment_id: a.id,
        owner_sub: OWNER,
        owner_email: TEACHER_EMAIL,
        section_ps_id: "5001",
        code: "WP02TST",
        status: "closed",
        expires_at: new Date("2026-09-14T23:00:00Z"),
      })
      .returning();
    const [attempt] = await db
      .insert(attempts)
      .values({
        assessment_id: a.id,
        student_id: student!.id,
        test_session_id: sitting!.id,
        status: "submitted" as const,
        started_at: new Date("2026-09-14T16:00:00Z"),
        submitted_at: new Date("2026-09-14T17:00:00Z"),
      })
      .returning();
    await db.insert(responses).values([
      {
        attempt_id: attempt!.id,
        item_id: itemRows[0]!.id,
        response: { type: "essay", text: "SET-ESSAY-PROSE" },
      },
      {
        attempt_id: attempt!.id,
        item_id: itemRows[1]!.id,
        response: { type: "hotspot", region_ids: ["r1"] },
      },
    ]);
    return { assessment: a, items: itemRows, asset: asset! };
  }

  test("the stimulus and its sources print once, above the set's first question", async () => {
    const { assessment } = await seedSetScene();
    const html = await render(assessment.id, { section: SECTION });
    const body = packetBody(html);

    expect(body.split("STIMULUS-LEAD").length - 1).toBe(1);
    expect(body).toContain("Source A");
    expect(body).toContain("SOURCE-A-BODY");
    expect(body).toContain("Source B");
    // An image ref inside a source resolves owner-scoped, as in a stem.
    expect(body).toContain("<img");
    expect(body).not.toContain("image not found");
    // Above Q1, not between the two questions.
    expect(body.indexOf("STIMULUS-LEAD")).toBeLessThan(body.indexOf("SET-Q1"));
    // The hotspot's own picture, then the region it picked beneath it.
    expect(body).toContain("Picture for question 2");
    expect(body).toContain("Region r1");
  });

  test("?items= on the set's SECOND question still prints the stimulus above it", async () => {
    const { assessment, items: itemRows } = await seedSetScene();
    const html = await render(assessment.id, {
      section: SECTION,
      items: itemRows[1]!.id,
    });
    const body = packetBody(html);
    expect(body).toContain("STIMULUS-LEAD");
    expect(body).toContain("SET-Q2");
    expect(body).not.toContain("SET-Q1");
    // The checklist still lists Q1 by its stem, narrowed or not.
    expect(html).toContain("SET-Q1");
  });

  test("?questions=0 drops the stimulus with the stems", async () => {
    const { assessment } = await seedSetScene();
    const html = await render(assessment.id, { section: SECTION, questions: "0" });
    expect(html).not.toContain("STIMULUS-LEAD");
    expect(html).not.toContain("SOURCE-A-BODY");
    expect(html).toContain("SET-ESSAY-PROSE");
  });
});

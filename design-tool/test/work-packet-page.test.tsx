// Slice 1 of docs/student-work-export-design.md: the packet page rendered
// headless — one page per handed-in student, the checkbox glyph on EVERY
// choice, the teacher / AI score blocks, the anonymous labels and the tear-off
// key page, and the owner-only posture. The repo has no DOM harness, so the
// page is awaited and its element tree rendered, the same way
// reporting-print.test.tsx does it.
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { closeDb, getDb } from "../db/client";
import {
  assessments,
  assets,
  attempt_feedback,
  attempts,
  item_sets,
  items,
  response_feedback,
  responses,
  roster_sections,
  scores,
  students,
  test_sessions,
} from "../db/schema";
import { SESSION_COOKIE_NAME } from "../lib/auth/session";
import * as headersMod from "next/headers";
import * as sessionMod from "../lib/auth/session";
import { sectionLabel } from "../lib/roster/teacherRoster";
import { BIOLOGY_STUDENT, OTHER_STUDENT, STUDENT, TEACHER_EMAIL, clearRoster, seedRoster } from "./helpers/roster";
import { anonymousLabels } from "../lib/reporting/workPacket";

/** The label the section packet gives `id` among the section's handed-in attempts. */
function sectionLabelFor(id: string, handedInIds: string[]): string {
  return anonymousLabels(handedInIds).get(id) ?? "";
}

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
  search: Record<string, string | string[]> = {},
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
/**
 * Batch print slice 2: a toolbar checkbox by its name and value — whether it
 * is ticked and the label text beside it — or null when there is none.
 */
function box(
  html: string,
  name: string,
  value: string,
): { checked: boolean; text: string } | null {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(
    `<input type="checkbox" name="${name}"( checked="")? value="${escaped}"/> ([^<]*)</label>`,
  ).exec(html);
  return m ? { checked: m[1] !== undefined, text: m[2]! } : null;
}

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
        // Last edited at hand-in, before the AI scored it: FR D-10 drops an AI
        // row older than the answer's last edit (a pass-back's leftover).
        updated_at: new Date("2026-09-14T17:00:00Z"),
      },
      {
        attempt_id: adaAttempt!.id,
        item_id: itemRows[2]!.id,
        // Roadmap 4b-f (2026-09-14): typed as math, so the packet prints it
        // the way the client previewed it.
        response: { type: "short_text", text: "4^2" },
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
    // scores=teacher so the key beside a table cell is expected below (W-1).
    const html = await render(assessment.id, { section: SECTION, scores: "teacher" });

    expect(html).toContain("STEM-MC-MULTI");
    expect(html).toContain("STEM-MATCH");
    expect(html).toContain("Water → H2O");
    expect(html).toContain("1. Flower");
    expect(html).toContain("Region r1");
    expect(html).toContain("/upload");
    // The table grid, with the key beside the student's cell.
    expect(html).toContain("Mass");
    expect(html).toContain("expected 12");
    // Roadmap 4b-f: the short-text answer prints as KaTeX, not as `4^2`.
    expect(packetBody(html)).toContain('class="katex"');
    expect(packetBody(html)).not.toContain("4^2");
    // An item with no answer says so rather than printing an empty block.
    expect(html).toContain("No answer.");
  });

  // Roadmap 4b-f (2026-09-14, docs/math-entry-design.md §Follow-ups): the
  // packet prints a short-text answer as the math the student saw. Essays are
  // prose and stay prose.
  test("a short-text answer prints through KaTeX; an essay prints as prose", async () => {
    const { assessment } = await seedPacketScene();
    const body = packetBody(
      await render(assessment.id, { section: SECTION, scores: "teacher" }),
    );
    expect(body).toContain('class="katex"');
    expect(body).toContain("mord mathrm");
    expect(body).not.toContain("4^2");
    // The essay is still printed as text, untouched by the math renderer.
    expect(body).toContain("ADA-ESSAY-PROSE");
    expect(body).not.toContain("short-text-plain");
  });

  // W-1 (hand-run 2026-09-14): a mark against the key IS the key. A packet
  // printed without the teacher's side (none, ai) may leave the teacher's
  // hands, so ✓ / ✗ and the table's "expected" cells print only with
  // scores=teacher or scores=both.
  test("the key prints only with the teacher's side: no ✓ / ✗ / expected under none or ai", async () => {
    const { assessment } = await seedPacketScene();
    for (const scores of ["none", "ai"] as const) {
      const html = await render(assessment.id, { section: SECTION, scores });
      const body = packetBody(html);
      expect(body).not.toContain("✓");
      expect(body).not.toContain("✗");
      expect(body).not.toContain("expected 12");
    }
    for (const scores of ["teacher", "both"] as const) {
      const html = await render(assessment.id, { section: SECTION, scores });
      const body = packetBody(html);
      expect(body).toMatch(/[✓✗]/);
      expect(body).toContain("expected 12");
    }
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
    // Scoped to the packet: the toolbar's student picker names them first.
    const body = packetBody(html);
    const adaPage = body.slice(body.indexOf("Fixture, Ada"), body.indexOf("Sample, Ben"));
    expect(adaPage).toContain('☑</span><span class="choice-text">CHOICE-COPPER</span>');
    expect(adaPage).toContain('☐</span><span class="choice-text">CHOICE-NEON</span>');
    expect(adaPage).toContain('☐</span><span class="choice-text">CHOICE-IRON</span>');
  });

  test("WP-2: a choice prints through the stem renderer — KaTeX and the owner's picture, never raw", async () => {
    const { assessment } = await seedPacketScene();
    const db = getDb();
    const [asset] = await db
      .insert(assets)
      .values({
        owner_sub: OWNER,
        content_type: "image/png",
        size_bytes: 4,
        sha256: "wp2-fixture",
        storage_provider: "local-fs",
        storage_key: "wp2/fixture.png",
        original_filename: "fixture.png",
      })
      .returning();
    await db
      .update(items)
      .set({
        choices: [
          { id: "s1", text: "CHOICE-YES $x^2$" },
          { id: "s2", text: `![CHOICE-PIC](asset:${asset!.id})` },
        ],
      })
      .where(and(eq(items.assessment_id, assessment.id), eq(items.position, 3)));
    const body = packetBody(await render(assessment.id, { section: SECTION }));
    expect(body).not.toContain("$x^2$");
    expect(body).toContain('class="katex"');
    expect(body).not.toContain("](asset:");
    expect(body).toContain(`/api/assessments/${assessment.id}/assets/${asset!.id}`);
    expect(body).toContain('alt="CHOICE-PIC"');
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

// RT slice 2 (docs/rich-text-essay-design.md): a formatted essay prints with
// its formatting through the one sanitising renderer; D-10 double spacing is
// a toolbar option (`spacing=double`), off by default, on essays only.
describe("work packet — formatted essays and double spacing (RT)", () => {
  async function formatBens(benAttemptId: string, essayItemId: string) {
    await getDb()
      .update(responses)
      .set({
        response: {
          type: "essay",
          text: "BEN-BOLD",
          html: '<p data-indent="first"><strong>BEN-BOLD</strong><script>alert(1)</script></p><ul><li>BEN-ITEM</li></ul>',
        },
      })
      .where(sql`${responses.attempt_id} = ${benAttemptId} and ${responses.item_id} = ${essayItemId}`);
  }

  test("a formatted essay prints its formatting, re-cleaned; a plain essay prints as before", async () => {
    const { assessment, items: itemRows, benAttempt } = await seedPacketScene();
    await formatBens(benAttempt.id, itemRows[1]!.id);
    const body = packetBody(await render(assessment.id, { section: SECTION }));
    expect(body).toContain(
      '<div class="essay-rich"><p data-indent="first"><strong>BEN-BOLD</strong></p><ul><li>BEN-ITEM</li></ul></div>',
    );
    expect(body).not.toContain("alert(1)");
    // Ada's plain essay: escaped text, its newline kept for pre-line.
    expect(body).toContain('<div class="answer-text">ADA-ESSAY-PROSE line one\nline two</div>');
  });

  test("spacing=double double-spaces every essay answer and nothing else; off by default", async () => {
    const { assessment, items: itemRows, benAttempt } = await seedPacketScene();
    await formatBens(benAttempt.id, itemRows[1]!.id);
    const single = packetBody(await render(assessment.id, { section: SECTION }));
    expect(single).not.toContain("answer-double");

    const html = await render(assessment.id, { section: SECTION, spacing: "double" });
    const body = packetBody(html);
    // Both essays (plain and formatted) carry the class; the short text does not.
    expect(body.match(/class="answer-text answer-double"/g)?.length).toBe(2);
    expect(html).toContain(".packet .answer-double { line-height: 2; }");
    expect(body).toMatch(/<p class="answer-text"><span class="katex/);
  });

  test("the toolbar's Double-space box follows ?spacing=, and Select all keeps it", async () => {
    const { assessment } = await seedPacketScene();
    const off = await render(assessment.id, { section: SECTION });
    expect(off).toContain('name="spacing" value="double"/>');
    const on = await render(assessment.id, { section: SECTION, spacing: "double" });
    expect(on).toContain('name="spacing" checked="" value="double"/>');
    expect(on).toContain("Double-space essays");
    expect(on).toMatch(/href="[^"]*spacing=double[^"]*">Select all/);
  });
});

// U-23 (beta teachers, 2026-10-13): `answers=0` prints the questions and the
// score / feedback blocks and leaves out what the student wrote or chose —
// a feedback sheet to hand back. Ignored with scores=none (decision 1.5).
describe("work packet — feedback without the answer (U-23)", () => {
  test("answers=0 keeps stems, choices and feedback; drops every answer", async () => {
    const { assessment } = await seedPacketScene();
    const body = packetBody(
      await render(assessment.id, {
        section: SECTION,
        teacher_score: "1",
        ai_score: "1",
        ai_feedback: "1",
        answers: "0",
      }),
    );
    // The question and the feedback stay.
    expect(body).toContain("STEM-ESSAY");
    expect(body).toContain("STEM-MC-MULTI");
    expect(body).toContain("CHOICE-NEON");
    expect(body).toContain("Teacher score");
    expect(body).toContain("AI-OVERALL");
    // Nothing the student wrote or chose: no essay, no ticks, no drawing, no
    // table grid, no short-text math, no "No answer." placeholder.
    expect(body).not.toContain("ADA-ESSAY-PROSE");
    expect(body).not.toContain("BEN-ESSAY-PROSE");
    expect(body).not.toContain("☑");
    expect(body).not.toContain("☐");
    expect(body).not.toContain("/upload");
    expect(body).not.toContain("expected 12");
    expect(body).not.toContain('class="katex"');
    expect(body).not.toContain("No answer.");
    expect(body).not.toContain("answer-text");
  });

  test("answers=0 with no box ticked prints the answers and says why", async () => {
    const { assessment } = await seedPacketScene();
    const html = await render(assessment.id, { section: SECTION, answers: "0" });
    expect(packetBody(html)).toContain("ADA-ESSAY-PROSE");
    expect(html).toContain("Leaving out answers needs a score or feedback box");
  });

  test("the toolbar box follows ?answers=, and Select all keeps it", async () => {
    const { assessment } = await seedPacketScene();
    const off = await render(assessment.id, { section: SECTION });
    expect(off).toContain('name="answers" value="0"/>');
    expect(off).toContain("Leave out answers (scores and feedback only)");
    expect(off).not.toContain("Leaving out answers needs a score or feedback box");
    const on = await render(assessment.id, { section: SECTION, scores: "ai", answers: "0" });
    expect(on).toContain('name="answers" checked="" value="0"/>');
    expect(on).toMatch(/href="[^"]*answers=0[^"]*">Select all/);
  });
});

describe("work packet — scores", () => {
  // FR D-16: the teacher copy keeps the pre-FR blocks — the AI proposal, its
  // heading, the placeholders. The AI's comments come through AI feedback.
  test("teacher copy prints the teacher block and the AI proposal, never the research row", async () => {
    const { assessment } = await seedPacketScene();
    const html = packetBody(
      await render(assessment.id, {
        section: SECTION,
        teacher_copy: "1",
        teacher_score: "1",
        ai_score: "1",
        ai_feedback: "1",
      }),
    );

    expect(html).toContain("Teacher score");
    expect(html).toContain("3 / 4");
    // R-1: a teacher's row's text is never "Teacher feedback" — that comes
    // only from response_feedback (the fixture's human text is synthetic).
    expect(html).not.toContain("HUMAN-WHY");
    expect(html).not.toContain("HUMAN-OVERALL");
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

  test("a legacy scores=both URL is the student copy with both score boxes", async () => {
    const { assessment } = await seedPacketScene();
    const html = await render(assessment.id, { section: SECTION, scores: "both" });
    const body = packetBody(html);
    expect(body).toContain("Teacher score");
    expect(body).toContain("3 / 4");
    expect(body).not.toContain("AI proposal");
    expect(body).not.toContain("2 / 4");
    expect(body).not.toContain("No AI score");
    expect(body).not.toContain("No teacher score");
    // D-13: the MC's answer-key score is a plain "Score".
    expect(body).toContain("<h3>Score</h3>");
    expect(body).not.toContain("Auto score (your answer key)");
    // The mapping is the two score boxes only.
    expect(body).not.toContain("AI feedback");
    expect(box(html, "teacher_score", "1")?.checked).toBe(true);
    expect(box(html, "ai_score", "1")?.checked).toBe(true);
    expect(box(html, "ai_feedback", "1")?.checked).toBe(false);
  });

  test("scores=none is the default: no score block anywhere", async () => {
    const { assessment } = await seedPacketScene();
    // The packet itself: the toolbar always carries the box labels.
    const html = packetBody(await render(assessment.id, { section: SECTION }));
    expect(html).not.toContain("Teacher score");
    expect(html).not.toContain("AI proposal");
    expect(html).not.toContain("No teacher score");
    expect(html).not.toContain("score-block");
  });

  test("scores=teacher and scores=ai each drop the other side", async () => {
    const { assessment } = await seedPacketScene();
    const teacherOnly = packetBody(
      await render(assessment.id, {
        section: SECTION,
        scores: "teacher",
      }),
    );
    expect(teacherOnly).toContain("Teacher score");
    expect(teacherOnly).not.toContain("AI proposal");
    expect(teacherOnly).not.toContain("AI-OVERALL");

    // Student copy: Ada's AI score was overridden, so it prints nothing (D-3).
    const aiOnly = packetBody(await render(assessment.id, { section: SECTION, scores: "ai" }));
    expect(aiOnly).not.toContain("AI proposal");
    expect(aiOnly).not.toContain("2 / 4");
    expect(aiOnly).not.toContain("Teacher score");
    expect(aiOnly).not.toContain("HUMAN-OVERALL");
    // D-16: only the teacher copy marks the printed page as not for students.
    expect(aiOnly).not.toContain("Teacher copy");

    const aiTeacherCopy = packetBody(
      await render(assessment.id, { section: SECTION, scores: "ai", teacher_copy: "1" }),
    );
    expect(aiTeacherCopy).toContain("AI proposal");
    expect(aiTeacherCopy).toContain("2 / 4");
    expect(aiTeacherCopy).not.toContain("Teacher score");
    expect(aiTeacherCopy).toContain("Teacher copy — not for students");
    expect(aiTeacherCopy).toContain("· Teacher copy</p>");
  });

  test("an unreadable scores value falls back to none instead of erroring", async () => {
    const { assessment } = await seedPacketScene();
    const html = packetBody(await render(assessment.id, { section: SECTION, scores: "everything" }));
    expect(html).not.toContain("Teacher score");
    expect(html).toContain("ADA-ESSAY-PROSE");
  });
});

// FR slice 4 (docs/feedback-release-design.md): the packet's boxes. Ada's
// essay is the override case (human final 3/4, AI proposal 2/4); Ben's gets an
// approved AI final here — the approve route's shape: a NEW final row with the
// proposal's rationale, the proposal left in place. Ada also gets the
// teacher's own comments and a score-change reason that must never print.
describe("work packet — feedback release boxes (FR)", () => {
  async function seedFeedbackScene() {
    const scene = await seedPacketScene();
    const db = getDb();
    const essay = scene.items[1]!;
    const [adaEssay] = await db
      .select()
      .from(responses)
      .where(and(eq(responses.attempt_id, scene.adaAttempt.id), eq(responses.item_id, essay.id)));
    const [benEssay] = await db
      .select()
      .from(responses)
      .where(and(eq(responses.attempt_id, scene.benAttempt.id), eq(responses.item_id, essay.id)));
    await db
      .update(responses)
      .set({ updated_at: new Date("2026-09-14T17:05:00Z") })
      .where(eq(responses.id, benEssay!.id));
    const benRationale = {
      criterion_scores: [{ criterion_id: "focus", level_id: "hi", points: 4, rationale: "BEN-AI-WHY" }],
      overall_rationale: "BEN-AI-OVERALL",
    };
    await db.insert(scores).values([
      {
        response_id: benEssay!.id,
        method: "ai",
        points: 4,
        max_points: 4,
        scorer: "bedrock",
        status: "proposed",
        created_at: new Date("2026-09-14T18:00:00Z"),
        rationale: benRationale,
      },
      {
        response_id: benEssay!.id,
        method: "ai",
        points: 4,
        max_points: 4,
        scorer: "bedrock",
        status: "final",
        reviewed_by_sub: OWNER,
        created_at: new Date("2026-09-14T18:30:00Z"),
        rationale: benRationale,
      },
    ]);
    // A change of score: the reason lives in rationale.note (R-1) and must
    // never print, under any box, in either copy.
    await db
      .update(scores)
      .set({
        rationale: {
          criterion_scores: [{ criterion_id: "focus", level_id: "hi", points: 3, rationale: "" }],
          note: "CHANGE-REASON",
        },
      })
      .where(and(eq(scores.response_id, adaEssay!.id), eq(scores.method, "human")));
    await db.insert(response_feedback).values({
      response_id: adaEssay!.id,
      author_sub: OWNER,
      text: "ADA-TEACHER-NOTE\nsecond line",
    });
    await db.insert(attempt_feedback).values({
      attempt_id: scene.adaAttempt.id,
      author_sub: OWNER,
      text: "ADA-OVERALL-NOTE",
    });
    return scene;
  }

  /** One student's printed page, by name. */
  function pageOf(html: string, name: string): string {
    const body = packetBody(html);
    const start = body.indexOf(`aria-label="Work for ${name}"`);
    const next = body.indexOf('class="student-page', start + 1);
    return body.slice(start, next === -1 ? undefined : next);
  }

  test("student copy: an overridden AI score never prints, its feedback does, labelled (D-3, D-10)", async () => {
    const { assessment } = await seedFeedbackScene();
    const html = await render(assessment.id, {
      section: SECTION,
      teacher_score: "1",
      ai_score: "1",
      ai_feedback: "1",
    });
    const ada = pageOf(html, "Fixture, Ada");
    expect(ada).toContain("<h3>Teacher score</h3>");
    expect(ada).toContain("3 / 4");
    expect(ada).not.toContain("2 / 4");
    expect(ada).not.toContain("AI proposal");
    expect(ada).not.toContain("AI score");
    expect(ada).not.toContain("No AI score");
    expect(ada).toContain("<h3>AI feedback</h3>");
    expect(ada).toContain("AI-OVERALL");
    // R-2 off: the AI's per-criterion comment as a labelled list.
    expect(ada).toContain("<strong>CRITERION-FOCUS:</strong>");
    expect(ada).toContain("AI-WHY");
    expect(ada).not.toContain("RESEARCH");
    // No unlabelled feedback anywhere (D-1): the old ScoreBlock's "Why"
    // column and loose overall line are gone.
    expect(ada).not.toContain("<th>Why</th>");
  });

  test("an approved AI final prints as AI score, and its comments once (D-17, no double print)", async () => {
    const { assessment } = await seedFeedbackScene();
    const html = await render(assessment.id, { section: SECTION, ai_score: "1", ai_feedback: "1" });
    const ben = pageOf(html, "Sample, Ben");
    expect(ben).toContain("<h3>AI score</h3>");
    expect(ben).toContain("4 / 4");
    expect(ben).not.toContain("AI score (approved)");
    expect(ben.split("BEN-AI-OVERALL").length - 1).toBe(1);
    expect(ben.split("BEN-AI-WHY").length - 1).toBe(1);
    // AI feedback alone: the comments without the score (the beta teacher's ask).
    const fbOnly = pageOf(
      await render(assessment.id, { section: SECTION, ai_feedback: "1" }),
      "Sample, Ben",
    );
    expect(fbOnly).toContain("BEN-AI-OVERALL");
    expect(fbOnly).not.toContain("4 / 4");
    expect(fbOnly).not.toContain("AI score");
  });

  test("a short answer's AI comments: left out of the student copy, kept in the teacher copy (PR #157 review)", async () => {
    const { assessment, adaAttempt, items: sceneItems } = await seedFeedbackScene();
    const db = getDb();
    const [adaShort] = await db
      .select()
      .from(responses)
      .where(and(eq(responses.attempt_id, adaAttempt.id), eq(responses.item_id, sceneItems[2]!.id)));
    await db.insert(scores).values({
      response_id: adaShort!.id,
      method: "ai",
      points: 0,
      max_points: 1,
      scorer: "bedrock",
      status: "final",
      rationale: { overall_rationale: "SA-KEY-LEAK the answer is Olympia" },
    });
    const student = pageOf(
      await render(assessment.id, { section: SECTION, ai_score: "1", ai_feedback: "1" }),
      "Fixture, Ada",
    );
    expect(student).not.toContain("SA-KEY-LEAK");
    // The essay's AI feedback on the same page still prints.
    expect(student).toContain("AI-OVERALL");
    const teacher = pageOf(
      await render(assessment.id, { section: SECTION, ai_score: "1", ai_feedback: "1", teacher_copy: "1" }),
      "Fixture, Ada",
    );
    expect(teacher).toContain("SA-KEY-LEAK");
  });

  test("teacher feedback per question and overall, labelled; nothing without the box (D-4)", async () => {
    const { assessment } = await seedFeedbackScene();
    const off = packetBody(await render(assessment.id, { section: SECTION, teacher_score: "1" }));
    expect(off).not.toContain("ADA-TEACHER-NOTE");
    expect(off).not.toContain("ADA-OVERALL-NOTE");
    expect(off).not.toContain("Teacher feedback");

    const html = await render(assessment.id, { section: SECTION, teacher_feedback: "1" });
    const ada = pageOf(html, "Fixture, Ada");
    expect(ada).toContain("<h3>Teacher feedback</h3>");
    // Plain text with its line break kept by pre-line, never as HTML.
    expect(ada).toContain('<p class="feedback-text">ADA-TEACHER-NOTE\nsecond line</p>');
    // The overall comment once, above the first question.
    expect(ada.split("ADA-OVERALL-NOTE").length - 1).toBe(1);
    expect(ada.indexOf("ADA-OVERALL-NOTE")).toBeLessThan(ada.indexOf("Q1"));
    expect(ada.indexOf("ADA-TEACHER-NOTE")).toBeGreaterThan(ada.indexOf("STEM-ESSAY"));
    // Ben has no comment: no empty label.
    expect(pageOf(html, "Sample, Ben")).not.toContain("Teacher feedback");
  });

  test("a score-change reason never prints, in either copy, under every box (R-1)", async () => {
    const { assessment } = await seedFeedbackScene();
    const all = {
      section: SECTION,
      teacher_score: "1",
      ai_score: "1",
      teacher_feedback: "1",
      ai_feedback: "1",
      rubric_table: "1",
    };
    for (const search of [all, { ...all, teacher_copy: "1" }]) {
      const html = await render(assessment.id, search);
      expect(html).not.toContain("CHANGE-REASON");
      expect(packetBody(html)).toContain("ADA-TEACHER-NOTE");
    }
  });

  test("rubric table (R-2): levels from the final only, points with a score, AI comments as a column", async () => {
    const { assessment } = await seedFeedbackScene();
    const html = await render(assessment.id, {
      section: SECTION,
      teacher_score: "1",
      ai_feedback: "1",
      rubric_table: "1",
    });
    const ada = pageOf(html, "Fixture, Ada");
    expect(ada).toContain("<th>Criterion</th><th>Level</th><th>Points</th><th>AI feedback</th>");
    expect(ada).toContain("<td>CRITERION-FOCUS</td><td>Strong</td><td>3</td><td>AI-WHY</td>");
    // The comment sits in the table, not repeated as a list.
    expect(ada).not.toContain("<strong>CRITERION-FOCUS:</strong>");

    // D-3 through the table: with only the AI score ticked on an overridden
    // response, the AI's level ("Weak") must not leak as the table's level.
    const aiOnly = pageOf(
      await render(assessment.id, { section: SECTION, ai_score: "1", rubric_table: "1" }),
      "Fixture, Ada",
    );
    expect(aiOnly).not.toContain("Weak");
    expect(aiOnly).not.toContain("<th>Points</th>");

    // Off: no table at all.
    const off = pageOf(
      await render(assessment.id, { section: SECTION, teacher_score: "1", ai_feedback: "1" }),
      "Fixture, Ada",
    );
    expect(off).not.toContain("<th>Level</th>");
  });

  test("answers=0 with AI feedback alone is a feedback sheet (D-11)", async () => {
    const { assessment } = await seedFeedbackScene();
    const html = await render(assessment.id, { section: SECTION, ai_feedback: "1", answers: "0" });
    const body = packetBody(html);
    expect(body).not.toContain("ADA-ESSAY-PROSE");
    expect(body).toContain("AI-OVERALL");
    expect(html).not.toContain("Leaving out answers needs");
  });

  test("teacher copy keeps the proposal headings beside the labelled feedback (D-16)", async () => {
    const { assessment } = await seedFeedbackScene();
    const html = await render(assessment.id, {
      section: SECTION,
      teacher_copy: "1",
      ai_score: "1",
      teacher_feedback: "1",
    });
    expect(pageOf(html, "Fixture, Ada")).toContain("AI proposal");
    expect(pageOf(html, "Fixture, Ada")).toContain("ADA-TEACHER-NOTE");
    expect(pageOf(html, "Sample, Ben")).toContain("AI score (approved)");
    expect(box(html, "teacher_copy", "1")?.checked).toBe(true);
    expect(html).toMatch(/href="[^"]*teacher_copy=1[^"]*">Select all/);
  });

  test("teacher copy + rubric table: the proposal's own levels sit under AI proposal, the teacher's under theirs (D-16)", async () => {
    const { assessment } = await seedFeedbackScene();
    /** Each score block on a page, by heading → its inner HTML (no div nests inside one). */
    const scoreBlocks = (page: string): Map<string, string> => {
      const out = new Map<string, string>();
      for (const part of page.split('<div class="score-block">').slice(1)) {
        const inner = part.slice(0, part.indexOf("</div>"));
        out.set(/<h3>([^<]*)<\/h3>/.exec(inner)![1]!, inner);
      }
      return out;
    };

    // AI score alone on Ada's overridden essay: the proposal's level, never the teacher's.
    const aiOnly = pageOf(
      await render(assessment.id, { section: SECTION, teacher_copy: "1", ai_score: "1", rubric_table: "1" }),
      "Fixture, Ada",
    );
    const proposal = scoreBlocks(aiOnly).get("AI proposal")!;
    expect(proposal).toContain("2 / 4");
    expect(proposal).toContain("<td>CRITERION-FOCUS</td><td>Weak</td><td>2</td>");
    expect(aiOnly).not.toContain("Strong");
    // The builder's final-only table is not printed in the teacher copy.
    expect(aiOnly.split("<th>Level</th>").length - 1).toBe(1);

    // Both scores and AI feedback: each block its own levels; no "Why" column
    // (D-1) — the AI's comment prints once, as AI feedback's labelled list.
    const both = pageOf(
      await render(assessment.id, {
        section: SECTION,
        teacher_copy: "1",
        teacher_score: "1",
        ai_score: "1",
        ai_feedback: "1",
        rubric_table: "1",
      }),
      "Fixture, Ada",
    );
    const blocks = scoreBlocks(both);
    expect(blocks.get("Teacher score")).toContain("<td>CRITERION-FOCUS</td><td>Strong</td><td>3</td>");
    expect(blocks.get("Teacher score")).not.toContain("Weak");
    expect(blocks.get("AI proposal")).toContain("<td>CRITERION-FOCUS</td><td>Weak</td><td>2</td>");
    expect(blocks.get("AI proposal")).not.toContain("Strong");
    expect(both).not.toContain("<th>Why</th>");
    expect(both).not.toContain("<th>AI feedback</th>");
    expect(both.split("AI-WHY").length - 1).toBe(1);
    expect(both).toContain("<strong>CRITERION-FOCUS:</strong>");

    // Box off: no levels in the teacher copy (R-2).
    const off = pageOf(
      await render(assessment.id, { section: SECTION, teacher_copy: "1", ai_score: "1" }),
      "Fixture, Ada",
    );
    expect(off).toContain("AI proposal");
    expect(off).not.toContain("<th>Level</th>");
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
    // Nor a student number. UUIDs on the page (upload links) are removed
    // first: a random one can hold the digits ("…3810010f0feb" failed ci on
    // 2026-10-23), which is not the number leaking.
    const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
    expect(packet.replace(UUID, "")).not.toContain(STUDENT.ps_id);

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
  // Batch print slice 2: sections are checkboxes now, one per section with
  // handed-in work, the URL's ticked.
  test("the section checkboxes carry every handed-in section, the current one ticked", async () => {
    const { assessment } = await seedPacketScene();
    const html = await render(assessment.id, { section: SECTION });
    expect(html).not.toContain('id="packet-section"');
    expect(box(html, "section", SECTION)).toEqual({ checked: true, text: `${SECTION} (2 handed in)` });
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
      teacher_copy: "1",
    });
    // FR slice 4: rebuilt as the boxes, never the legacy scores=.
    const expectedQuery = new URLSearchParams({
      section: SECTION,
      questions: "1",
      teacher_score: "1",
      ai_score: "1",
      teacher_copy: "1",
    }).toString();
    expect(html).toContain(
      `href="/dashboard/${assessment.id}/results/work?${expectedQuery.replace(/&/g, "&amp;")}">Select all</a>`,
    );
    // The narrowed item itself is absent from the link (no items= at all).
    const legendEnd = html.indexOf("</legend>");
    expect(html.slice(0, legendEnd)).not.toContain("items=");
  });

  test("the score and feedback boxes follow the URL, and the anonymous checkbox follows ?anon=", async () => {
    const { assessment } = await seedPacketScene();
    const html = await render(assessment.id, {
      section: SECTION,
      ai_score: "1",
      teacher_feedback: "1",
      anon: "1",
    });
    expect(html).not.toContain('name="scores"');
    // FR D-7: the Doc dialog's labels, in its order.
    expect(box(html, "teacher_score", "1")).toEqual({ checked: false, text: "Teacher score" });
    expect(box(html, "ai_score", "1")).toEqual({ checked: true, text: "AI score" });
    expect(box(html, "teacher_feedback", "1")).toEqual({ checked: true, text: "Teacher feedback" });
    expect(box(html, "ai_feedback", "1")).toEqual({ checked: false, text: "AI feedback" });
    expect(box(html, "rubric_table", "1")).toEqual({ checked: false, text: "Rubric table" });
    expect(box(html, "teacher_copy", "1")?.checked).toBe(false);
    const order = ["teacher_score", "ai_score", "teacher_feedback", "ai_feedback", "rubric_table"].map(
      (k) => html.indexOf(`name="${k}"`),
    );
    expect([...order].sort((a, b) => a - b)).toEqual(order);
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

// A pilot teacher, 2026-09-23: "either print a whole class set of papers, OR
// just one kid's paper" — `?attempt=` prints one student, handed in or not.
describe("work packet — one student's work (?attempt=)", () => {
  /** The packet scene plus Cal, still mid-test in the same sitting (so his
   * section resolves the same), with one saved essay answer. */
  async function seedWithInProgress() {
    const scene = await seedPacketScene();
    const db = getDb();
    const [adaRow] = await db
      .select({ test_session_id: attempts.test_session_id })
      .from(attempts)
      .where(eq(attempts.id, scene.adaAttempt.id));
    const [cal] = await db
      .insert(students)
      .values({ owner_sub: OWNER, name: "Draft, Cal" })
      .returning();
    const [calAttempt] = await db
      .insert(attempts)
      .values({
        assessment_id: scene.assessment.id,
        student_id: cal!.id,
        test_session_id: adaRow!.test_session_id,
        status: "in_progress" as const,
        started_at: new Date("2026-09-14T16:10:00Z"),
      })
      .returning();
    await db.insert(responses).values({
      attempt_id: calAttempt!.id,
      item_id: scene.items[1]!.id,
      response: { type: "essay", text: "CAL-ESSAY-SO-FAR" },
    });
    return { ...scene, calAttempt: calAttempt! };
  }

  async function expect404(id: string, search: Record<string, string>) {
    let digest = "";
    try {
      await render(id, search);
      throw new Error("expected notFound()");
    } catch (err) {
      digest = String((err as { digest?: string }).digest ?? "");
    }
    expect(digest).toContain("404");
  }

  test("a handed-in attempt prints that one student's page and nobody else's", async () => {
    const { assessment, adaAttempt } = await seedWithInProgress();
    const html = await render(assessment.id, { attempt: adaAttempt.id });
    const body = packetBody(html);

    expect(body.split('class="student-page').length - 1).toBe(1);
    expect(body).toContain("Fixture, Ada");
    expect(body).toContain("ADA-ESSAY-PROSE");
    expect(body).toContain("Handed in");
    expect(body).not.toContain("Sample, Ben");
    expect(body).not.toContain("BEN-ESSAY-PROSE");
    expect(body).not.toContain("CAL-ESSAY-SO-FAR");
    // No section needed, and the strip speaks of one student, not a class.
    expect(html).not.toContain("One packet per class: pick a section.");
    expect(html).toContain("One student&#x27;s work — handed in");
    expect(html).not.toContain("students in");
  });

  test("an in-progress attempt prints with its saved answers and the marker on the page", async () => {
    const { assessment, calAttempt } = await seedWithInProgress();
    const html = await render(assessment.id, { attempt: calAttempt.id });
    const body = packetBody(html);

    expect(body.split('class="student-page').length - 1).toBe(1);
    expect(body).toContain("Draft, Cal");
    expect(body).toContain("CAL-ESSAY-SO-FAR");
    // The marker is inside the printed packet, not only on the screen strip.
    expect(body).toContain("In progress — not handed in");
    expect(body).not.toContain("Handed in ");
    expect(html).toContain("One student&#x27;s work — in progress, not handed in");
    // Items he has not reached say so.
    expect(body).toContain("No answer.");
  });

  test("the section packet still excludes the in-progress attempt", async () => {
    const { assessment } = await seedWithInProgress();
    const html = await render(assessment.id, { section: SECTION });
    const body = packetBody(html);
    expect(body.split('class="student-page').length - 1).toBe(2);
    expect(body).not.toContain("Draft, Cal");
    expect(body).not.toContain("CAL-ESSAY-SO-FAR");
    expect(body).not.toContain("In progress");
    expect(html).toContain(`2 of 2 students in ${SECTION} handed in`);
    // The chooser counts handed-in work only, too.
    const chooser = await render(assessment.id);
    expect(chooser).toContain("2 handed in");
  });

  test("an attempt at another assessment, or no attempt at all, is notFound()", async () => {
    const { assessment, calAttempt } = await seedWithInProgress();
    const [other] = await getDb()
      .insert(assessments)
      .values({ owner_sub: OWNER, name: "Other Fixture" })
      .returning();
    await expect404(other!.id, { attempt: calAttempt.id });
    await expect404(assessment.id, { attempt: "99999999-9999-4999-8999-999999999999" });
  });

  test("another teacher cannot print one student either", async () => {
    const { assessment, adaAttempt } = await seedWithInProgress();
    principal = { sub: OTHER_TEACHER, role: "staff", email: "teacher.two@psd401.net" };
    await expect404(assessment.id, { attempt: adaAttempt.id });
  });

  test("the other options still apply: questions=0, items, scores", async () => {
    const { assessment, adaAttempt, items: itemRows } = await seedWithInProgress();
    const html = await render(assessment.id, {
      attempt: adaAttempt.id,
      items: itemRows[1]!.id,
      questions: "0",
      scores: "teacher",
    });
    const body = packetBody(html);
    expect(body).toContain("ADA-ESSAY-PROSE");
    expect(body).not.toContain("STEM-ESSAY");
    expect(body).not.toContain("CHOICE-COPPER");
    expect(body).toContain("Teacher score");
  });

  test("anonymous with one student: a label, and a key page for that one print", async () => {
    const { assessment, adaAttempt, benAttempt } = await seedWithInProgress();
    const html = await render(assessment.id, { attempt: adaAttempt.id, anon: "1" });
    const keyAt = html.indexOf("Teacher key — do not distribute");
    expect(keyAt).toBeGreaterThan(-1);
    const packet = packetBody(html.slice(0, keyAt));
    expect(packet).toContain(sectionLabelFor(adaAttempt.id, [adaAttempt.id, benAttempt.id]));
    expect(packet).not.toContain("Fixture, Ada");
    const key = html.slice(keyAt);
    expect(key).toContain("Fixture, Ada");
    expect(key).toContain("one student&#x27;s work");
    expect(key).not.toContain("the labels can");
  });

  // James, 2026-09-23 (22.2): a single anonymous print keeps the section
  // packet's number, whichever student it is; in progress = "In progress n".
  test("anonymous single prints reuse the section packet's labels", async () => {
    const { assessment, adaAttempt, benAttempt, calAttempt } = await seedWithInProgress();
    const handedIn = [adaAttempt.id, benAttempt.id];
    for (const id of handedIn) {
      const html = await render(assessment.id, { attempt: id, anon: "1" });
      const keyAt = html.indexOf("Teacher key — do not distribute");
      const packet = packetBody(html.slice(0, keyAt));
      expect(packet).toContain(`<h2>${sectionLabelFor(id, handedIn)}</h2>`);
    }
    const html = await render(assessment.id, { attempt: calAttempt.id, anon: "1" });
    const keyAt = html.indexOf("Teacher key — do not distribute");
    expect(packetBody(html.slice(0, keyAt))).toContain("<h2>In progress 1</h2>");
  });

  test("with a section the student is not in, the section packet wins", async () => {
    const { assessment, adaAttempt } = await seedWithInProgress();
    const html = await render(assessment.id, {
      section: "Nonexistent · 9",
      attempt: adaAttempt.id,
    });
    expect(packetBody(html)).not.toContain("ADA-ESSAY-PROSE");
    expect(html).toContain("has handed this in yet");
  });

  test("the toolbar's student boxes list the section's students, in progress marked, none ticked by default", async () => {
    const { assessment, adaAttempt, benAttempt, calAttempt } = await seedWithInProgress();
    const html = await render(assessment.id, { section: SECTION });
    expect(html).not.toContain('id="packet-attempt"');
    expect(html).toContain("none ticked = everyone in the sections above");
    expect(box(html, "attempt", adaAttempt.id)).toEqual({ checked: false, text: "Fixture, Ada" });
    expect(box(html, "attempt", benAttempt.id)).toEqual({ checked: false, text: "Sample, Ben" });
    expect(box(html, "attempt", calAttempt.id)).toEqual({
      checked: false,
      text: "Draft, Cal (in progress)",
    });
  });

  test("anonymous mode's student boxes carry labels, never a name (D-1)", async () => {
    const { assessment, adaAttempt, benAttempt, calAttempt } = await seedWithInProgress();
    const html = await render(assessment.id, { section: SECTION, anon: "1" });
    const picker = html.slice(
      html.indexOf('class="toolbar-students"'),
      html.indexOf("</fieldset>", html.indexOf('class="toolbar-students"')),
    );
    expect([box(picker, "attempt", adaAttempt.id)!.text, box(picker, "attempt", benAttempt.id)!.text].sort()).toEqual([
      "Student 01",
      "Student 02",
    ]);
    expect(box(picker, "attempt", calAttempt.id)!.text).toBe("In progress 1");
    expect(picker).not.toContain("Fixture, Ada");
    expect(picker).not.toContain("Draft, Cal");
  });

  test("in single mode the student's box and their section's box are ticked", async () => {
    const { assessment, calAttempt } = await seedWithInProgress();
    const html = await render(assessment.id, { attempt: calAttempt.id });
    expect(box(html, "attempt", calAttempt.id)).toEqual({
      checked: true,
      text: "Draft, Cal (in progress)",
    });
    expect(box(html, "section", SECTION)!.checked).toBe(true);
    // "Select all" keeps the one student.
    expect(html).toContain(`attempt=${calAttempt.id}`);
  });
});

// FB slice 3 (docs/fill-in-blank-design.md): a fill-in-the-blank prints as
// the sentence with Ada's answers in place (a dropdown as its option text);
// ✓ / ✗ and "expected" only with the teacher's side (W-1); an answers-only
// packet prints "Blank n: …" lines.
describe("work packet — fill in the blank", () => {
  async function seedWithBlank() {
    const scene = await seedPacketScene();
    const db = getDb();
    const [item] = await db
      .insert(items)
      .values({
        assessment_id: scene.assessment.id,
        position: 9,
        type: "fill_blank",
        stem: "STEM-FB the [[b1]] side and the [[b2]] side.",
        config: {
          blanks: [
            {
              id: "b1",
              kind: "dropdown",
              options: [
                { id: "o1", text: "OPT-WINDWARD" },
                { id: "o2", text: "OPT-LEEWARD" },
              ],
              correct_option_id: "o1",
            },
            { id: "b2", kind: "text", keys: ["KEY-DRY"] },
          ],
        },
      })
      .returning();
    await db.insert(responses).values({
      attempt_id: scene.adaAttempt.id,
      item_id: item!.id,
      response: { type: "fill_blank", answers: { b1: "o2", b2: "ADA-TYPED" } },
    });
    return scene;
  }

  test("the sentence with the answers in place; the key only with the teacher's side", async () => {
    const { assessment } = await seedWithBlank();
    const none = packetBody(await render(assessment.id, { section: SECTION, scores: "none" }));
    const adaNone = none.slice(none.indexOf("Fixture, Ada"), none.indexOf("Sample, Ben"));
    expect(adaNone).toContain('<span class="fb-answer">OPT-LEEWARD</span>');
    expect(adaNone).toContain('<span class="fb-answer">ADA-TYPED</span>');
    expect(adaNone).not.toContain("[[b1]]");
    expect(adaNone).not.toContain(">o2<");
    expect(adaNone).not.toContain("OPT-WINDWARD");
    expect(adaNone).not.toContain("KEY-DRY");

    const teacher = packetBody(await render(assessment.id, { section: SECTION, scores: "teacher" }));
    const adaTeacher = teacher.slice(teacher.indexOf("Fixture, Ada"), teacher.indexOf("Sample, Ben"));
    expect(adaTeacher).toContain("expected OPT-WINDWARD");
    expect(adaTeacher).toContain("expected KEY-DRY");
    expect(adaTeacher).toContain("Keyed blanks matching the key: 0 of 2.");
  });

  test("?questions=0 prints Blank n lines instead of the sentence", async () => {
    const { assessment } = await seedWithBlank();
    const body = packetBody(await render(assessment.id, { section: SECTION, questions: "0" }));
    expect(body).not.toContain("STEM-FB");
    expect(body).toContain("Blank 1: OPT-LEEWARD");
    expect(body).toContain("Blank 2: ADA-TYPED");
  });
});

// Batch print slice 1 (docs/batch-print-design.md, D-1..D-4, 8.1, 8.2): the
// packet scene's two Algebra students, plus Cy in a Biology sitting and Eve
// (no roster binding) still working in the Algebra sitting.
describe("work packet — batch print (several sections, chosen students)", () => {
  async function seedBatchScene() {
    const scene = await seedPacketScene();
    const db = getDb();
    const [bio] = await db
      .select()
      .from(roster_sections)
      .where(eq(roster_sections.ps_id, "5002"))
      .limit(1);
    const BIO = sectionLabel(bio!);
    const [cy, eve] = await db
      .insert(students)
      .values([
        { owner_sub: OWNER, roster_ps_id: BIOLOGY_STUDENT.ps_id, name: "Example, Cy" },
        { owner_sub: OWNER, name: "Working, Eve" },
      ])
      .returning();
    const [bioSitting] = await db
      .insert(test_sessions)
      .values({
        assessment_id: scene.assessment.id,
        owner_sub: OWNER,
        owner_email: TEACHER_EMAIL,
        section_ps_id: "5002",
        code: "WP02TST",
        status: "closed",
        expires_at: new Date("2026-09-14T23:00:00Z"),
      })
      .returning();
    const [algebraSitting] = await db
      .select()
      .from(test_sessions)
      .where(eq(test_sessions.code, "WP01TST"))
      .limit(1);
    const [cyAttempt, eveAttempt] = await db
      .insert(attempts)
      .values([
        {
          assessment_id: scene.assessment.id,
          student_id: cy!.id,
          test_session_id: bioSitting!.id,
          status: "submitted" as const,
          started_at: new Date("2026-09-14T16:00:00Z"),
          submitted_at: new Date("2026-09-14T17:10:00Z"),
        },
        {
          assessment_id: scene.assessment.id,
          student_id: eve!.id,
          test_session_id: algebraSitting!.id,
          status: "in_progress" as const,
          started_at: new Date("2026-09-14T16:00:00Z"),
        },
      ])
      .returning();
    return { ...scene, BIO, cyAttempt: cyAttempt!, eveAttempt: eveAttempt! };
  }

  test("two sections: one packet, sections alphabetical, a divider and the section in every footer", async () => {
    const { assessment, BIO } = await seedBatchScene();
    const html = await render(assessment.id, { section: [BIO, SECTION] });
    const body = packetBody(html);
    expect(body.split('class="student-page').length - 1).toBe(3);
    const [first, second] = [SECTION, BIO].sort((a, b) => a.localeCompare(b));
    const dividers = [...body.matchAll(/class="section-divider">([^<]*)</g)].map((m) => m[1]);
    expect(dividers).toEqual([first, second]);
    expect(body.indexOf("Example, Cy") > body.indexOf("Fixture, Ada")).toBe(first === SECTION);
    const footers = [...body.matchAll(/class="page-footer">([\s\S]*?)<\/p>/g)].map((m) => m[1]!);
    expect(footers).toHaveLength(3);
    expect(footers.every((f) => f.includes(SECTION) || f.includes(BIO))).toBe(true);
    // The strip has one line per section; Eve (in progress) is not printed.
    expect(html).toContain(`students in ${SECTION} handed in`);
    expect(html).toContain(`students in ${BIO} handed in`);
    expect(body).not.toContain("Working, Eve");
  });

  test("anonymous: labels numbered per section and a key page closing each section's run (D-2)", async () => {
    const { assessment, BIO } = await seedBatchScene();
    const html = await render(assessment.id, { section: [SECTION, BIO], anon: "1" });
    const body = packetBody(html);
    const keys = body.split("Teacher key — do not distribute").length - 1;
    expect(keys).toBe(2);
    // "Student 01" appears in both sections' runs.
    const pages = body.split('class="student-page"').slice(1);
    const labelled = pages.filter((p) => p.includes("Student 01"));
    expect(labelled.length).toBeGreaterThanOrEqual(2);
    // No name above the first key page.
    const firstKey = body.indexOf("Teacher key — do not distribute");
    expect(body.slice(0, firstKey)).not.toContain("Fixture, Ada");
    expect(body.slice(0, firstKey)).not.toContain("Example, Cy");
  });

  test("in_progress=1 adds work not handed in, with the in-progress mark (D-3)", async () => {
    const { assessment } = await seedBatchScene();
    const off = packetBody(await render(assessment.id, { section: SECTION }));
    expect(off).not.toContain("Working, Eve");
    const on = packetBody(await render(assessment.id, { section: SECTION, in_progress: "1" }));
    expect(on).toContain("Working, Eve");
    expect(on).toContain("In progress — not handed in");
    expect(on.split('class="student-page').length - 1).toBe(3);
  });

  test("chosen students with no section print under their own sections; a chosen in-progress student prints (8.1)", async () => {
    const { assessment, adaAttempt, cyAttempt, eveAttempt } = await seedBatchScene();
    const html = await render(assessment.id, {
      attempt: [adaAttempt.id, cyAttempt.id, eveAttempt.id],
    });
    const body = packetBody(html);
    expect(body.split('class="student-page').length - 1).toBe(3);
    expect(body).toContain("Working, Eve");
    expect(html).toContain("chosen in");
  });

  test("a chosen student outside the ticked sections is left out", async () => {
    const { assessment, BIO, adaAttempt, cyAttempt } = await seedBatchScene();
    const body = packetBody(
      await render(assessment.id, { section: SECTION, attempt: [adaAttempt.id, cyAttempt.id] }),
    );
    // Only Ada is left, so this is one student's work.
    expect(body.split('class="student-page').length - 1).toBe(1);
    expect(body).toContain("Fixture, Ada");
    expect(body).not.toContain("Example, Cy");
    expect(body).not.toContain(BIO);
  });

  test("slice 2 toolbar: both sections ticked, students grouped by section, the in-progress box follows the URL", async () => {
    const { assessment, BIO, adaAttempt, cyAttempt } = await seedBatchScene();
    const html = await render(assessment.id, {
      section: [SECTION, BIO],
      attempt: [adaAttempt.id, cyAttempt.id],
      in_progress: "1",
    });
    expect(box(html, "section", SECTION)!.checked).toBe(true);
    expect(box(html, "section", BIO)!.checked).toBe(true);
    expect(box(html, "attempt", adaAttempt.id)!.checked).toBe(true);
    expect(box(html, "attempt", cyAttempt.id)!.checked).toBe(true);
    const students = html.slice(html.indexOf('class="toolbar-students"'));
    const algebraAt = students.indexOf(`<p class="meta">${SECTION}</p>`);
    const bioAt = students.indexOf(`<p class="meta">${BIO}</p>`);
    expect(algebraAt).toBeGreaterThan(-1);
    expect(bioAt).toBeGreaterThan(-1);
    expect(html).toContain('<input type="checkbox" name="in_progress" checked="" value="1"/>');
    const off = await render(assessment.id, { section: SECTION });
    expect(off).toContain('<input type="checkbox" name="in_progress" value="1"/>');
  });

  test("the chooser lists sections as boxes and links, with Print selected", async () => {
    const { assessment, BIO } = await seedBatchScene();
    const html = await render(assessment.id);
    expect(html).toContain("Print selected");
    expect(html).toContain(`name="section" value="${SECTION}"/>`);
    expect(html).toContain(`name="section" value="${BIO}"/>`);
    expect(html).toContain(
      `/dashboard/${assessment.id}/results/work?section=${encodeURIComponent(BIO)}`,
    );
    expect(html).not.toContain('class="student-page"');
  });

  test("one section still prints as before: no divider, no section in the footer", async () => {
    const { assessment } = await seedBatchScene();
    const body = packetBody(await render(assessment.id, { section: SECTION }));
    expect(body).not.toContain("section-divider");
    const footers = [...body.matchAll(/class="page-footer">([\s\S]*?)<\/p>/g)].map((m) => m[1]!);
    expect(footers.some((f) => f.includes(SECTION))).toBe(false);
  });
});

// Class insights slice 1 (docs/class-insights-design.md): the evidence pack.
// The pure half is proven with hand-built fictional data; one loader test
// runs it end to end against the test DB through buildResults.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import type { Rubric } from "@secure-test/schema";
import { closeDb, getDb } from "../db/client";
import {
  assessments,
  attempts,
  items,
  responses,
  safeguarding_alerts,
  scores,
  students,
} from "../db/schema";
import {
  NO_SECTION_FILTER,
  RATIONALE_MAX,
  STEM_MAX,
  buildEvidencePack,
  buildEvidencePackFromData,
  type EvidencePackInput,
} from "../lib/insights/evidencePack";

const RUBRIC: Rubric = {
  style: "analytic",
  criteria: [
    {
      id: "claim",
      name: "Claim",
      levels: [
        { id: "c1", label: "Emerging", points: 1 },
        { id: "c2", label: "Proficient", points: 2 },
      ],
    },
  ],
};

function rationale(levelId: string, points: number, overall: string) {
  return {
    criterion_scores: [{ criterion_id: "claim", level_id: levelId, points, rationale: "x" }],
    overall_rationale: overall,
  };
}

const ESSAY_ALPHA = "Alpha wrote a long essay about tide pools and kelp forests.";
const ESSAY_BRAVO = "Bravo argued the opposite with three paragraphs of evidence.";

// Three handed-in students and one still working. Attempt ids are chosen so
// the id order (bravo < charlie < zulu) differs from both the name order and
// the score order.
function baseInput(): EvidencePackInput {
  return {
    assessment: {
      title: "Ocean unit check",
      items: [
        {
          id: "item-mc",
          position: 0,
          type: "multiple_choice_single",
          stem: "Which zone gets the most light?",
          max_points: 1,
          standards: ["ngss:MS-LS2-1"],
          choices: [
            { id: "ch-a", text: "Sunlit zone" },
            { id: "ch-b", text: "Twilight zone" },
          ],
          correct_choice_ids: ["ch-a"],
        },
        {
          id: "item-st",
          position: 1,
          type: "short_text",
          stem: "Name the gas plants release.",
          max_points: 1,
          standards: ["ngss:MS-LS2-1", "custom-tag"],
          correct_answer: "oxygen",
        },
        {
          id: "item-essay",
          position: 2,
          type: "essay",
          stem: "Explain one food web.",
          max_points: 2,
          standards: [],
          rubric: RUBRIC,
        },
      ],
    },
    section: null,
    attempts: [
      {
        attempt_id: "attempt-zulu",
        status: "submitted",
        display_name: "Student Alpha",
        student_number: "SNUM-ALPHA",
        email: "alpha@example.test",
        ssid: "SSID-ALPHA",
      },
      {
        attempt_id: "attempt-bravo",
        status: "submitted",
        display_name: "Student Bravo",
        student_number: "SNUM-BRAVO",
        email: "bravo@example.test",
        ssid: "SSID-BRAVO",
      },
      {
        attempt_id: "attempt-charlie",
        status: "submitted",
        display_name: "Student Charlie",
        student_number: "SNUM-CHARLIE",
        email: "charlie@example.test",
        ssid: "SSID-CHARLIE",
      },
      {
        attempt_id: "attempt-delta",
        status: "in_progress",
        display_name: "Student Delta",
        student_number: "SNUM-DELTA",
        email: "delta@example.test",
        ssid: "SSID-DELTA",
      },
    ],
    responses: [
      // Alpha (attempt-zulu): MC right, short "Oxygen" right, essay Proficient.
      { response_id: "resp-z1", attempt_id: "attempt-zulu", item_id: "item-mc", response: { choice_id: "ch-a" }, final: { points: 1, max_points: 1, rationale: null } },
      { response_id: "resp-z2", attempt_id: "attempt-zulu", item_id: "item-st", response: { type: "short_text", text: " Oxygen " }, final: { points: 1, max_points: 1, rationale: null } },
      { response_id: "resp-z3", attempt_id: "attempt-zulu", item_id: "item-essay", response: { type: "essay", text: ESSAY_ALPHA }, final: { points: 2, max_points: 2, rationale: rationale("c2", 2, "Clear claim with evidence.") } },
      // Bravo: MC wrong, short "oxygen" right, essay Emerging but the short
      // answer carries an open alert (excluded from clusters, still scored).
      { response_id: "resp-b1", attempt_id: "attempt-bravo", item_id: "item-mc", response: { choice_id: "ch-b" }, final: { points: 0, max_points: 1, rationale: null } },
      { response_id: "resp-b2", attempt_id: "attempt-bravo", item_id: "item-st", response: { type: "short_text", text: "flagged words here" }, final: { points: 0, max_points: 1, rationale: null } },
      { response_id: "resp-b3", attempt_id: "attempt-bravo", item_id: "item-essay", response: { type: "essay", text: ESSAY_BRAVO }, final: { points: 1, max_points: 2, rationale: rationale("c1", 1, "R".repeat(600)) } },
      // Charlie: MC right, short "oxygen" right, essay NOT yet scored.
      { response_id: "resp-c1", attempt_id: "attempt-charlie", item_id: "item-mc", response: { choice_id: "ch-a" }, final: { points: 1, max_points: 1, rationale: null } },
      { response_id: "resp-c2", attempt_id: "attempt-charlie", item_id: "item-st", response: { type: "short_text", text: "oxygen" }, final: { points: 1, max_points: 1, rationale: null } },
      { response_id: "resp-c3", attempt_id: "attempt-charlie", item_id: "item-essay", response: { type: "essay", text: "Charlie essay text." }, final: null },
      // Delta is in progress: none of this counts.
      { response_id: "resp-d1", attempt_id: "attempt-delta", item_id: "item-mc", response: { choice_id: "ch-b" }, final: { points: 0, max_points: 1, rationale: null } },
      { response_id: "resp-d2", attempt_id: "attempt-delta", item_id: "item-st", response: { type: "short_text", text: "carbon" }, final: null },
    ],
    open_alert_response_ids: new Set(["resp-b2"]),
    tag_lookup: { "ngss:MS-LS2-1": { code: "MS-LS2-1", text: "Analyze data on resources and populations" } },
  };
}

describe("buildEvidencePackFromData", () => {
  test("pseudonyms follow ascending attempt id; names map back", () => {
    const { pack, names } = buildEvidencePackFromData(baseInput());
    expect(pack.students.map((s) => s.id)).toEqual(["S1", "S2", "S3"]);
    expect(names).toEqual({
      S1: { attempt_id: "attempt-bravo", display_name: "Student Bravo" },
      S2: { attempt_id: "attempt-charlie", display_name: "Student Charlie" },
      S3: { attempt_id: "attempt-zulu", display_name: "Student Alpha" },
    });
  });

  test("no identity, id or per-student writing anywhere in the pack", () => {
    const input = baseInput();
    const json = JSON.stringify(buildEvidencePackFromData(input).pack);
    for (const a of input.attempts) {
      for (const v of [a.attempt_id, a.display_name, a.student_number, a.email, a.ssid]) {
        expect(json).not.toContain(v!);
      }
    }
    for (const r of input.responses) expect(json).not.toContain(r.response_id);
    for (const i of input.assessment.items) expect(json).not.toContain(i.id);
    for (const text of [ESSAY_ALPHA, ESSAY_BRAVO, "Charlie essay text.", "flagged words here", "carbon"]) {
      expect(json).not.toContain(text);
    }
    expect(json).not.toContain("Alpha");
  });

  test("in-progress excluded; unscored counted with the header line", () => {
    const { pack } = buildEvidencePackFromData(baseInput());
    expect(pack.scope).toEqual({
      section: "all sections",
      handed_in: 3,
      scored: 2,
      unscored_responses: 1,
      note: "1 response not yet scored — score them first for a complete picture",
    });
    const mc = pack.item_analytics.find((a) => a.label === "Q1")!;
    expect(mc.choice_counts).toEqual([
      { label: "A", count: 2, is_key: true },
      { label: "B", count: 1, is_key: false },
    ]);
    expect(mc.mean).toBe(0.67);
    expect(mc.p_value).toBe(67);
    expect(mc.answered_percent).toBe(100);
  });

  test("no note when everything is scored; section labels", () => {
    const input = baseInput();
    input.responses = input.responses.filter((r) => r.response_id !== "resp-c3");
    input.section = "Period 2";
    const { pack } = buildEvidencePackFromData(input);
    expect(pack.scope.note).toBeNull();
    expect(pack.scope.section).toBe("Period 2");
    expect(buildEvidencePackFromData({ ...input, section: NO_SECTION_FILTER }).pack.scope.section).toBe(
      "no section",
    );
  });

  test("short-text clusters: trim + case-fold, alert-flagged answer excluded", () => {
    const { pack } = buildEvidencePackFromData(baseInput());
    const st = pack.item_analytics.find((a) => a.label === "Q2")!;
    // " Oxygen " and "oxygen" are one cluster; the spelling tie goes to the
    // first in code-point order. Bravo's flagged answer is not in it.
    expect(st.answers).toEqual([{ answer: "Oxygen", count: 2, mean_points: 1 }]);
    // Bravo's alert-flagged answer still scored 0, so the item mean counts it.
    expect(st.mean).toBe(0.67);
    expect(pack.assessment.items[1]!.key).toBe("oxygen");
  });

  test("short-text clusters keep the top 8 by count", () => {
    const input = baseInput();
    for (let i = 0; i < 10; i++) {
      for (let n = 0; n <= i; n++) {
        input.responses.push({
          response_id: `resp-x${i}-${n}`,
          attempt_id: "attempt-charlie",
          item_id: "item-st",
          response: { text: `answer ${i}` },
          final: null,
        });
      }
    }
    const st = buildEvidencePackFromData(input).pack.item_analytics.find((a) => a.label === "Q2")!;
    expect(st.answers!.length).toBe(8);
    expect(st.answers![0]).toEqual({ answer: "answer 9", count: 10, mean_points: null });
  });

  test("essay criterion distribution and per-student levels + rationale", () => {
    const { pack } = buildEvidencePackFromData(baseInput());
    const essay = pack.item_analytics.find((a) => a.label === "Q3")!;
    expect(essay.criteria).toEqual([
      {
        criterion: "Claim",
        levels: [
          { level: "Emerging", count: 1 },
          { level: "Proficient", count: 1 },
        ],
      },
    ]);
    const s1 = pack.students.find((s) => s.id === "S1")!;
    expect(s1.essays[0]!.criteria).toEqual([{ criterion: "Claim", level: "Emerging", points: 1 }]);
    expect(s1.essays[0]!.rationale!.length).toBe(RATIONALE_MAX);
    expect(s1.essays[0]!.rationale!.endsWith("…")).toBe(true);
    const s3 = pack.students.find((s) => s.id === "S3")!;
    expect(s3.essays[0]!.rationale).toBe("Clear claim with evidence.");
  });

  test("figures carry every number by stable key", () => {
    const { pack } = buildEvidencePackFromData(baseInput());
    const f = pack.figures;
    expect(f["item.Q1.p_value"]).toBe(67);
    expect(f["item.Q1.mean"]).toBe(0.67);
    expect(f["item.Q1.choice.B.count"]).toBe(1);
    expect(f["item.Q3.criterion.Claim.Emerging.count"]).toBe(1);
    // ngss:MS-LS2-1 tags Q1 and Q2: 4 of 6 final points.
    expect(f["tag.ngss:MS-LS2-1.percent"]).toBe(67);
    expect(f["tag.custom-tag.percent"]).toBe(67);
    expect(f["student.S3.total"]).toBe(4);
    expect(f["student.S3.max"]).toBe(4);
    expect(f["student.S1.item.Q1.points"]).toBe(0);
    expect(f["student.S1.tag.ngss:MS-LS2-1.percent"]).toBe(0);
    expect(f["student.S2.item.Q3.points"]).toBeUndefined();
    expect(f["scope.unscored_responses"]).toBe(1);
    expect(pack.students.find((s) => s.id === "S2")!.unscored).toBe(1);
    expect(pack.tags.find((t) => t.tag === "ngss:MS-LS2-1")!.code).toBe("MS-LS2-1");
    expect(pack.assessment.items[0]!.tags[0]!.text).toBe("Analyze data on resources and populations");
  });

  test("stems truncated to the limit, pictures replaced", () => {
    const input = baseInput();
    input.assessment.items[0]!.stem = `![a diagram](asset:abc) ${"word ".repeat(80)}`;
    const stem = buildEvidencePackFromData(input).pack.assessment.items[0]!.stem;
    expect(stem.length).toBeLessThanOrEqual(STEM_MAX);
    expect(stem.endsWith("…")).toBe(true);
    expect(stem.startsWith("[image: a diagram] word")).toBe(true);
    expect(stem).not.toContain("asset:");
  });

  test("hash is stable and moves with one score", () => {
    const a = buildEvidencePackFromData(baseInput()).pack.hash;
    expect(buildEvidencePackFromData(baseInput()).pack.hash).toBe(a);
    // Input order does not matter.
    const reordered = baseInput();
    reordered.attempts.reverse();
    reordered.responses.reverse();
    expect(buildEvidencePackFromData(reordered).pack.hash).toBe(a);
    const changed = baseInput();
    changed.responses.find((r) => r.response_id === "resp-b1")!.final!.points = 1;
    expect(buildEvidencePackFromData(changed).pack.hash).not.toBe(a);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// Loader, against the test DB.

const OWNER = "insights-teacher";

describe("buildEvidencePack (DB)", () => {
  beforeAll(() => {
    const url = process.env.DATABASE_URL ?? "";
    if (!url.includes("secure_test_design_tool_test")) {
      throw new Error(`insights tests require the test DB DATABASE_URL; got: ${url}`);
    }
  });

  afterEach(async () => {
    const db = getDb();
    await db.execute(sql`truncate table assessments restart identity cascade`);
    await db.execute(sql`truncate table students restart identity cascade`);
  });

  afterAll(async () => {
    await closeDb();
  });

  test("scopes through buildResults, drops practice / proposals, honours open alerts", async () => {
    const db = getDb();
    const [a] = await db.insert(assessments).values({ owner_sub: OWNER, name: "Loader check" }).returning();
    const [st] = await db
      .insert(items)
      .values({
        assessment_id: a!.id,
        position: 0,
        type: "short_text",
        stem: "Gas?",
        correct_answer: "oxygen",
        standards: ["ngss:MS-LS2-1"],
      })
      .returning();
    const studentRows = await db
      .insert(students)
      .values([
        { owner_sub: OWNER, ssid: "SSID-ONE", name: "Student One" },
        { owner_sub: OWNER, ssid: "SSID-TWO", name: "Student Two" },
        { owner_sub: OWNER, ssid: "SSID-THREE", name: "Student Three" },
      ])
      .returning();
    const t = new Date("2026-10-01T17:00:00Z");
    const attemptRows = await db
      .insert(attempts)
      .values(
        studentRows.map((s, i) => ({
          assessment_id: a!.id,
          student_id: s.id,
          status: "submitted" as const,
          started_at: new Date(t.getTime() - (10 - i) * 60_000),
          submitted_at: t,
          practice: i === 2,
        })),
      )
      .returning();
    const resp = await db
      .insert(responses)
      .values(
        attemptRows.map((at, i) => ({
          attempt_id: at.id,
          item_id: st!.id,
          response: { type: "short_text" as const, text: ["Oxygen", "alerted answer", "practice answer"][i]! },
        })),
      )
      .returning();
    await db.insert(scores).values([
      { response_id: resp[0]!.id, method: "auto", points: 1, max_points: 1, scorer: "auto", status: "final" },
      // Two's only score is a proposal: unscored, not counted.
      { response_id: resp[1]!.id, method: "ai", points: 1, max_points: 1, scorer: "mock", status: "proposed" },
      { response_id: resp[2]!.id, method: "auto", points: 0, max_points: 1, scorer: "auto", status: "final" },
    ]);
    await db.insert(safeguarding_alerts).values({
      response_id: resp[1]!.id,
      attempt_id: attemptRows[1]!.id,
      assessment_id: a!.id,
      student_id: studentRows[1]!.id,
      item_id: st!.id,
      kind: "wellbeing",
      category: "self_harm",
      detector: "mock",
    });

    const { pack, names } = await buildEvidencePack(db, { assessmentId: a!.id, section: null });
    expect(pack.assessment.title).toBe("Loader check");
    expect(pack.scope.handed_in).toBe(2);
    expect(pack.scope.unscored_responses).toBe(1);
    expect(pack.students.length).toBe(1);
    expect(names.S1!.display_name).toBe("Student One");
    expect(pack.item_analytics[0]!.answers).toEqual([{ answer: "Oxygen", count: 1, mean_points: 1 }]);
    expect(pack.figures["tag.ngss:MS-LS2-1.percent"]).toBe(100);
    const json = JSON.stringify(pack);
    for (const v of ["Student", "SSID-", "alerted answer", "practice answer", ...attemptRows.map((r) => r.id)]) {
      expect(json).not.toContain(v);
    }

    // A section nobody is in: empty scope, nothing to say.
    const empty = await buildEvidencePack(db, { assessmentId: a!.id, section: "Period 9" });
    expect(empty.pack.scope.handed_in).toBe(0);
    expect(empty.pack.students).toEqual([]);
  });
});

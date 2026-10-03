// Class insights slice 2 (docs/class-insights-design.md, D-3): the report's
// fill — numbers only from the pack, unknown keys / labels / pseudonyms and
// invented digits dropped, celebrations only with evidence — plus the prompt
// input (no names) and the render's name swap. Pure; no database.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { Rubric } from "@secure-test/schema";
import { mockClassInsights } from "../lib/ai/mockProvider";
import {
  buildEvidencePackFromData,
  type EvidencePackInput,
} from "../lib/insights/evidencePack";
import {
  allowedStrings,
  fillReport,
  formatFigure,
  parseReportObject,
  plainText,
  reportText,
  type ClassInsightsPackInput,
  type ClassInsightsReport,
  studentsFitClaim,
} from "../lib/insights/report";
import {
  CLASS_INSIGHTS_PROMPT_VERSION,
  CLASS_INSIGHTS_SYSTEM_PROMPT,
  buildClassInsightsUserText,
} from "../lib/insights/reportPrompt";
import { GONE_STUDENT, normalizeSection, renderReport } from "../lib/insights/reportView";

const RUBRIC: Rubric = {
  style: "analytic",
  criteria: [
    {
      id: "ev",
      name: "Evidence",
      levels: [
        { id: "e1", label: "Level 1 Emerging", points: 1 },
        { id: "e2", label: "Proficient", points: 2 },
      ],
    },
  ],
};

function input(): EvidencePackInput {
  const mk = (attempt: string, item: string, response: Record<string, unknown>, points: number | null, max: number, rationale: unknown = null) => ({
    response_id: `${attempt}-${item}`,
    attempt_id: attempt,
    item_id: item,
    response,
    final: points === null ? null : { points, max_points: max, rationale },
  });
  const essay = (level: string, pts: number) => ({
    criterion_scores: [{ criterion_id: "ev", level_id: level, points: pts, rationale: "x" }],
    overall_rationale: "Uses two sources.",
  });
  return {
    assessment: {
      title: "Ratio check",
      items: [
        {
          id: "i-mc",
          position: 0,
          type: "multiple_choice_single",
          stem: "Which ratio is equivalent to 2:3?",
          max_points: 1,
          standards: ["wa2026:M.7.R.RP.2"],
          choices: [
            { id: "a", text: "4:6" },
            { id: "b", text: "3:2" },
            { id: "c", text: "2:5" },
          ],
          correct_choice_ids: ["a"],
        },
        { id: "i-st", position: 1, type: "short_text", stem: "Simplify 6/8.", max_points: 1, standards: [], correct_answer: "3/4" },
        { id: "i-es", position: 2, type: "essay", stem: "Explain.", max_points: 2, standards: [], rubric: RUBRIC },
      ],
    },
    section: null,
    attempts: [
      { attempt_id: "att-a", status: "submitted", display_name: "Student Alpha" },
      { attempt_id: "att-b", status: "submitted", display_name: "Student Bravo" },
      { attempt_id: "att-c", status: "submitted", display_name: "Student Charlie" },
    ],
    responses: [
      mk("att-a", "i-mc", { choice_id: "a" }, 1, 1),
      mk("att-a", "i-st", { text: "3/4" }, 1, 1),
      mk("att-a", "i-es", { text: "essay" }, 2, 2, essay("e2", 2)),
      mk("att-b", "i-mc", { choice_id: "b" }, 0, 1),
      mk("att-b", "i-st", { text: "6/8" }, 0, 1),
      mk("att-b", "i-es", { text: "essay" }, 1, 2, essay("e1", 1)),
      mk("att-c", "i-mc", { choice_id: "b" }, 0, 1),
      mk("att-c", "i-st", { text: "3/4" }, 1, 1),
    ],
    open_alert_response_ids: new Set(),
    tag_lookup: { "wa2026:M.7.R.RP.2": { code: "7.RP.A.2", text: "Recognize proportional relationships" } },
  };
}

function built() {
  const result = buildEvidencePackFromData(input());
  const { hash: _hash, ...forModel } = result.pack;
  return { ...result, forModel: forModel as ClassInsightsPackInput };
}

const OK_STEPS = [
  { text: "Reteach equivalent ratios with a ratio table before Friday.", citations: { items: ["Q1"] } },
  { text: "Pull S2 and S3 into a small group on Q1.", citations: { students: ["S2", "S3"] } },
];

function reply(over: Partial<Record<keyof ClassInsightsReport, unknown[]>> = {}) {
  return { strengths: [], growth: [], celebrations: [], next_steps: OK_STEPS, ...over };
}

/**
 * Every number left in a filled text, after the labels and the pack's
 * allowed strings come out — each must be a formatted pack value.
 */
function numbersIn(text: string, pack: ClassInsightsPackInput): string[] {
  let t = plainText(text).replace(/\b[QS]\d+\b/g, " ");
  for (const s of allowedStrings(pack).sort((a, b) => b.length - a.length)) t = t.split(s).join(" ");
  return t.match(/\d+(?:\.\d+)?%?/g) ?? [];
}

describe("fillReport", () => {
  test("fills {keys} from the pack, formats percents, wraps labels, unions text labels into citations", () => {
    const { forModel } = built();
    const { report, dropped } = fillReport(
      reply({
        strengths: [{ text: "Q2 went well at {item.Q2.p_value}; S1 scored {student.S1.total}." }],
      }),
      forModel,
    );
    expect(dropped).toBe(0);
    const claim = report.strengths[0]!;
    expect(claim.text).toBe(`[[Q2]] went well at ${forModel.figures["item.Q2.p_value"]}%; [[S1]] scored 4.`);
    expect(claim.citations.items).toEqual(["Q2"]);
    expect(claim.citations.students).toEqual(["S1"]);
    expect(claim.figures.sort()).toEqual(["item.Q2.p_value", "student.S1.total"]);
    expect(formatFigure("item.Q1.mean", 0.33)).toBe("0.33");
    expect(formatFigure("tag.x.percent", 50)).toBe("50%");
  });

  test("drops a claim with an unknown key, label, pseudonym, tag or cited figure", () => {
    const { forModel } = built();
    const bad = [
      { text: "Look at {item.Q9.p_value}." },
      { text: "Q7 was easy." },
      { text: "S44 shone." },
      { text: "Fine.", citations: { students: ["S9"] } },
      { text: "Fine.", citations: { items: ["Q0"] } },
      { text: "Fine.", citations: { tags: ["NOT.A.TAG"] } },
      { text: "Fine.", figures: ["student.S1.nope"] },
      { text: "Unclosed {item.Q1.p_value" },
      { text: "We wrote [[S1]] ourselves." },
    ];
    const { report, dropped } = fillReport(
      reply({ growth: bad.slice(0, 5), strengths: bad.slice(5) }),
      forModel,
    );
    expect(report.growth).toEqual([]);
    expect(report.strengths).toEqual([]);
    expect(dropped).toBe(bad.length);
  });

  test("the digit rule: invented numbers drop; tag codes, rubric names and labels do not", () => {
    const { forModel } = built();
    const { report, dropped } = fillReport(
      reply({
        strengths: [
          { text: "Seven students got it: 7 of them." },
          { text: "Half the class (50%) missed it." },
          { text: "Standard 7.RP.A.2 came out at {tag.wa2026:M.7.R.RP.2.percent}.", citations: { tags: ["7.RP.A.2"] } },
          { text: "On Evidence, S2 sat at Level 1 Emerging.", citations: { students: ["S2"] } },
        ],
      }),
      forModel,
    );
    expect(dropped).toBe(2);
    expect(report.strengths.map((c) => plainText(c.text))).toEqual([
      `Standard 7.RP.A.2 came out at ${forModel.figures["tag.wa2026:M.7.R.RP.2.percent"]}%.`,
      "On Evidence, S2 sat at Level 1 Emerging.",
    ]);
    // A code cited as its code is stored as the tag.
    expect(report.strengths[0]!.citations.tags).toEqual(["wa2026:M.7.R.RP.2"]);
  });

  test("a digit-only level label does not open the digit rule", () => {
    const pack = { ...built().forModel };
    pack.item_analytics = pack.item_analytics.map((a) =>
      a.criteria ? { ...a, criteria: [{ criterion: "Evidence", levels: [{ level: "3", count: 1 }] }] } : a,
    );
    expect(allowedStrings(pack)).not.toContain("3");
    const { dropped } = fillReport(reply({ strengths: [{ text: "S1 reached level 3." }] }), pack);
    expect(dropped).toBe(1);
  });

  test("celebrations need a student AND a figure or an item", () => {
    const { forModel } = built();
    const { report, dropped } = fillReport(
      reply({
        celebrations: [
          { text: "Great effort all round." },
          { text: "S1 worked hard." },
          { text: "Q1 went well at {item.Q1.p_value}." },
          { text: "S1 earned {student.S1.total} of {student.S1.max}." },
          { text: "S3 nailed it.", citations: { students: ["S3"], items: ["Q2"] } },
        ],
      }),
      forModel,
    );
    expect(dropped).toBe(3);
    expect(report.celebrations.map((c) => plainText(c.text))).toEqual([
      "S1 earned 4 of 4.",
      "S3 nailed it.",
    ]);
  });

  test("the reply must be four sections with 2–4 next steps, else report_invalid", () => {
    const { forModel } = built();
    expect(() => fillReport({ strengths: [] }, forModel)).toThrow(/report_invalid/);
    expect(() => fillReport(reply({ next_steps: [OK_STEPS[0]] }), forModel)).toThrow(/report_invalid/);
    expect(() =>
      fillReport(reply({ next_steps: [...OK_STEPS, ...OK_STEPS, ...OK_STEPS] }), forModel),
    ).toThrow(/report_invalid/);
    expect(() => fillReport(reply({ strengths: Array(7).fill(OK_STEPS[0]) }), forModel)).toThrow(/report_invalid/);
    // An over-long claim drops alone.
    const { dropped } = fillReport(reply({ growth: [{ text: "x".repeat(401) }] }), forModel);
    expect(dropped).toBe(1);
  });

  test("every number in a filled mock report is a pack value", () => {
    const { forModel } = built();
    const { report, dropped } = fillReport(mockClassInsights(forModel), forModel);
    expect(dropped).toBe(0);
    const values = new Set(Object.entries(forModel.figures).map(([k, v]) => formatFigure(k, v)));
    const all = reportText(report);
    expect(all.length).toBeGreaterThan(0);
    for (const n of numbersIn(all, forModel)) expect(values.has(n)).toBe(true);
    expect(report.celebrations.length).toBe(1);
    expect(report.next_steps.length).toBeGreaterThanOrEqual(2);
  });

  test("the mock's MOCK_INVENTED claims all drop", () => {
    const { forModel } = built();
    const pack = { ...forModel, assessment: { ...forModel.assessment, title: "MOCK_INVENTED" } };
    const plain = fillReport(mockClassInsights(forModel), forModel);
    const invented = fillReport(mockClassInsights(pack), pack);
    expect(invented.dropped).toBe(plain.dropped + 3);
  });
});

describe("CI-1 / CI-2 (Bedrock hand-run 2026-10-03)", () => {
  test("a % typed after a percent key is not doubled", () => {
    const { forModel } = built();
    const key = Object.keys(forModel.figures).find((k) => /p_value$/.test(k))!;
    const { report } = fillReport(
      reply({ strengths: [{ text: `The class reached {${key}}% here.`, figures: [key] }] }),
      forModel,
    );
    expect(report.strengths[0]!.text).toBe(`The class reached ${forModel.figures[key]}% here.`);
  });

  test("growth drops a claim naming a student with full points on every cited question; celebrations drop one naming a student with no points", () => {
    const { forModel } = built();
    const cells = forModel.students.flatMap((st) =>
      st.items.filter((i) => i.points !== null).map((i) => ({ s: st.id, q: i.label, full: i.points! >= i.max_points, zero: i.points === 0 })),
    );
    const full = cells.find((c) => c.full)!;
    const zero = cells.find((c) => c.zero)!;
    expect(full && zero).toBeTruthy();
    const { report, dropped } = fillReport(
      reply({
        growth: [
          { text: `${full.s} shows the gap on ${full.q}.`, citations: { items: [full.q], students: [full.s] } },
          { text: `${zero.s} shows the gap on ${zero.q}.`, citations: { items: [zero.q], students: [zero.s] } },
        ],
        celebrations: [
          { text: `${zero.s} shone on ${zero.q}.`, citations: { items: [zero.q], students: [zero.s] } },
          { text: `${full.s} shone on ${full.q}.`, citations: { items: [full.q], students: [full.s] } },
        ],
      }),
      forModel,
    );
    expect(report.growth.map((c) => c.citations.students)).toEqual([[zero.s]]);
    expect(report.celebrations.map((c) => c.citations.students)).toEqual([[full.s]]);
    expect(dropped).toBe(2);
  });

  test("studentsFitClaim passes claims without both a question and a student", () => {
    expect(studentsFitClaim("growth", { citations: { items: ["Q1"], tags: [], students: [] } }, new Map())).toBe(true);
    expect(studentsFitClaim("celebrations", { citations: { items: [], tags: [], students: ["S1"] } }, new Map())).toBe(true);
  });
});

describe("parseReportObject", () => {
  test("reads fenced or prose-wrapped JSON; refuses an array or garbage", () => {
    expect(parseReportObject('```json\n{"a":1}\n```', "x")).toEqual({ a: 1 });
    expect(parseReportObject('Here it is: {"a":1} — done', "x")).toEqual({ a: 1 });
    expect(() => parseReportObject("[1,2]", "x")).toThrow("x_returned_invalid_json");
    expect(() => parseReportObject("nope", "x", { truncated: true })).toThrow(/token cap/);
  });
});

describe("the model's input", () => {
  test("carries no display name, no hash and no attempt / item id", () => {
    const { forModel, names, items, pack } = built();
    const text = CLASS_INSIGHTS_SYSTEM_PROMPT + buildClassInsightsUserText(forModel);
    for (const { display_name, attempt_id } of Object.values(names)) {
      expect(text).not.toContain(display_name);
      expect(text).not.toContain(attempt_id);
    }
    for (const id of Object.values(items)) expect(text).not.toContain(`"${id}"`);
    expect(text).not.toContain(pack.hash);
    expect(text).toContain('"S1"');
  });
});

describe("renderReport", () => {
  test("names in through the stored map and the CURRENT results; gone renders as such; labels follow position", () => {
    const { forModel } = built();
    const { report } = fillReport(
      reply({ growth: [{ text: "S2 and S3 missed Q1 and Q3.", citations: { tags: ["7.RP.A.2"] } }] }),
      forModel,
    );
    const rendered = renderReport(report, {
      pseudonyms: { S1: "att-a", S2: "att-b", S3: "att-c" },
      itemIds: { Q1: "i-mc", Q2: "i-st", Q3: "i-es" },
      // att-c has been deleted; the MC item moved to position 4; the essay is gone.
      nameByAttempt: new Map([
        ["att-a", "Student Alpha"],
        ["att-b", "Student Bravo"],
      ]),
      positionByItem: new Map([
        ["i-mc", 4],
        ["i-st", 1],
      ]),
      tagLookup: { "wa2026:M.7.R.RP.2": { code: "7.RP.A.2", text: "Recognize proportional relationships" } },
    });
    const claim = rendered.growth[0]!;
    expect(claim.text).toBe(`Student Bravo and ${GONE_STUDENT} missed Q5 and Q3.`);
    expect(claim.citations.students).toEqual([
      { pseudonym: "S2", attempt_id: "att-b", name: "Student Bravo" },
      { pseudonym: "S3", attempt_id: null, name: GONE_STUDENT },
    ]);
    expect(claim.citations.items).toEqual([
      { label: "Q5", item_id: "i-mc" },
      { label: "Q3", item_id: null },
    ]);
    expect(claim.citations.tags[0]!.code).toBe("7.RP.A.2");
  });

  test("normalizeSection", () => {
    expect(normalizeSection(undefined)).toBeNull();
    expect(normalizeSection("")).toBeNull();
    expect(normalizeSection("__all__")).toBeNull();
    expect(normalizeSection("__none__")).toBe("__none__");
    expect(normalizeSection(" Period 2 ")).toBe("Period 2");
  });
});

// Same drift check as test/essay-prompt-version.test.ts: the version is
// stored on every report row, so it must move when the prompt does.
// The fixture pack is part of the hash, so a change to what the evidence pack
// carries (slice 1) also asks for a bump — it changes what the model sees.
const RECORDED_PROMPT_HASH = "611f47173366933b05d31d8c71e127430435ee06482f4208595d406423985780";

describe("CLASS_INSIGHTS_PROMPT_VERSION", () => {
  test("the prompt has not drifted from the recorded version", () => {
    expect(CLASS_INSIGHTS_PROMPT_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}(\.\d+)?$/);
    const actual = createHash("sha256")
      .update(CLASS_INSIGHTS_SYSTEM_PROMPT)
      .update(" ")
      .update(buildClassInsightsUserText(built().forModel))
      .digest("hex");
    if (actual !== RECORDED_PROMPT_HASH) {
      throw new Error(
        `The class-insights prompt changed. Bump CLASS_INSIGHTS_PROMPT_VERSION in ` +
          `lib/insights/reportPrompt.ts (currently "${CLASS_INSIGHTS_PROMPT_VERSION}") and set ` +
          `RECORDED_PROMPT_HASH in this file to: ${actual}`,
      );
    }
  });
});

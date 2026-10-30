// FR slice 3 (docs/feedback-release-design.md, R-3): the shared content
// model, pure. Every combination of the five boxes (2^5) against every score
// history the scoring flows can leave behind, with and without teacher
// comments, checked against a hand-written expectation per scenario — and the
// same cases rendered to Doc HTML for the label rules (D-1, D-13). No
// database, no Drive.
import { describe, expect, test } from "bun:test";
import type { Rubric } from "@secure-test/schema";
import {
  buildFeedbackRelease,
  scoreLabel,
  type FeedbackBlock,
  type FeedbackContents,
} from "../lib/reporting/feedbackRelease";
import type { PacketScoreRow } from "../lib/reporting/workPacket";
import { buildDocHtml, type ReleaseContents } from "../lib/googleDocs/content";

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
    {
      id: "evidence",
      name: "Evidence",
      levels: [
        { id: "e1", label: "Thin", points: 1 },
        { id: "e2", label: "Strong", points: 2 },
      ],
    },
  ],
};

const NOTE = "NOTE-SENTINEL regraded after appeal";

let clock = 0;
function row(
  method: "ai" | "human" | "auto",
  status: "proposed" | "final" | "superseded" | "research",
  points: number,
  rationale: unknown,
  reviewed: string | null = null,
): PacketScoreRow {
  clock += 1;
  return {
    method,
    status,
    reviewed_by_sub: reviewed,
    points,
    max_points: 4,
    rationale,
    created_at: new Date(Date.UTC(2026, 9, 1, 0, clock)),
  };
}

/** A moment between the rows made before and after it: when the student last edited. */
function edited(): Date {
  clock += 1;
  return new Date(Date.UTC(2026, 9, 1, 0, clock));
}
/** The usual case: the answer was last changed before any score row. */
const HANDED_IN = new Date(Date.UTC(2026, 8, 1));

/** An AI row's rationale; `tag` marks every string so its source is traceable. */
function aiRationale(tag: string, claim: "c1" | "c2", evidence: "e1" | "e2") {
  return {
    criterion_scores: [
      { criterion_id: "claim", level_id: claim, points: claim === "c1" ? 1 : 2, rationale: `${tag} claim comment` },
      { criterion_id: "evidence", level_id: evidence, points: evidence === "e1" ? 1 : 2, rationale: `${tag} evidence comment` },
    ],
    overall_rationale: `${tag} overall`,
  };
}

/** A teacher's manual analytic score: levels, no comments, and a change reason that must never print. */
const TEACHER_RATIONALE = {
  criterion_scores: [
    { criterion_id: "claim", level_id: "c2", points: 2 },
    { criterion_id: "evidence", level_id: "e2", points: 2 },
  ],
  note: NOTE,
};
const TEACHER_LEVELS = { Claim: ["Proficient", 2], Evidence: ["Strong", 2] } as const;

type Levels = Record<"Claim" | "Evidence", readonly [string, number]>;

interface Scenario {
  name: string;
  rows: PacketScoreRow[];
  /** The standing score as D-3 / D-13 / D-17 read it, or null. */
  final: { method: "human" | "ai" | "auto"; points: number; levels: Levels | null } | null;
  /** D-10: the AI row whose comments may print, by its tag, or null. */
  aiTag: string | null;
  /** Strings that must never reach a student under any boxes. */
  never: string[];
  /** `responses.updated_at`; defaults to before every row (HANDED_IN). */
  answeredAt?: Date;
}

const SCENARIOS: Scenario[] = [
  { name: "no scores", rows: [], final: null, aiTag: null, never: [] },
  {
    name: "auto final (answer key)",
    rows: [row("auto", "final", 2, null)],
    final: { method: "auto", points: 2, levels: null },
    aiTag: null,
    never: [],
  },
  {
    name: "teacher final",
    rows: [row("human", "final", 3, TEACHER_RATIONALE, "t1")],
    final: { method: "human", points: 3, levels: TEACHER_LEVELS },
    aiTag: null,
    never: [NOTE],
  },
  {
    // Approve inserts a final copy beside the proposal (approve route).
    name: "AI final, approved",
    rows: [row("ai", "proposed", 3, aiRationale("AIP", "c2", "e1")), row("ai", "final", 3, aiRationale("AIA", "c2", "e1"), "t1")],
    final: { method: "ai", points: 3, levels: { Claim: ["Proficient", 2], Evidence: ["Thin", 1] } },
    aiTag: "AIA",
    never: ["AIP"],
  },
  {
    // D-17: a Hybrid final no teacher reviewed still counts as "AI score".
    name: "Hybrid AI final, unreviewed",
    rows: [row("ai", "final", 2, aiRationale("HYB", "c1", "e2"))],
    final: { method: "ai", points: 2, levels: { Claim: ["Emerging", 1], Evidence: ["Strong", 2] } },
    aiTag: "HYB",
    never: [],
  },
  {
    // T2 (open): D-10 as written lets an unreviewed proposal's comments out.
    name: "AI proposal only, no final",
    rows: [row("ai", "proposed", 1, aiRationale("PRO", "c1", "e1"))],
    final: null,
    aiTag: "PRO",
    never: [],
  },
  {
    name: "override: teacher final beside the AI proposal",
    rows: [row("ai", "proposed", 1, aiRationale("OVR", "c1", "e1")), row("human", "final", 3, TEACHER_RATIONALE, "t1")],
    final: { method: "human", points: 3, levels: TEACHER_LEVELS },
    aiTag: "OVR",
    never: [NOTE],
  },
  {
    name: "override, holistic: teacher final without levels",
    rows: [row("ai", "proposed", 1, aiRationale("HOL", "c1", "e1")), row("human", "final", 3, { note: NOTE }, "t1")],
    final: { method: "human", points: 3, levels: null },
    aiTag: "HOL",
    never: [NOTE],
  },
  {
    // The approved copy is superseded by the change; the proposal stays.
    name: "approve, then change",
    rows: [
      row("ai", "proposed", 1, aiRationale("ATCP", "c1", "e1")),
      row("ai", "superseded", 1, aiRationale("ATCS", "c1", "e1"), "t1"),
      row("human", "final", 3, { ...TEACHER_RATIONALE, changed_from: { score_id: "x" } }, "t1"),
    ],
    final: { method: "human", points: 3, levels: TEACHER_LEVELS },
    aiTag: "ATCP",
    never: [NOTE, "ATCS"],
  },
  {
    // T1 (open): Hybrid's only AI row is superseded by the change, so D-10 as
    // written ("non-superseded") finds no AI feedback to send.
    name: "Hybrid, then change",
    rows: [
      row("ai", "superseded", 1, aiRationale("HTC", "c1", "e1")),
      row("human", "final", 3, { ...TEACHER_RATIONALE, changed_from: { score_id: "x" } }, "t1"),
    ],
    final: { method: "human", points: 3, levels: TEACHER_LEVELS },
    aiTag: null,
    never: [NOTE, "HTC"],
  },
  {
    name: "a newer research row is ignored",
    rows: [row("ai", "final", 3, aiRationale("LIVE", "c2", "e1"), "t1"), row("ai", "research", 1, aiRationale("RES", "c1", "e1"))],
    final: { method: "ai", points: 3, levels: { Claim: ["Proficient", 2], Evidence: ["Thin", 1] } },
    aiTag: "LIVE",
    never: ["RES"],
  },
  {
    name: "passed back: superseded rows only",
    rows: [row("ai", "superseded", 1, aiRationale("PB", "c1", "e1"), "t1"), row("human", "superseded", 3, TEACHER_RATIONALE, "t1")],
    final: null,
    aiTag: null,
    never: [NOTE, "PB"],
  },
  (() => {
    // D-10 after a pass-back: the proposal is left in place (passBackAttempt),
    // the student rewrites, the teacher scores by hand without re-running AI.
    // The old proposal is about the old answer, so no AI feedback.
    const stale = row("ai", "proposed", 1, aiRationale("STALE", "c1", "e1"));
    const answeredAt = edited();
    return {
      name: "passed back, rewritten, scored by hand: the old proposal is stale",
      rows: [stale, row("human", "final", 3, TEACHER_RATIONALE, "t1")],
      final: { method: "human" as const, points: 3, levels: TEACHER_LEVELS },
      aiTag: null,
      never: [NOTE, "STALE"],
      answeredAt,
    };
  })(),
  (() => {
    // The same, with AI re-run on the new answer: the fresh proposal prints.
    const stale = row("ai", "proposed", 1, aiRationale("STALE2", "c1", "e1"));
    const answeredAt = edited();
    return {
      name: "passed back, rewritten, AI re-run: only the new proposal",
      rows: [stale, row("ai", "proposed", 2, aiRationale("FRESH", "c2", "e1")), row("human", "final", 3, TEACHER_RATIONALE, "t1")],
      final: { method: "human" as const, points: 3, levels: TEACHER_LEVELS },
      aiTag: "FRESH",
      never: [NOTE, "STALE2"],
      answeredAt,
    };
  })(),
];

const KEYS = ["teacher_score", "ai_score", "teacher_feedback", "ai_feedback", "rubric_table"] as const;
const COMBOS: FeedbackContents[] = Array.from({ length: 1 << KEYS.length }, (_, mask) =>
  Object.fromEntries(KEYS.map((k, i) => [k, (mask & (1 << i)) !== 0])) as unknown as FeedbackContents,
);
const TEACHER_TEXT = ["  Revisit your second paragraph.  ", "   ", null] as const;
const OVERALL_TEXT = ["Good growth this unit.", null] as const;

/** The expectation, written from the decisions rather than the code. */
function expected(c: FeedbackContents, sc: Scenario, teacher: string | null): FeedbackBlock[] {
  const out: FeedbackBlock[] = [];
  const f = sc.final;
  const showScore =
    f !== null &&
    (f.method === "human" ? c.teacher_score : f.method === "ai" ? c.ai_score : c.teacher_score || c.ai_score);
  if (showScore) {
    out.push({ kind: "score", label: scoreLabel(f!.method), points: f!.points, max_points: 4 });
  }
  const ai = c.ai_feedback ? sc.aiTag : null;
  if (c.rubric_table) {
    const levels = f?.levels ?? null;
    if (levels || ai) {
      out.push({
        kind: "rubric_table",
        columns: { level: levels !== null, points: levels !== null && showScore, ai_feedback: ai !== null },
        rows: (["Claim", "Evidence"] as const).map((name) => ({
          criterion: name,
          level: levels ? levels[name][0] : null,
          points: levels && showScore ? levels[name][1] : null,
          ai_feedback: ai ? `${ai} ${name.toLowerCase()} comment` : null,
        })),
      });
    }
  }
  if (ai) {
    out.push({
      kind: "feedback",
      source: "ai",
      label: "AI feedback",
      text: `${ai} overall`,
      criteria: c.rubric_table
        ? []
        : [
            { criterion: "Claim", text: `${ai} claim comment` },
            { criterion: "Evidence", text: `${ai} evidence comment` },
          ],
    });
  }
  if (c.teacher_feedback && teacher && teacher.trim()) {
    out.push({ kind: "feedback", source: "teacher", label: "Teacher feedback", text: teacher.trim(), criteria: [] });
  }
  return out;
}

function boxes(c: FeedbackContents): string {
  return KEYS.filter((k) => c[k]).join("+") || "none";
}

describe("buildFeedbackRelease: every box combination × every score history", () => {
  for (const sc of SCENARIOS) {
    test(sc.name, () => {
      let cases = 0;
      for (const c of COMBOS) {
        for (const teacher of TEACHER_TEXT) {
          for (const overall of OVERALL_TEXT) {
            const ctx = `${sc.name} | ${boxes(c)} | teacher=${JSON.stringify(teacher)} | overall=${overall !== null}`;
            const out = buildFeedbackRelease(c, {
              questions: [
                { rubric: RUBRIC, scores: sc.rows, teacher_feedback: teacher, answer_updated_at: sc.answeredAt ?? HANDED_IN },
              ],
              overall_teacher_feedback: overall,
            });
            // Context rides along, so a failure names its case.
            expect({ ctx, blocks: out.questions[0] }).toEqual({ ctx, blocks: expected(c, sc, teacher) });
            expect({ ctx, overall: out.overall }).toEqual({
              ctx,
              overall:
                c.teacher_feedback && overall
                  ? { kind: "feedback", source: "teacher", label: "Teacher feedback", text: overall, criteria: [] }
                  : null,
            });

            // Invariants that hold whatever the expectation says.
            const json = JSON.stringify(out);
            for (const s of sc.never) expect({ ctx, leaked: json.includes(s) }).toEqual({ ctx, leaked: false });
            const labels = out.questions[0]!.flatMap((b) => ("label" in b ? [b.label] : []));
            for (const l of labels) {
              expect(["Teacher score", "AI score", "Score", "Teacher feedback", "AI feedback"]).toContain(l);
            }
            // D-3 / D-17: "AI score" iff the final is the AI's and the box is ticked.
            expect({ ctx, ai: labels.includes("AI score") }).toEqual({
              ctx,
              ai: sc.final?.method === "ai" && c.ai_score,
            });
            // D-13: a plain "Score" only for an answer key.
            if (labels.includes("Score")) expect(sc.final?.method).toBe("auto");

            // The same case as Doc HTML: D-1's labels survive rendering.
            const contents: ReleaseContents = { ...c, prompt: false, sources: false };
            const html = buildDocHtml({
              studentName: "Ada Fixture",
              assessmentName: "Unit 3",
              draftAsOf: null,
              essays: [{ number: 1, stem: "Argue.", stimulus: null, sources: [], answer: "Words.", feedback: out.questions[0]! }],
              overall: out.overall,
              contents,
            });
            expect({ ctx, bare: /<b>Feedback:|<th>Feedback<|<b>Points:/.test(html) }).toEqual({ ctx, bare: false });
            if (html.includes("<b>Score:</b>")) expect(sc.final?.method).toBe("auto");
            for (const s of sc.never) expect({ ctx, leaked: html.includes(s) }).toEqual({ ctx, leaked: false });
            cases++;
          }
        }
      }
      expect(cases).toBe(32 * 3 * 2);
    });
  }
});

describe("buildFeedbackRelease: edges", () => {
  const ALL: FeedbackContents = {
    teacher_score: true,
    ai_score: true,
    teacher_feedback: true,
    ai_feedback: true,
    rubric_table: true,
  };

  test("blocks keep question order; a question with nothing is an empty list", () => {
    const out = buildFeedbackRelease(ALL, {
      questions: [
        { rubric: RUBRIC, scores: [], teacher_feedback: null, answer_updated_at: HANDED_IN },
        { rubric: null, scores: [row("auto", "final", 1, null)], teacher_feedback: "Fine.", answer_updated_at: HANDED_IN },
      ],
      overall_teacher_feedback: null,
    });
    expect(out.questions[0]).toEqual([]);
    expect(out.questions[1]).toEqual([
      { kind: "score", label: "Score", points: 1, max_points: 4 },
      { kind: "feedback", source: "teacher", label: "Teacher feedback", text: "Fine.", criteria: [] },
    ]);
  });

  test("no rubric: an AI row's criteria fall back to their ids; overall-only AI feedback has no list", () => {
    const out = buildFeedbackRelease({ ...ALL, rubric_table: false }, {
      questions: [
        { rubric: null, scores: [row("ai", "final", 2, aiRationale("NR", "c1", "e1"))], teacher_feedback: null, answer_updated_at: HANDED_IN },
        { rubric: null, scores: [row("ai", "final", 2, { overall_rationale: "Only overall." })], teacher_feedback: null, answer_updated_at: HANDED_IN },
      ],
      overall_teacher_feedback: null,
    });
    expect(out.questions[0]![1]).toMatchObject({
      label: "AI feedback",
      criteria: [
        { criterion: "claim", text: "NR claim comment" },
        { criterion: "evidence", text: "NR evidence comment" },
      ],
    });
    expect(out.questions[1]).toEqual([
      { kind: "score", label: "AI score", points: 2, max_points: 4 },
      { kind: "feedback", source: "ai", label: "AI feedback", text: "Only overall.", criteria: [] },
    ]);
  });

  test("withhold_ai_feedback (short answers, PR #157 review): no AI comments anywhere, the score and levels still print", () => {
    const ai = row("ai", "final", 2, aiRationale("SA", "c1", "e1"));
    const withheld = buildFeedbackRelease(ALL, {
      questions: [{ rubric: RUBRIC, scores: [ai], teacher_feedback: "Mine.", answer_updated_at: HANDED_IN, withhold_ai_feedback: true }],
      overall_teacher_feedback: null,
    }).questions[0]!;
    expect(JSON.stringify(withheld)).not.toContain("SA ");
    expect(withheld.some((b) => b.kind === "feedback" && b.source === "ai")).toBe(false);
    expect(withheld[0]).toEqual({ kind: "score", label: "AI score", points: 2, max_points: 4 });
    const table = withheld.find((b) => b.kind === "rubric_table");
    expect(table).toMatchObject({ columns: { level: true, points: true, ai_feedback: false } });
    expect(withheld.at(-1)).toMatchObject({ source: "teacher", text: "Mine." });
    // The same question without the flag carries the AI's comments.
    const shown = buildFeedbackRelease(ALL, {
      questions: [{ rubric: RUBRIC, scores: [ai], teacher_feedback: null, answer_updated_at: HANDED_IN }],
      overall_teacher_feedback: null,
    }).questions[0]!;
    expect(JSON.stringify(shown)).toContain("SA claim comment");
  });

  test("an AI row with no comments at all prints no AI feedback block", () => {
    const out = buildFeedbackRelease({ ...ALL, ai_score: false, rubric_table: false }, {
      questions: [{ rubric: RUBRIC, scores: [row("ai", "final", 2, { overall_rationale: "  " })], teacher_feedback: null, answer_updated_at: HANDED_IN }],
      overall_teacher_feedback: null,
    });
    expect(out.questions[0]).toEqual([]);
  });

  test("a whitespace-only overall comment is no block", () => {
    const out = buildFeedbackRelease(ALL, { questions: [], overall_teacher_feedback: "  \n " });
    expect(out.overall).toBeNull();
  });
});

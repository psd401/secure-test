// Slice 1 of docs/student-work-export-design.md: the packet's pure rules —
// the URL contract, the anonymous labels (D-1), which score rows print, the
// checkbox lines and the page order. No database; these are the rules the
// rendering test then assumes.
import { describe, expect, test } from "bun:test";
import {
  anonymousLabels,
  choiceCheckboxLines,
  packetOrdering,
  packetHidesAnswers,
  packetPrintsBlocks,
  packetScoreBlocks,
  packetScoresMode,
  packetShowsKey,
  keyCountLine,
  packetScoreHeading,
  parsePacketQuery,
  sectionAnonymousLabels,
  selectPacket,
  selectPacketScores,
  stemExcerpt,
  stripLine,
  studentChoices,
  PACKET_STUDENT_CHOICE_CAP,
  type PacketContents,
  type PacketScoreRow,
} from "../lib/reporting/workPacket";
import { buildFeedbackRelease } from "../lib/reporting/feedbackRelease";

const NO_BOXES: PacketContents = {
  teacher_score: false,
  ai_score: false,
  teacher_feedback: false,
  ai_feedback: false,
  rubric_table: false,
};
import { workPacketHref } from "../lib/reporting/workPacketLinks";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

describe("parsePacketQuery", () => {
  test("an empty query is the documented default: all items, questions on, no scores, named", () => {
    expect(parsePacketQuery({})).toEqual({
      sections: [],
      attempts: [],
      inProgress: false,
      items: null,
      questions: true,
      contents: NO_BOXES,
      teacherCopy: false,
      anon: false,
      doubleSpace: false,
      answers: true,
    });
  });

  // RT D-10 (docs/rich-text-essay-design.md): double-spacing is a
  // teacher-side print choice, default off.
  test("spacing=double turns double-spaced essays on; anything else is single", () => {
    expect(parsePacketQuery({}).doubleSpace).toBe(false);
    expect(parsePacketQuery({ spacing: "double" }).doubleSpace).toBe(true);
    expect(parsePacketQuery({ spacing: " DOUBLE " }).doubleSpace).toBe(true);
    expect(parsePacketQuery({ spacing: "single" }).doubleSpace).toBe(false);
    expect(parsePacketQuery({ spacing: "2" }).doubleSpace).toBe(false);
    expect(parsePacketQuery({ spacing: ["double", "single"] }).doubleSpace).toBe(false);
  });

  // Batch print (docs/batch-print-design.md, D-1): `section` is multi-value
  // now — it replaces the old last-value-wins rule for this parameter.
  test("section is trimmed, blank is absent, and several are all kept in URL order", () => {
    expect(parsePacketQuery({ section: "  English 9 · 3  " }).sections).toEqual(["English 9 · 3"]);
    expect(parsePacketQuery({ section: "   " }).sections).toEqual([]);
    expect(parsePacketQuery({ section: ["Biology", "Algebra"] }).sections).toEqual([
      "Biology",
      "Algebra",
    ]);
    expect(parsePacketQuery({ section: ["Biology", " ", "Biology"] }).sections).toEqual(["Biology"]);
  });

  test("in_progress=1 adds work not handed in; off by default (D-3)", () => {
    expect(parsePacketQuery({}).inProgress).toBe(false);
    expect(parsePacketQuery({ in_progress: "1" }).inProgress).toBe(true);
    expect(parsePacketQuery({ in_progress: "0" }).inProgress).toBe(false);
  });

  // One student's work (2026-09-23): the per-student page's button and the
  // toolbar's picker, whose "Everyone in this section" option submits blank.
  test("attempt is a uuid, case-folded; blank or junk is dropped; several are all kept", () => {
    expect(parsePacketQuery({ attempt: A }).attempts).toEqual([A]);
    expect(parsePacketQuery({ attempt: `  ${A.toUpperCase()} ` }).attempts).toEqual([A]);
    expect(parsePacketQuery({ attempt: "" }).attempts).toEqual([]);
    expect(parsePacketQuery({ attempt: "not-a-uuid" }).attempts).toEqual([]);
    expect(parsePacketQuery({ attempt: [A, B] }).attempts).toEqual([A, B]);
    expect(parsePacketQuery({ attempt: [A, "", A] }).attempts).toEqual([A]);
  });

  test("items is a comma list of uuids; junk is dropped, duplicates collapse, empty = all", () => {
    expect(parsePacketQuery({ items: `${A}, ${B}` }).items).toEqual([A, B]);
    expect(parsePacketQuery({ items: `${A},not-a-uuid,,${A}` }).items).toEqual([A]);
    expect(parsePacketQuery({ items: "nonsense" }).items).toBeNull();
    expect(parsePacketQuery({ items: "" }).items).toBeNull();
    // Case-folded, so a hand-edited URL matches the stored id.
    expect(parsePacketQuery({ items: A.toUpperCase() }).items).toEqual([A]);
  });

  test("items also accepts one value per parameter — the toolbar's checklist, one checkbox per item, all named `items`", () => {
    expect(parsePacketQuery({ items: [A, B] }).items).toEqual([A, B]);
    // Duplicates and junk drop the same way as the comma-list form.
    expect(parsePacketQuery({ items: [A, "not-a-uuid", A] }).items).toEqual([A]);
  });

  test("questions=0 then questions=1 (the hidden-field-then-checkbox trick) reads as ON — the LAST value", () => {
    expect(parsePacketQuery({ questions: ["0", "1"] }).questions).toBe(true);
    expect(parsePacketQuery({ questions: ["1", "0"] }).questions).toBe(false);
  });

  test("questions defaults on and only 0 / false / no turn it off", () => {
    expect(parsePacketQuery({}).questions).toBe(true);
    expect(parsePacketQuery({ questions: "0" }).questions).toBe(false);
    expect(parsePacketQuery({ questions: "false" }).questions).toBe(false);
    expect(parsePacketQuery({ questions: "1" }).questions).toBe(true);
    expect(parsePacketQuery({ questions: "yes" }).questions).toBe(true);
  });

  test("anon defaults off and 1 / true turn it on", () => {
    expect(parsePacketQuery({}).anon).toBe(false);
    expect(parsePacketQuery({ anon: "1" }).anon).toBe(true);
    expect(parsePacketQuery({ anon: "true" }).anon).toBe(true);
    expect(parsePacketQuery({ anon: "0" }).anon).toBe(false);
  });

  // FR slice 4: a bookmark from before the boxes maps onto the two SCORE
  // boxes only (docs/feedback-release-design.md §Contents model).
  test("legacy scores= maps onto the two score boxes; anything else is none rather than a throw", () => {
    const only = (over: Partial<PacketContents>) => ({ ...NO_BOXES, ...over });
    expect(parsePacketQuery({ scores: "teacher" }).contents).toEqual(only({ teacher_score: true }));
    expect(parsePacketQuery({ scores: "ai" }).contents).toEqual(only({ ai_score: true }));
    expect(parsePacketQuery({ scores: "BOTH" }).contents).toEqual(
      only({ teacher_score: true, ai_score: true }),
    );
    expect(parsePacketQuery({ scores: "none" }).contents).toEqual(NO_BOXES);
    expect(parsePacketQuery({ scores: "everything" }).contents).toEqual(NO_BOXES);
    expect(parsePacketQuery({ scores: "" }).contents).toEqual(NO_BOXES);
    // A legacy URL is the student copy (D-16: teacher copy is opt-in).
    expect(parsePacketQuery({ scores: "both" }).teacherCopy).toBe(false);
  });

  test("each box is its own parameter, off when absent, last value wins", () => {
    const q = parsePacketQuery({ ai_feedback: "1", rubric_table: ["0", "1"], teacher_feedback: "0" });
    expect(q.contents).toEqual({ ...NO_BOXES, ai_feedback: true, rubric_table: true });
    expect(parsePacketQuery({ teacher_score: "1", ai_score: "1" }).contents).toEqual({
      ...NO_BOXES,
      teacher_score: true,
      ai_score: true,
    });
  });

  // Trap: a re-submitted form, or a hand-edited link, that still carries
  // scores= must not bring the legacy mapping back beside the boxes.
  test("any box in the URL beats a leftover scores=", () => {
    expect(parsePacketQuery({ scores: "both", ai_feedback: "1" }).contents).toEqual({
      ...NO_BOXES,
      ai_feedback: true,
    });
    // Even a box that reads as off counts as "the boxes are in charge".
    expect(parsePacketQuery({ scores: "both", teacher_score: "0" }).contents).toEqual(NO_BOXES);
  });

  test("teacher_copy=1 turns the teacher copy on (D-16); off by default", () => {
    expect(parsePacketQuery({}).teacherCopy).toBe(false);
    expect(parsePacketQuery({ teacher_copy: "1" }).teacherCopy).toBe(true);
    expect(parsePacketQuery({ teacher_copy: "0" }).teacherCopy).toBe(false);
  });

  test("the key follows the Teacher score box only (W-1); the boxes map back to a mode", () => {
    expect(packetShowsKey({ ...NO_BOXES, teacher_score: true })).toBe(true);
    expect(packetShowsKey({ ...NO_BOXES, ai_score: true, teacher_feedback: true })).toBe(false);
    expect(packetScoresMode(NO_BOXES)).toBe("none");
    expect(packetScoresMode({ ...NO_BOXES, teacher_score: true })).toBe("teacher");
    expect(packetScoresMode({ ...NO_BOXES, ai_score: true })).toBe("ai");
    expect(packetScoresMode({ ...NO_BOXES, teacher_score: true, ai_score: true })).toBe("both");
  });
});

describe("answers=0 — feedback without the answer (U-23)", () => {
  test("defaults on; 0 / false / no turn it off; last value wins", () => {
    expect(parsePacketQuery({}).answers).toBe(true);
    expect(parsePacketQuery({ answers: "0" }).answers).toBe(false);
    expect(parsePacketQuery({ answers: "false" }).answers).toBe(false);
    expect(parsePacketQuery({ answers: "1" }).answers).toBe(true);
    expect(parsePacketQuery({ answers: ["0", "1"] }).answers).toBe(true);
    expect(parsePacketQuery({ answers: "" }).answers).toBe(true);
  });

  test("answers are hidden only when a block can print (decision 1.5)", () => {
    expect(packetHidesAnswers(parsePacketQuery({ answers: "0", scores: "none" }))).toBe(false);
    expect(packetHidesAnswers(parsePacketQuery({ answers: "0" }))).toBe(false);
    for (const scores of ["teacher", "ai", "both"]) {
      expect(packetHidesAnswers(parsePacketQuery({ answers: "0", scores }))).toBe(true);
      expect(packetHidesAnswers(parsePacketQuery({ scores }))).toBe(false);
    }
  });

  // FR D-11: a feedback-only sheet — any box counts, not just a score.
  test("any one box is enough to leave the answers out", () => {
    for (const key of ["teacher_score", "ai_score", "teacher_feedback", "ai_feedback", "rubric_table"]) {
      const q = parsePacketQuery({ answers: "0", [key]: "1" });
      expect(packetPrintsBlocks(q.contents)).toBe(true);
      expect(packetHidesAnswers(q)).toBe(true);
    }
    expect(packetHidesAnswers(parsePacketQuery({ answers: "0", teacher_copy: "1" }))).toBe(false);
  });
});

describe("anonymousLabels (D-1)", () => {
  test("labels follow the lexical order of the attempt ids, zero-padded to width 2", () => {
    const labels = anonymousLabels([B, A]);
    expect(labels.get(A)).toBe("Student 01");
    expect(labels.get(B)).toBe("Student 02");
  });

  test("the same set of attempts gives the same labels whatever order they arrive in", () => {
    const ids = [A, B, "33333333-3333-4333-8333-333333333333"];
    const one = anonymousLabels(ids);
    const two = anonymousLabels([...ids].reverse());
    for (const id of ids) expect(two.get(id)).toBe(one.get(id)!);
  });

  test("width grows with the count, and never shrinks below two", () => {
    const one = anonymousLabels([A]);
    expect(one.get(A)).toBe("Student 01");
    const hundred = anonymousLabels(
      Array.from({ length: 100 }, (_, i) => `id-${String(i).padStart(3, "0")}`),
    );
    expect(hundred.get("id-000")).toBe("Student 001");
    expect(hundred.get("id-099")).toBe("Student 100");
  });

  test("a repeated id is one label, not two", () => {
    expect(anonymousLabels([A, A]).size).toBe(1);
  });
});

describe("selectPacketScores", () => {
  const row = (over: Partial<PacketScoreRow>): PacketScoreRow => ({
    method: "human",
    status: "final",
    reviewed_by_sub: null,
    points: 3,
    max_points: 4,
    rationale: null,
    created_at: new Date("2026-09-01T00:00:00Z"),
    ...over,
  });

  const human = row({ method: "human", status: "final", points: 3 });
  const auto = row({ method: "auto", status: "final", points: 1, max_points: 1 });
  const aiOld = row({
    method: "ai",
    status: "proposed",
    points: 2,
    created_at: new Date("2026-09-01T00:00:00Z"),
  });
  const aiNew = row({
    method: "ai",
    status: "proposed",
    points: 4,
    created_at: new Date("2026-09-05T00:00:00Z"),
  });
  const research = row({
    method: "ai",
    status: "research",
    points: 0,
    created_at: new Date("2026-09-09T00:00:00Z"),
  });

  test("none selects nothing at all, whatever rows exist", () => {
    expect(selectPacketScores("none", [human, aiNew])).toEqual({ teacher: null, ai: null });
  });

  test("teacher is the human final; ai is the latest ai row", () => {
    const both = selectPacketScores("both", [aiOld, human, aiNew]);
    expect(both.teacher).toBe(human);
    expect(both.ai).toBe(aiNew);
  });

  test("an auto final counts as the teacher's — their key made it", () => {
    expect(selectPacketScores("teacher", [auto]).teacher).toBe(auto);
    expect(packetScoreHeading("teacher", auto)).toBe("Auto score (your answer key)");
  });

  test("a research row is never chosen, even when it is the newest ai row", () => {
    const both = selectPacketScores("both", [aiOld, research]);
    expect(both.ai).toBe(aiOld);
    expect(selectPacketScores("ai", [research]).ai).toBeNull();
  });

  test("teacher and ai modes each drop the other side", () => {
    expect(selectPacketScores("teacher", [human, aiNew]).ai).toBeNull();
    expect(selectPacketScores("ai", [human, aiNew]).teacher).toBeNull();
  });

  test("nothing of the chosen kind is null, which the heading turns into the placeholder", () => {
    const both = selectPacketScores("both", []);
    expect(both.teacher).toBeNull();
    expect(both.ai).toBeNull();
    expect(packetScoreHeading("teacher", null)).toBe("No teacher score");
    expect(packetScoreHeading("ai", null)).toBe("No AI score");
  });

  test("a final ai row says whether it was reviewed, a pending one is a proposal", () => {
    expect(packetScoreHeading("ai", aiNew)).toBe("AI proposal");
    expect(
      packetScoreHeading("ai", row({ method: "ai", status: "final", reviewed_by_sub: "t1" })),
    ).toBe("AI score (approved)");
    // Hybrid transparency D-1: finalized by the scorer, no teacher reviewed it.
    expect(packetScoreHeading("ai", row({ method: "ai", status: "final" }))).toBe(
      "AI score (not reviewed)",
    );
    expect(packetScoreHeading("teacher", human)).toBe("Teacher score");
  });
});

// FR slice 4: which score blocks one question prints — the student copy
// through the R-3 builder (D-3, D-13, D-17), the teacher copy as before (D-16).
describe("packetScoreBlocks", () => {
  const row = (over: Partial<PacketScoreRow>): PacketScoreRow => ({
    method: "human",
    status: "final",
    reviewed_by_sub: null,
    points: 3,
    max_points: 4,
    rationale: null,
    created_at: new Date("2026-09-01T00:00:00Z"),
    ...over,
  });
  const both: PacketContents = { ...NO_BOXES, teacher_score: true, ai_score: true };
  const student = (contents: PacketContents, rows: PacketScoreRow[]) =>
    packetScoreBlocks(
      contents,
      false,
      rows,
      buildFeedbackRelease(contents, {
        questions: [{ rubric: null, scores: rows, teacher_feedback: null, answer_updated_at: null }],
        overall_teacher_feedback: null,
      }).questions[0]!,
      null,
    );
  const teacher = (contents: PacketContents, rows: PacketScoreRow[]) =>
    packetScoreBlocks(contents, true, rows, [], null);

  const humanFinal = row({ method: "human", status: "final", points: 3 });
  const aiProposal = row({ method: "ai", status: "proposed", points: 2, created_at: new Date("2026-09-02T00:00:00Z") });

  test("student copy: a human final with an AI proposal beside it — the AI score never prints (D-3)", () => {
    expect(student(both, [humanFinal, aiProposal])).toEqual([
      { label: "Teacher score", row: { points: 3, max_points: 4 }, criteria: [] },
    ]);
    // AI score alone: nothing at all, and no "No AI score" placeholder.
    expect(student({ ...NO_BOXES, ai_score: true }, [humanFinal, aiProposal])).toEqual([]);
  });

  test("student copy: an approved AI final and an unreviewed Hybrid final both print as AI score (D-17)", () => {
    const approved = row({ method: "ai", status: "final", reviewed_by_sub: "t1", points: 4 });
    const hybrid = row({ method: "ai", status: "final", reviewed_by_sub: null, points: 1 });
    for (const final of [approved, hybrid]) {
      expect(student({ ...NO_BOXES, ai_score: true }, [aiProposal, final])).toEqual([
        { label: "AI score", row: { points: final.points, max_points: 4 }, criteria: [] },
      ]);
      expect(student({ ...NO_BOXES, teacher_score: true }, [final])).toEqual([]);
    }
  });

  test("student copy: an answer key's score is a plain Score under either box (D-13)", () => {
    const auto = row({ method: "auto", status: "final", points: 1, max_points: 1 });
    for (const contents of [
      { ...NO_BOXES, teacher_score: true },
      { ...NO_BOXES, ai_score: true },
      both,
    ]) {
      expect(student(contents, [auto])).toEqual([
        { label: "Score", row: { points: 1, max_points: 1 }, criteria: [] },
      ]);
    }
    expect(student(NO_BOXES, [auto])).toEqual([]);
  });

  test("student copy: superseded and research rows never print; no final is no block", () => {
    expect(student(both, [row({ status: "superseded" }), row({ method: "ai", status: "research" })])).toEqual([]);
    expect(student(both, [aiProposal])).toEqual([]);
  });

  test("teacher copy keeps today's blocks: the proposal, its heading, the placeholders (D-16)", () => {
    expect(teacher(both, [humanFinal, aiProposal])).toEqual([
      { label: "Teacher score", row: humanFinal, criteria: [] },
      { label: "AI proposal", row: aiProposal, criteria: [] },
    ]);
    expect(teacher(both, [])).toEqual([
      { label: "No teacher score", row: null, criteria: [] },
      { label: "No AI score", row: null, criteria: [] },
    ]);
    expect(teacher({ ...NO_BOXES, ai_score: true }, [humanFinal, aiProposal])).toEqual([
      { label: "AI proposal", row: aiProposal, criteria: [] },
    ]);
    // Feedback boxes alone print no score block in either copy.
    expect(teacher({ ...NO_BOXES, ai_feedback: true }, [humanFinal, aiProposal])).toEqual([]);
    // The second lock still holds in the teacher copy.
    expect(teacher(both, [row({ method: "ai", status: "superseded" })])).toEqual([
      { label: "No teacher score", row: null, criteria: [] },
      { label: "No AI score", row: null, criteria: [] },
    ]);
  });

  test("teacher copy + rubric table: each block carries its OWN row's levels and points, no comments (D-16, D-1)", () => {
    const rationale = (level: string, points: number, why: string) => ({
      criterion_scores: [{ criterion_id: "focus", level_id: level, points, rationale: why }],
    });
    const human = row({ method: "human", status: "final", points: 3, rationale: rationale("hi", 3, "T-WHY") });
    const proposal = row({
      method: "ai",
      status: "proposed",
      points: 2,
      rationale: rationale("lo", 2, "AI-WHY"),
      created_at: new Date("2026-09-02T00:00:00Z"),
    });
    const withTable = { ...both, rubric_table: true };
    const blocks = teacher(withTable, [human, proposal]);
    expect(blocks.map((b) => [b.label, b.criteria])).toEqual([
      ["Teacher score", [{ criterion: "focus", level: "hi", points: 3 }]],
      ["AI proposal", [{ criterion: "focus", level: "lo", points: 2 }]],
    ]);
    expect(JSON.stringify(blocks.map((b) => b.criteria))).not.toContain("WHY");
    // Box off: no levels in the teacher copy either (R-2).
    expect(teacher(both, [human, proposal]).every((b) => b.criteria.length === 0)).toBe(true);
    // Student copy: never — its table is the builder's, final row only (D-3).
    expect(student(withTable, [human, proposal]).every((b) => b.criteria.length === 0)).toBe(true);
  });
});

describe("choiceCheckboxLines", () => {
  const mc = {
    type: "multiple_choice_multi",
    choices: [
      { id: "a", text: "Copper" },
      { id: "b", text: "Neon" },
      { id: "c", text: "Iron" },
    ],
  };

  test("every choice comes back in item order, with only the chosen ones selected", () => {
    const lines = choiceCheckboxLines(mc, {
      type: "multiple_choice_multi",
      choice_ids: ["c", "a"],
    });
    expect(lines.map((l) => l.text)).toEqual(["Copper", "Neon", "Iron"]);
    expect(lines.map((l) => l.selected)).toEqual([true, false, true]);
  });

  test("a single-choice response marks its one choice", () => {
    const lines = choiceCheckboxLines(
      { ...mc, type: "multiple_choice_single" },
      { type: "multiple_choice_single", choice_id: "b" },
    );
    expect(lines.map((l) => l.selected)).toEqual([false, true, false]);
  });

  test("no response marks nothing — every box prints empty", () => {
    expect(choiceCheckboxLines(mc, null).every((l) => !l.selected)).toBe(true);
  });

  test("a non-MC item, and an MC item with no choices, have no checkbox lines", () => {
    expect(choiceCheckboxLines({ type: "essay" }, { type: "essay", text: "x" })).toEqual([]);
    expect(choiceCheckboxLines({ type: "multiple_choice_single" }, null)).toEqual([]);
  });
});

describe("packetOrdering", () => {
  const rows = [
    { attempt_id: "b", student: { name: "Ada Zeller" } },
    { attempt_id: "c", student: { name: "Fixture, Ada" } },
    { attempt_id: "a", student: { name: "Ben Fixture" } },
  ];

  test("named: last name, then first name, then attempt id", () => {
    expect(packetOrdering(rows, false).map((r) => r.attempt_id)).toEqual(["c", "a", "b"]);
  });

  test("a roster 'Last, First' name sorts with a hand-entered 'First Last' one", () => {
    const sorted = packetOrdering(rows, false);
    expect(sorted[0]!.student.name).toBe("Fixture, Ada");
    expect(sorted[1]!.student.name).toBe("Ben Fixture");
  });

  test("anonymous: attempt id order, which is label order", () => {
    expect(packetOrdering(rows, true).map((r) => r.attempt_id)).toEqual(["a", "b", "c"]);
  });

  test("the caller's array is not reordered in place", () => {
    const original = rows.map((r) => r.attempt_id);
    packetOrdering(rows, true);
    expect(rows.map((r) => r.attempt_id)).toEqual(original);
  });

  test("an unknown name sorts first rather than throwing", () => {
    const withBlank = [...rows, { attempt_id: "d", student: { name: "" } }];
    expect(packetOrdering(withBlank, false)[0]!.attempt_id).toBe("d");
  });
});

describe("stemExcerpt — the toolbar's item-checklist label", () => {
  test("plain text under the limit is unchanged", () => {
    expect(stemExcerpt("Name the capital")).toBe("Name the capital");
  });

  test("math markers, image refs and light markdown are stripped", () => {
    expect(stemExcerpt("What is $x^2$ when *x* = 3?")).toBe("What is x^2 when x = 3?");
    expect(stemExcerpt("See ![chart](asset:11111111-1111-4111-8111-111111111111) above")).toBe(
      "See above",
    );
    expect(stemExcerpt("# Heading\n_emph_ `code` [link]")).toBe("Heading emph code link");
  });

  test("LaTeX commands become symbols or vanish, braces go with them (2026-09-14)", () => {
    expect(stemExcerpt("What is $6 \\times 7$? Type the number.")).toBe(
      "What is 6 × 7? Type the number.",
    );
    expect(stemExcerpt("$x \\le 3$ and $\\sqrt{2}$, $\\pi$")).toBe("x ≤ 3 and √2, π");
    // `_` is markdown emphasis to this stripper; `\mathrm` / `\frac` vanish.
    expect(stemExcerpt("$\\mathrm{H_2O}$ is $\\frac{1}{2}$")).toBe("H2O is 12");
  });

  test("longer than 60 characters is cut with an ellipsis, never mid-run over the limit", () => {
    const long = "This stem goes on for quite a while past the sixty character mark, well past it";
    const excerpt = stemExcerpt(long);
    expect(excerpt.length).toBeLessThanOrEqual(60);
    expect(excerpt.endsWith("…")).toBe(true);
  });

  test("blank or whitespace-only stems give an empty string", () => {
    expect(stemExcerpt("")).toBe("");
    expect(stemExcerpt("   ")).toBe("");
  });
});

// Batch print slice 1 (docs/batch-print-design.md, D-1..D-4, 8.1, 8.2).
describe("selectPacket", () => {
  const C = "33333333-3333-4333-8333-333333333333";
  const D = "44444444-4444-4444-8444-444444444444";
  const E = "55555555-5555-4555-8555-555555555555";
  type Row = {
    attempt_id: string;
    status: "submitted" | "in_progress";
    student: { name: string; section: string | null };
  };
  const rows: Row[] = [
    { attempt_id: A, status: "submitted", student: { name: "Zed Young", section: "P3" } },
    { attempt_id: B, status: "submitted", student: { name: "Amy Able", section: "P3" } },
    { attempt_id: C, status: "in_progress", student: { name: "Bo Bell", section: "P3" } },
    { attempt_id: D, status: "submitted", student: { name: "Cy Cole", section: "P1" } },
    { attempt_id: E, status: "submitted", student: { name: "Di Dunn", section: null } },
  ];
  const q = (over: Partial<{ sections: string[]; attempts: string[]; inProgress: boolean; anon: boolean }>) => ({
    sections: [],
    attempts: [],
    inProgress: false,
    anon: false,
    ...over,
  });

  test("nothing chosen is the chooser; a foreign attempt is not found", () => {
    expect(selectPacket(rows, q({})).kind).toBe("chooser");
    expect(selectPacket(rows, q({ attempts: ["66666666-6666-4666-8666-666666666666"] })).kind).toBe(
      "not_found",
    );
  });

  test("sections print alphabetically, each by name, handed-in only by default", () => {
    const sel = selectPacket(rows, q({ sections: ["P3", "P1"] }));
    if (sel.kind !== "batch") throw new Error(sel.kind);
    expect(sel.runs.map((r) => r.section)).toEqual(["P1", "P3"]);
    expect(sel.runs[1]!.rows.map((r) => r.attempt_id)).toEqual([B, A]);
    expect(sel.runs.every((r) => !r.chosen)).toBe(true);
  });

  test("in_progress adds the work not handed in to a section run (D-3)", () => {
    const sel = selectPacket(rows, q({ sections: ["P3"], inProgress: true }));
    if (sel.kind !== "batch") throw new Error(sel.kind);
    expect(sel.runs[0]!.rows.map((r) => r.attempt_id)).toEqual([B, C, A]);
  });

  test("one chosen student is single mode, in progress or not (8.1)", () => {
    const sel = selectPacket(rows, q({ attempts: [C] }));
    expect(sel.kind).toBe("single");
  });

  test("chosen students outside the sections are ignored; none left = the sections in full", () => {
    const narrowed = selectPacket(rows, q({ sections: ["P3"], attempts: [A, C, D] }));
    if (narrowed.kind !== "batch") throw new Error(narrowed.kind);
    expect(narrowed.runs).toHaveLength(1);
    expect(narrowed.runs[0]!.chosen).toBe(true);
    expect(narrowed.runs[0]!.rows.map((r) => r.attempt_id)).toEqual([C, A]);

    const switched = selectPacket(rows, q({ sections: ["P1"], attempts: [A] }));
    if (switched.kind !== "batch") throw new Error(switched.kind);
    expect(switched.runs[0]!.section).toBe("P1");
    expect(switched.runs[0]!.chosen).toBe(false);
  });

  test("several chosen students with no section group by their own sections, none last", () => {
    const sel = selectPacket(rows, q({ attempts: [E, A, D] }));
    if (sel.kind !== "batch") throw new Error(sel.kind);
    expect(sel.runs.map((r) => r.section)).toEqual(["P1", "P3", null]);
  });

  test("labels are numbered per section over its handed-in work; in progress reads In progress n (D-2)", () => {
    const p3 = sectionAnonymousLabels(rows, "P3");
    expect([...new Set([p3.get(A), p3.get(B)])].sort()).toEqual(["Student 01", "Student 02"]);
    expect(p3.get(C)).toBe("In progress 1");
    expect(sectionAnonymousLabels(rows, "P1").get(D)).toBe("Student 01");
  });

  test("strip and key-page lines", () => {
    const run = { section: "P3", rows: rows.slice(0, 3), chosen: false };
    expect(stripLine({ ...run, rows: rows.slice(0, 2) }, 30, false)).toBe("2 of 30 students in P3 handed in");
    expect(stripLine(run, 30, true)).toBe("2 of 30 students in P3 handed in · 1 not handed in");
    expect(stripLine({ ...run, rows: rows.slice(0, 2) }, null, false)).toBe("2 handed in");
    expect(stripLine({ ...run, rows: rows.slice(0, 2) }, null, true)).toBe("P3: 2 handed in");
    expect(stripLine({ ...run, chosen: true }, null, true)).toBe("3 students chosen in P3");
    expect(keyCountLine({ ...run, rows: rows.slice(0, 2) })).toBe("2 handed-in attempts");
    expect(keyCountLine(run)).toBe("3 attempts, 1 not handed in");
    expect(keyCountLine({ ...run, chosen: true })).toBe("3 chosen attempts");
  });
});

// Batch print slice 2: the toolbar's student boxes and the cap (9.1).
describe("studentChoices", () => {
  type Row = {
    attempt_id: string;
    status: "submitted" | "in_progress";
    student: { name: string; section: string | null };
  };
  const C = "33333333-3333-4333-8333-333333333333";
  const rows: Row[] = [
    { attempt_id: A, status: "submitted", student: { name: "Zed Young", section: "P3" } },
    { attempt_id: B, status: "in_progress", student: { name: "Amy Able", section: "P3" } },
    { attempt_id: C, status: "submitted", student: { name: "Cy Cole", section: "P1" } },
  ];

  test("one group per ticked section, alphabetical, handed in or not, by name", () => {
    const choices = studentChoices(rows, ["P3", "P1"], false);
    if (choices.tooMany) throw new Error("tooMany");
    expect(choices.groups.map((g) => g.section)).toEqual(["P1", "P3"]);
    expect(choices.groups[1]!.rows.map((r) => r.attempt_id)).toEqual([B, A]);
  });

  test("above the cap: no list, the count instead", () => {
    expect(studentChoices(rows, ["P3", "P1"], false, 2)).toEqual({ tooMany: true, count: 3 });
    expect(studentChoices(rows, ["P3"], false, 2).tooMany).toBe(false);
    expect(PACKET_STUDENT_CHOICE_CAP).toBe(200);
  });
});

// Batch print 9.3: the results page's button carries its section filter.
describe("workPacketHref", () => {
  test("a section filter lands on that section's packet; all or none lands on the chooser", () => {
    expect(workPacketHref("a1", "")).toBe("/dashboard/a1/results/work");
    expect(workPacketHref("a1", "__none__")).toBe("/dashboard/a1/results/work");
    expect(workPacketHref("a1", "Period 2")).toBe("/dashboard/a1/results/work?section=Period%202");
  });
});

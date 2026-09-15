// Slice 1 of docs/student-work-export-design.md: the packet's pure rules —
// the URL contract, the anonymous labels (D-1), which score rows print, the
// checkbox lines and the page order. No database; these are the rules the
// rendering test then assumes.
import { describe, expect, test } from "bun:test";
import {
  anonymousLabels,
  choiceCheckboxLines,
  packetOrdering,
  packetScoreHeading,
  parsePacketQuery,
  selectPacketScores,
  type PacketScoreRow,
} from "../lib/reporting/workPacket";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

describe("parsePacketQuery", () => {
  test("an empty query is the documented default: all items, questions on, no scores, named", () => {
    expect(parsePacketQuery({})).toEqual({
      section: null,
      items: null,
      questions: true,
      scores: "none",
      anon: false,
    });
  });

  test("section is trimmed, and blank is the same as absent", () => {
    expect(parsePacketQuery({ section: "  English 9 · 3  " }).section).toBe("English 9 · 3");
    expect(parsePacketQuery({ section: "   " }).section).toBeNull();
    // Next hands a repeated parameter as an array; the first wins.
    expect(parsePacketQuery({ section: ["Biology", "Algebra"] }).section).toBe("Biology");
  });

  test("items is a comma list of uuids; junk is dropped, duplicates collapse, empty = all", () => {
    expect(parsePacketQuery({ items: `${A}, ${B}` }).items).toEqual([A, B]);
    expect(parsePacketQuery({ items: `${A},not-a-uuid,,${A}` }).items).toEqual([A]);
    expect(parsePacketQuery({ items: "nonsense" }).items).toBeNull();
    expect(parsePacketQuery({ items: "" }).items).toBeNull();
    // Case-folded, so a hand-edited URL matches the stored id.
    expect(parsePacketQuery({ items: A.toUpperCase() }).items).toEqual([A]);
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

  test("scores takes the four values, and anything else is none rather than a throw", () => {
    expect(parsePacketQuery({ scores: "teacher" }).scores).toBe("teacher");
    expect(parsePacketQuery({ scores: "ai" }).scores).toBe("ai");
    expect(parsePacketQuery({ scores: "BOTH" }).scores).toBe("both");
    expect(parsePacketQuery({ scores: "none" }).scores).toBe("none");
    expect(parsePacketQuery({ scores: "everything" }).scores).toBe("none");
    expect(parsePacketQuery({ scores: "" }).scores).toBe("none");
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

  test("an accepted ai row is headed as a score, a pending one as a proposal", () => {
    expect(packetScoreHeading("ai", aiNew)).toBe("AI proposal");
    expect(packetScoreHeading("ai", row({ method: "ai", status: "final" }))).toBe(
      "AI score (accepted)",
    );
    expect(packetScoreHeading("teacher", human)).toBe("Teacher score");
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

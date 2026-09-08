// R2 print report (docs/reporting-design.md): the two pure helpers behind the
// print view — the integrity formatter and the page-one summary. No DB.
import { describe, expect, test } from "bun:test";
import {
  NO_EVENTS,
  countByKind,
  formatIntegrityLine,
  integrityPhrases,
} from "../lib/reporting/printIntegrity";
import {
  itemTypeLabel,
  summarizeCohort,
  summarizeItems,
} from "../lib/reporting/printSummary";
import type { ResultsCell, ResultsRow } from "../lib/scoring/results";

describe("formatIntegrityLine", () => {
  test("no events reads as words, not an empty line", () => {
    expect(formatIntegrityLine([])).toBe(NO_EVENTS);
    expect(NO_EVENTS).toBe("No integrity events");
  });

  test("one event of a kind is singular, more than one carries the count", () => {
    expect(formatIntegrityLine([{ kind: "focus_loss" }])).toBe("Left the test window");
    expect(
      formatIntegrityLine([{ kind: "focus_loss" }, { kind: "focus_loss" }]),
    ).toBe("Left the test window 2 times");
  });

  test("every kind the schema allows has plain words", () => {
    const kinds = [
      "quit",
      "emergency_exit",
      "focus_loss",
      "focus_regained",
      "lockdown_begin",
      "lockdown_end",
      "lockdown_failed",
      "lockdown_interrupted",
      "client_error",
    ];
    for (const kind of kinds) {
      const line = formatIntegrityLine([{ kind }]);
      // Plain words: never the raw snake_case kind.
      expect(line).not.toContain("_");
      expect(line.length).toBeGreaterThan(0);
    }
    expect(formatIntegrityLine([{ kind: "lockdown_end" }])).toBe(
      "Secure session ended by the student",
    );
    expect(formatIntegrityLine([{ kind: "emergency_exit" }])).toBe(
      "Used the emergency exit",
    );
  });

  test("kinds read in a fixed order, joined, whatever order they arrived in", () => {
    const line = formatIntegrityLine([
      { kind: "lockdown_end" },
      { kind: "focus_loss" },
      { kind: "focus_loss" },
      { kind: "lockdown_begin" },
    ]);
    expect(line).toBe(
      "Secure session started · Left the test window 2 times · Secure session ended by the student",
    );
  });

  test("an unknown kind still shows, last, under its own name", () => {
    const phrases = integrityPhrases([{ kind: "quit" }, { kind: "future_kind" }]);
    expect(phrases).toEqual(["Quit the test", "future_kind"]);
  });

  test("countByKind counts", () => {
    const counts = countByKind([
      { kind: "focus_loss" },
      { kind: "focus_loss" },
      { kind: "quit" },
    ]);
    expect(counts.get("focus_loss")).toBe(2);
    expect(counts.get("quit")).toBe(1);
    expect(counts.get("nope")).toBeUndefined();
  });
});

const ITEMS = [
  { id: "i1", position: 0, type: "multiple_choice_single", stem: "MC" },
  { id: "i2", position: 1, type: "essay", stem: "Essay" },
  { id: "i3", position: 2, type: "short_text", stem: "Short" },
];

function cell(status: ResultsCell["status"], points?: number, max?: number): ResultsCell {
  return {
    status,
    points: points ?? null,
    max_points: max ?? null,
  };
}

function row(overrides: Partial<ResultsRow> & Pick<ResultsRow, "attempt_id" | "cells">): ResultsRow {
  return {
    student: {
      ssid: null,
      name: "Student",
      student_number: null,
      email: null,
      section: null,
    },
    submitted_at: null,
    total_points: 0,
    scored_max_points: 0,
    unscored_count: 0,
    max_points: 6,
    percent: null,
    ...overrides,
  };
}

describe("summarizeItems", () => {
  // Q1 (max 1): 1 and 0 → mean 0.5, p 50%.
  // Q2 (max 4): one final 3, one proposal (never counted) → mean 3, p 75%.
  // Q3: nothing final → all null.
  const rows = [
    row({
      attempt_id: "a1",
      cells: [cell("final", 1, 1), cell("final", 3, 4), cell("unscored")],
    }),
    row({
      attempt_id: "a2",
      cells: [cell("final", 0, 1), cell("proposed_pending"), cell("no_response")],
    }),
  ];

  test("mean and p-value over FINAL cells only", () => {
    const stats = summarizeItems(ITEMS, rows);
    expect(stats[0]).toMatchObject({
      position: 0,
      type: "multiple_choice_single",
      max_points: 1,
      scored_count: 2,
      mean_points: 0.5,
      p_value: 50,
    });
    expect(stats[1]).toMatchObject({
      max_points: 4,
      scored_count: 1,
      mean_points: 3,
      p_value: 75,
    });
    expect(stats[2]).toMatchObject({
      max_points: null,
      scored_count: 0,
      mean_points: null,
      p_value: null,
    });
  });

  test("no rows at all leaves every item blank rather than 0%", () => {
    const stats = summarizeItems(ITEMS, []);
    expect(stats.every((s) => s.mean_points === null && s.p_value === null)).toBe(true);
  });
});

describe("summarizeCohort", () => {
  const complete1 = row({
    attempt_id: "a1",
    cells: [],
    total_points: 5,
    unscored_count: 0,
    percent: 83,
    submitted_at: "2026-09-03T17:00:00.000Z",
  });
  const complete2 = row({
    attempt_id: "a2",
    cells: [],
    total_points: 4,
    unscored_count: 0,
    percent: 67,
    submitted_at: "2026-09-04T18:30:00.000Z",
  });
  const incomplete = row({
    attempt_id: "a3",
    cells: [],
    total_points: 1,
    unscored_count: 2,
    percent: null,
    submitted_at: "2026-09-02T16:00:00.000Z",
  });

  test("means are over complete rows only; the range spans every row", () => {
    const summary = summarizeCohort([complete1, complete2, incomplete]);
    expect(summary.handed_in).toBe(3);
    expect(summary.complete_count).toBe(2);
    expect(summary.incomplete_count).toBe(1);
    expect(summary.max_points).toBe(6);
    expect(summary.mean_total).toBe(4.5); // (5 + 4) / 2 — the 1 is excluded
    expect(summary.mean_percent).toBe(75); // 4.5 / 6
    expect(summary.first_submitted).toBe("2026-09-02T16:00:00.000Z");
    expect(summary.last_submitted).toBe("2026-09-04T18:30:00.000Z");
  });

  test("nothing complete leaves the means blank, not zero", () => {
    const summary = summarizeCohort([incomplete]);
    expect(summary.mean_total).toBeNull();
    expect(summary.mean_percent).toBeNull();
    expect(summary.incomplete_count).toBe(1);
  });

  test("no rows at all", () => {
    const summary = summarizeCohort([]);
    expect(summary).toMatchObject({
      handed_in: 0,
      complete_count: 0,
      max_points: null,
      mean_total: null,
      mean_percent: null,
      first_submitted: null,
      last_submitted: null,
    });
  });
});

describe("itemTypeLabel", () => {
  test("teacher wording for the known types, de-underscored otherwise", () => {
    expect(itemTypeLabel("multiple_choice_single")).toBe("Multiple choice");
    expect(itemTypeLabel("drawing_upload")).toBe("Drawing");
    expect(itemTypeLabel("table")).toBe("Table");
    expect(itemTypeLabel("some_new_type")).toBe("some new type");
  });
});

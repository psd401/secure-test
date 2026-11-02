// Roadmap U-25 slice 3b (docs/bulk-pass-back-and-corrections-design.md,
// D-21…D-27): the marks and locks rule, the delivery gate and the write
// guard, as pure functions. The wire and the routes are in delivery-api.test.ts.
import { describe, expect, test } from "bun:test";
import { correctionsFromRound, markFor } from "../lib/feedback/correctionMarks";
import {
  MIN_RENDERER_VERSION_FOR_CORRECTIONS,
  correctionsDeliverable,
} from "../lib/items/clientSupport";
import { refuseIfLocked } from "../lib/api/correctionLocks";

const t = (minute: number) => new Date(Date.UTC(2026, 10, 2, 9, minute));
const resp = (id: string, item_id: string, minute = 1) => ({ id, item_id, created_at: t(minute) });
const score = (response_id: string, status: string, points: number, max: number, minute: number) => ({
  response_id,
  status,
  points,
  max_points: max,
  created_at: t(minute),
});
const BOTH = { show_marks: true, lock_correct: true };

describe("markFor", () => {
  test("full, none, some", () => {
    expect(markFor(2, 2)).toBe("correct");
    expect(markFor(0, 2)).toBe("incorrect");
    expect(markFor(1, 2)).toBe("partial");
  });
});

describe("correctionsFromRound", () => {
  test("words per item; only full credit is locked, partial stays open (D-8)", () => {
    expect(
      correctionsFromRound(
        BOTH,
        null,
        t(10),
        [resp("r1", "i1"), resp("r2", "i2"), resp("r3", "i3")],
        [score("r1", "superseded", 1, 1, 5), score("r2", "superseded", 1, 2, 5), score("r3", "superseded", 0, 1, 5)],
      ),
    ).toEqual({ marks: { i1: "correct", i2: "partial", i3: "incorrect" }, locked: ["i1"] });
  });

  test("an unreviewed AI final counts (D-22); proposed and research never do", () => {
    const out = correctionsFromRound(
      BOTH,
      null,
      t(10),
      [resp("r1", "i1"), resp("r2", "i2")],
      [score("r1", "final", 1, 1, 5), score("r2", "proposed", 1, 1, 5), score("r2", "research", 1, 1, 5)],
    );
    expect(out).toEqual({ marks: { i1: "correct" }, locked: ["i1"] });
  });

  test("an unscored answer gets no mark and no lock (D-23)", () => {
    expect(correctionsFromRound(BOTH, null, t(10), [resp("r1", "i1")], [])).toEqual({});
  });

  test("marks follow the round just passed back, not attempt 1 (D-24)", () => {
    const out = correctionsFromRound(
      BOTH,
      t(10),
      t(30),
      [resp("r1", "i1")],
      // 5: attempt 1 (correct); 20: the latest hand-in (wrong).
      [score("r1", "superseded", 1, 1, 5), score("r1", "superseded", 0, 1, 20)],
    );
    expect(out).toEqual({ marks: { i1: "incorrect" } });
  });

  test("an answer written after the pass back is not marked", () => {
    expect(
      correctionsFromRound(BOTH, null, t(10), [resp("r1", "i1", 15)], [score("r1", "final", 1, 1, 20)]),
    ).toEqual({});
  });

  test("each option alone", () => {
    const rows = [resp("r1", "i1")];
    const sc = [score("r1", "superseded", 1, 1, 5)];
    expect(correctionsFromRound({ show_marks: true, lock_correct: false }, null, t(10), rows, sc)).toEqual({
      marks: { i1: "correct" },
    });
    expect(correctionsFromRound({ show_marks: false, lock_correct: true }, null, t(10), rows, sc)).toEqual({
      locked: ["i1"],
    });
  });

  test("the payload has no numbers in it — words and ids only (ADR 0016)", () => {
    const out = correctionsFromRound(
      BOTH,
      null,
      t(10),
      [resp("r1", "item-a"), resp("r2", "item-b")],
      [score("r1", "superseded", 3, 3, 5), score("r2", "superseded", 1, 3, 5)],
    );
    // Item ids here carry no digits, so any digit would be a point leaking.
    expect(JSON.stringify(out)).not.toMatch(/\d/);
  });
});

describe("correctionsDeliverable (D-27)", () => {
  test("needs a 2.0+ client and a renderer at the floor; a null floor is never", () => {
    expect(correctionsDeliverable("2.0.0", { version: 100 }, 100)).toBe(true);
    expect(correctionsDeliverable("2.1.3", { version: 101 }, 100)).toBe(true);
    expect(correctionsDeliverable("1.9.0", { version: 100 }, 100)).toBe(false);
    expect(correctionsDeliverable(null, { version: 100 }, 100)).toBe(false);
    expect(correctionsDeliverable("2.0.0", { version: 99 }, 100)).toBe(false);
    expect(correctionsDeliverable("2.0.0", undefined, 100)).toBe(false);
    expect(correctionsDeliverable("2.0.0", { version: 100 }, null)).toBe(false);
  });
});

describe("the renderer floor (slice 3d)", () => {
  test("is the merge time of PR #169, and the delivery gate uses it by default", () => {
    expect(MIN_RENDERER_VERSION_FOR_CORRECTIONS).toBe(1793647928);
    expect(correctionsDeliverable("2.0.0", { version: 1793647928 })).toBe(true);
    expect(correctionsDeliverable("2.0.0", { version: 1793647927 })).toBe(false);
  });
});

describe("refuseIfLocked", () => {
  const c = (over: object) => ({
    corrections: {
      show_marks: false,
      lock_correct: true,
      passed_back_at: "x",
      locks_delivered: true,
      locked_item_ids: ["i1"],
      ...over,
    },
  });
  test("refuses only a delivered lock on that item", async () => {
    const res = refuseIfLocked(c({}), "i1");
    expect(res?.status).toBe(409);
    expect(await res!.json()).toEqual({ ok: false, error: "item_locked" });
    expect(refuseIfLocked(c({}), "i2")).toBeNull();
    expect(refuseIfLocked(c({ locks_delivered: false }), "i1")).toBeNull();
    expect(refuseIfLocked(c({ lock_correct: false }), "i1")).toBeNull();
    expect(refuseIfLocked({ corrections: null }, "i1")).toBeNull();
  });
});

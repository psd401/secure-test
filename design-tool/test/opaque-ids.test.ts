// Slice 64: per-attempt option ids for match and order.
//
// What these guard is a leak that survived slice 51. Splitting match pairs into
// independent lefts/rights removed the POSITIONAL giveaway but not the
// identifier one — both arrays carried the same authoring pair id, so a student
// reading the bundle could pair left p1 with right p1 and have the key without
// solving anything.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  MATCH_LEFT,
  MATCH_RIGHT,
  opaqueId,
  resolveOpaqueId,
  resolveOpaqueIds,
} from "../lib/api/opaqueIds";

const ATTEMPT = "11111111-1111-4111-8111-111111111111";
const OTHER_ATTEMPT = "22222222-2222-4222-8222-222222222222";
const ITEM = "33333333-3333-4333-8333-333333333333";
const OTHER_ITEM = "44444444-4444-4444-8444-444444444444";
const PAIRS = ["p1", "p2", "p3"];

let original: string | undefined;
beforeAll(() => {
  original = process.env.DESIGN_TOOL_SESSION_SECRET;
  process.env.DESIGN_TOOL_SESSION_SECRET = "opaque-id-test-secret";
  delete process.env.DESIGN_TOOL_DELIVERY_SECRET;
});
afterAll(() => {
  if (original === undefined) delete process.env.DESIGN_TOOL_SESSION_SECRET;
  else process.env.DESIGN_TOOL_SESSION_SECRET = original;
});

describe("opaqueId", () => {
  // A student who reconnects mid-test must not find their options renamed.
  test("is stable for the same attempt, item and id", () => {
    expect(opaqueId(ATTEMPT, ITEM, "p1")).toBe(opaqueId(ATTEMPT, ITEM, "p1"));
  });

  test("hides the authoring id entirely", () => {
    const sealed = opaqueId(ATTEMPT, ITEM, "p1");
    expect(sealed).not.toContain("p1");
    expect(sealed).toMatch(/^[0-9a-f]{24}$/);
  });

  // THE one that matters. A pair's left and right derive from the same
  // authoring id, so without the side scope the bundle re-pairs itself.
  test("gives a pair's two sides different ids", () => {
    expect(opaqueId(ATTEMPT, ITEM, "p1", MATCH_LEFT)).not.toBe(
      opaqueId(ATTEMPT, ITEM, "p1", MATCH_RIGHT),
    );
  });

  // Two students in one sitting comparing screens learn nothing.
  test("differs across attempts", () => {
    expect(opaqueId(ATTEMPT, ITEM, "p1")).not.toBe(opaqueId(OTHER_ATTEMPT, ITEM, "p1"));
  });

  test("differs across items within one attempt", () => {
    expect(opaqueId(ATTEMPT, ITEM, "p1")).not.toBe(opaqueId(ATTEMPT, OTHER_ITEM, "p1"));
  });

  test("differs across the options of one item", () => {
    const ids = PAIRS.map((p) => opaqueId(ATTEMPT, ITEM, p));
    expect(new Set(ids).size).toBe(PAIRS.length);
  });

  // Derived, not stored: nothing has to be kept in step with an edit, and the
  // secret is what stops a student recomputing the mapping themselves from
  // guessable authoring ids like p1/p2/p3.
  test("changes if the secret changes", () => {
    const before = opaqueId(ATTEMPT, ITEM, "p1");
    process.env.DESIGN_TOOL_DELIVERY_SECRET = "a-different-secret";
    try {
      expect(opaqueId(ATTEMPT, ITEM, "p1")).not.toBe(before);
    } finally {
      delete process.env.DESIGN_TOOL_DELIVERY_SECRET;
    }
  });

  test("refuses to seal with no secret configured at all", () => {
    const saved = process.env.DESIGN_TOOL_SESSION_SECRET;
    delete process.env.DESIGN_TOOL_SESSION_SECRET;
    try {
      // Failing loudly beats emitting predictable ids that look sealed.
      expect(() => opaqueId(ATTEMPT, ITEM, "p1")).toThrow();
    } finally {
      process.env.DESIGN_TOOL_SESSION_SECRET = saved;
    }
  });
});

describe("resolveOpaqueId", () => {
  test("maps a sealed id back to its authoring id", () => {
    for (const pair of PAIRS) {
      const sealed = opaqueId(ATTEMPT, ITEM, pair, MATCH_LEFT);
      expect(resolveOpaqueId(ATTEMPT, ITEM, PAIRS, sealed, MATCH_LEFT)).toBe(pair);
    }
  });

  test("will not resolve a left id as a right one", () => {
    const sealed = opaqueId(ATTEMPT, ITEM, "p1", MATCH_LEFT);
    expect(resolveOpaqueId(ATTEMPT, ITEM, PAIRS, sealed, MATCH_RIGHT)).toBeNull();
  });

  test("will not resolve an id issued for another attempt", () => {
    const sealed = opaqueId(OTHER_ATTEMPT, ITEM, "p1");
    expect(resolveOpaqueId(ATTEMPT, ITEM, PAIRS, sealed)).toBeNull();
  });

  test("will not resolve an id issued for another item", () => {
    const sealed = opaqueId(ATTEMPT, OTHER_ITEM, "p1");
    expect(resolveOpaqueId(ATTEMPT, ITEM, PAIRS, sealed)).toBeNull();
  });

  test("rejects a fabricated id, whatever its shape", () => {
    for (const bogus of ["", "p1", "deadbeef", "0".repeat(24), "not-hex-at-all"]) {
      expect(resolveOpaqueId(ATTEMPT, ITEM, PAIRS, bogus)).toBeNull();
    }
  });

  test("rejects an authoring id submitted directly", () => {
    // A student who guesses the real ids gains nothing by sending them.
    expect(resolveOpaqueId(ATTEMPT, ITEM, PAIRS, "p1")).toBeNull();
  });
});

describe("resolveOpaqueIds", () => {
  test("translates a whole list, preserving order", () => {
    const sealed = ["p3", "p1", "p2"].map((p) => opaqueId(ATTEMPT, ITEM, p));
    expect(resolveOpaqueIds(ATTEMPT, ITEM, PAIRS, sealed)).toEqual(["p3", "p1", "p2"]);
  });

  // A half-translated response would look like a legitimate answer and score
  // as one, so one bad id fails the whole list.
  test("fails the entire list if any id is unknown", () => {
    const sealed = [opaqueId(ATTEMPT, ITEM, "p1"), "deadbeefdeadbeefdeadbeef"];
    expect(resolveOpaqueIds(ATTEMPT, ITEM, PAIRS, sealed)).toBeNull();
  });

  test("an empty list translates to an empty list", () => {
    expect(resolveOpaqueIds(ATTEMPT, ITEM, PAIRS, [])).toEqual([]);
  });
});

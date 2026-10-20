import { describe, expect, test } from "bun:test";
import {
  canonical,
  describeObject,
  parseSnap,
  scoreGraph,
  snapPoint,
  type GraphBoard,
  type GraphObject,
} from "../src/engine/graphAnswer";
import { snapInside } from "../src/ui/graphAnswer";

const BOARD: GraphBoard = {
  x: [-10, 10],
  y: [-10, 10],
  grid: 1,
  snap: "1",
  tools: ["point", "line", "segment", "ray", "circle", "parabola"],
  max_objects: 4,
};
const HALF: GraphBoard = { ...BOARD, snap: "1/2" };

const o = (tool: GraphObject["tool"], ...points: [number, number][]): GraphObject => ({ tool, points });
const key = (x: GraphObject) => {
  const c = canonical(x, BOARD);
  return "key" in c ? c.key : c.invalid;
};

describe("parseSnap", () => {
  test.each([
    ["1", [1, 1]],
    ["2", [2, 1]],
    ["1/2", [1, 2]],
    ["2/4", [1, 2]],
    ["0.5", [1, 2]],
    ["0.25", [1, 4]],
    ["1/3", [1, 3]],
    [" 1 / 3 ", [1, 3]],
  ])("%s", (s, r) => expect(parseSnap(s)).toEqual(r as [number, number]));
  test.each([["0"], ["-1"], ["abc"], ["1/0"], ["0.0000001"]])("%s is refused", (s) => expect(parseSnap(s)).toBeNull());
});

describe("snapPoint", () => {
  test("to the nearest grid point", () => {
    expect(snapPoint(1.3, -2.7, [1, 1])).toEqual([1, -3]);
    expect(snapPoint(1.3, -2.7, [1, 2])).toEqual([1.5, -2.5]);
    expect(snapPoint(-0.1, 0.1, [1, 1])).toEqual([0, 0]);
    const [x] = snapPoint(0.34, 0, [1, 3]);
    expect(x).toBeCloseTo(1 / 3, 15);
  });
});

describe("canonical: the same shape, however it was clicked", () => {
  test("a line through any two of its points", () => {
    expect(key(o("line", [0, 1], [1, 3]))).toBe(key(o("line", [2, 5], [-1, -1])));
    expect(key(o("line", [0, 1], [1, 3]))).toBe(key(o("line", [1, 3], [0, 1])));
    expect(key(o("line", [0, 1], [1, 3]))).not.toBe(key(o("line", [0, 1], [1, 4])));
  });

  test("horizontal and vertical lines", () => {
    expect(key(o("line", [0, 2], [5, 2]))).toBe(key(o("line", [-3, 2], [-1, 2])));
    expect(key(o("line", [3, 0], [3, 5]))).toBe(key(o("line", [3, -4], [3, 9])));
  });

  test("a segment is its two ends in either order, but only those ends", () => {
    expect(key(o("segment", [0, 0], [2, 4]))).toBe(key(o("segment", [2, 4], [0, 0])));
    expect(key(o("segment", [0, 0], [2, 4]))).not.toBe(key(o("segment", [0, 0], [1, 2])));
  });

  test("a ray keeps its endpoint and direction, not its second point", () => {
    expect(key(o("ray", [1, 1], [3, 2]))).toBe(key(o("ray", [1, 1], [5, 3])));
    expect(key(o("ray", [1, 1], [3, 2]))).not.toBe(key(o("ray", [3, 2], [1, 1])));
  });

  test("a circle is its centre and radius", () => {
    expect(key(o("circle", [1, 2], [4, 6]))).toBe(key(o("circle", [1, 2], [6, 2])));
    expect(key(o("circle", [1, 2], [4, 6]))).not.toBe(key(o("circle", [1, 2], [4, 5])));
  });

  test("a parabola is its vertex and opening", () => {
    expect(key(o("parabola", [1, -2], [2, 0]))).toBe(key(o("parabola", [1, -2], [3, 6])));
    expect(key(o("parabola", [1, -2], [2, 0]))).toBe(key(o("parabola", [1, -2], [0, 0])));
    expect(key(o("parabola", [1, -2], [2, 0]))).not.toBe(key(o("parabola", [1, -2], [2, 1])));
  });

  test("not shapes", () => {
    expect(key(o("line", [1, 1], [1, 1]))).toBe("same_points");
    expect(key(o("parabola", [1, 1], [1, 5]))).toBe("vertical_parabola_point");
    expect(key(o("parabola", [0, 2], [1, 2]))).toBe("flat_parabola");
    expect(key(o("point", [0.5, 1]))).toBe("off_grid");
    expect(key(o("point", [11, 0]))).toBe("out_of_bounds");
    expect(key(o("line", [0, 0]))).toBe("wrong_point_count");
    expect(key({ tool: "hexagon" as never, points: [[0, 0]] })).toBe("unknown_tool");
  });

  test("half-unit snap: exact, no float noise", () => {
    const c1 = canonical(o("line", [0.5, 0.5], [1.5, 2]), HALF);
    const c2 = canonical(o("line", [2.5, 3.5], [-0.5, -1]), HALF);
    expect(c1).toEqual(c2);
    expect(canonical(o("point", [0.25, 0]), HALF)).toEqual({ invalid: "off_grid" });
  });

  test("a snap too fine for the board is refused, not keyed unsafely", () => {
    const fine = { ...BOARD, x: [-100, 100] as [number, number], y: [-100, 100] as [number, number], snap: "0.000001" };
    expect(canonical(o("point", [99.999994, 0]), fine)).toEqual({ invalid: "off_grid" });
    expect("key" in canonical(o("point", [0.000003, 0.000004]), fine)).toBe(true);
  });

  test("thirds: 0.1 + 0.2 style noise doesn't break a third-snapped point", () => {
    const third = { ...BOARD, snap: "1/3" };
    expect(canonical(o("point", [1 / 3 + 1 / 3, 1]), third)).toEqual(canonical(o("point", [2 / 3, 1]), third));
  });
});

describe("scoreGraph", () => {
  const line = o("line", [0, 1], [1, 3]);
  const point = o("point", [2, 2]);

  test("all: exactly the key's shapes", () => {
    const k = { objects: [line], scoring: "all" as const };
    expect(scoreGraph(BOARD, k, [o("line", [1, 3], [2, 5])]).score).toBe(1);
    expect(scoreGraph(BOARD, k, [o("line", [0, 1], [1, 4])]).score).toBe(0);
    expect(scoreGraph(BOARD, k, [line, point]).score).toBe(0);
    expect(scoreGraph(BOARD, k, []).score).toBe(0);
  });

  test("a repeated shape counts once", () => {
    const k = { objects: [line], scoring: "all" as const };
    expect(scoreGraph(BOARD, k, [line, o("line", [2, 5], [-1, -1])])).toEqual({ score: 1, matched: [true], extra: 0 });
  });

  test("per_object: the share present; more shapes than the key is nothing", () => {
    const k = { objects: [line, point], scoring: "per_object" as const };
    expect(scoreGraph(BOARD, k, [line]).score).toBe(0.5);
    expect(scoreGraph(BOARD, k, [line, point]).score).toBe(1);
    expect(scoreGraph(BOARD, k, [line, o("point", [3, 3])]).score).toBe(0.5);
    expect(scoreGraph(BOARD, k, [line, point, o("point", [3, 3])]).score).toBe(0);
  });

  test("a tool the board doesn't offer, or a non-shape, is wrong", () => {
    const onlyLines = { ...BOARD, tools: ["line" as const] };
    const k = { objects: [line], scoring: "all" as const };
    expect(scoreGraph(onlyLines, k, [line, point]).score).toBe(0);
    expect(scoreGraph(BOARD, k, [line, o("line", [1, 1], [1, 1])]).extra).toBe(1);
  });

  test("an empty key scores nothing", () => {
    expect(scoreGraph(BOARD, { objects: [], scoring: "all" }, [line]).score).toBe(0);
  });
});

describe("describeObject", () => {
  test.each([
    [o("point", [2, -3]), "point (2, −3)"],
    [o("line", [0, 1], [1, 3]), "y = 2x + 1"],
    [o("line", [0, 0], [2, 1]), "y = (1/2)x"],
    [o("line", [0, 3], [1, 2]), "y = −x + 3"],
    [o("line", [0, -2], [5, -2]), "y = −2"],
    [o("line", [3, 0], [3, 5]), "x = 3"],
    [o("line", [0, -1], [1, 0]), "y = x − 1"],
    [o("segment", [2, 4], [0, 0]), "segment from (0, 0) to (2, 4)"],
    [o("ray", [1, 1], [3, 2]), "ray from (1, 1) through (3, 2)"],
    [o("circle", [1, 2], [4, 6]), "circle with centre (1, 2) and radius 5"],
    [o("circle", [0, 0], [1, 1]), "circle with centre (0, 0) and radius √2"],
    [o("parabola", [1, -2], [2, 0]), "parabola y = 2(x − 1)² − 2"],
    [o("parabola", [0, 0], [1, 1]), "parabola y = x²"],
    [o("parabola", [-3, 4], [-1, 3]), "parabola y = −(1/4)(x + 3)² + 4"],
    [o("line", [1, 1], [1, 1]), "not a complete shape"],
  ])("%j → %s", (obj, text) => expect(describeObject(obj, BOARD)).toBe(text));

  test("on a half-unit board", () => {
    expect(describeObject(o("point", [0.5, -1.5]), HALF)).toBe("point (1/2, −3/2)");
    expect(describeObject(o("line", [0, 0.5], [1, 1.5]), HALF)).toBe("y = x + 1/2");
    expect(describeObject(o("parabola", [0, 0], [1, 0.5]), HALF)).toBe("parabola y = (1/2)x²");
    expect(describeObject(o("circle", [0, 0], [1.5, 2]), HALF)).toBe("circle with centre (0, 0) and radius 5/2");
  });
});

import { graphAnswerLines, graphMaxPoints, graphPoints } from "../src/engine/graphAnswer";

describe("points and lines for results", () => {
  const line = o("line", [0, 1], [1, 3]);
  const pt = o("point", [2, 2]);
  test("max points: 1 for all; distinct key shapes for per_object", () => {
    expect(graphMaxPoints(BOARD, { objects: [line, pt], scoring: "all" })).toBe(1);
    expect(graphMaxPoints(BOARD, { objects: [line, pt], scoring: "per_object" })).toBe(2);
    expect(graphMaxPoints(BOARD, { objects: [line, o("line", [2, 5], [-1, -1])], scoring: "per_object" })).toBe(1);
  });
  test("points are whole", () => {
    expect(graphPoints(BOARD, { objects: [line, pt], scoring: "per_object" }, [line])).toBe(1);
    expect(graphPoints(BOARD, { objects: [line, pt], scoring: "all" }, [line])).toBe(0);
    expect(graphPoints(BOARD, { objects: [line, pt], scoring: "all" }, [pt, line])).toBe(1);
  });
  test("lines read back and mark each object", () => {
    expect(graphAnswerLines(BOARD, { objects: [line], scoring: "all" }, [line, pt])).toEqual([
      { text: "y = 2x + 1", correct: true },
      { text: "point (2, 2)", correct: false },
    ]);
    expect(graphAnswerLines(BOARD, null, [pt])).toEqual([{ text: "point (2, 2)", correct: null }]);
  });
});

describe("snapInside (board cursor and clicks)", () => {
  test("bounds off the snap grid: rounding past an edge steps back inside", () => {
    const b: GraphBoard = { ...BOARD, x: [-5, 5], y: [-5, 5], snap: "2" };
    const two = parseSnap("2")!;
    expect(snapInside([5, 5], b, two)).toEqual([4, 4]);
    expect(snapInside([-5, -4.9], b, two)).toEqual([-4, -4]);
    expect(snapInside([3.2, 0], b, two)).toEqual([4, 0]);
    // Every result places as a shape on the board.
    for (const p of [snapInside([5, -5], b, two), snapInside([-5, 5], b, two)]) {
      expect("key" in canonical(o("point", p), b)).toBe(true);
    }
  });
  test("bounds on the grid are unchanged", () => {
    expect(snapInside([10, -10], BOARD, [1, 1])).toEqual([10, -10]);
    expect(snapInside([0.4, 0.6], BOARD, [1, 1])).toEqual([0, 1]);
  });
});

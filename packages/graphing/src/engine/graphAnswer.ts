// Graph answers (design note D-9): the student places objects on a grid
// with snapped points — a point, a line, segment or ray through two points,
// a circle (centre, then a point on it), a parabola (vertex, then a point on
// it). Scoring compares the SHAPES, not the clicks: two lines through
// different pairs of points on the same line are the same answer.
//
// Snap replaces tolerance. Every point is a whole multiple of the board's
// snap, so coordinates become integers in snap units and every comparison
// is exact integer arithmetic — no float noise, no tolerance to tune.

export type GraphTool = "point" | "line" | "segment" | "ray" | "circle" | "parabola";
export const GRAPH_TOOLS: readonly GraphTool[] = ["point", "line", "segment", "ray", "circle", "parabola"];

export interface GraphObject {
  tool: GraphTool;
  /** Click order: 1 point for a point, 2 for every other tool. */
  points: [number, number][];
}

export interface GraphBoard {
  x: [number, number];
  y: [number, number];
  /** Grid spacing students see (graph units). */
  grid: number;
  /** Snap as a rational string: "1", "1/2", "0.5", "1/3". */
  snap: string;
  tools: GraphTool[];
  max_objects: number;
  /** Shown on the board, not placed by the student and never scored. */
  fixed?: GraphObject[];
}

export type GraphScoring = "all" | "per_object";

export interface GraphKey {
  objects: GraphObject[];
  scoring: GraphScoring;
}

/** "1/2" → [1, 2], "0.25" → [1, 4], "3" → [3, 1]; null when unusable. */
export function parseSnap(s: string): [number, number] | null {
  const t = s.trim();
  let m = /^(\d+)\s*\/\s*(\d+)$/.exec(t);
  if (m) {
    const p = Number(m[1]);
    const q = Number(m[2]);
    if (p <= 0 || q <= 0 || !Number.isSafeInteger(p) || !Number.isSafeInteger(q)) return null;
    const g = gcd(p, q);
    return [p / g, q / g];
  }
  m = /^(\d+)(?:\.(\d+))?$/.exec(t);
  if (m) {
    const decimals = m[2] ?? "";
    if (decimals.length > 6) return null;
    const q = Math.pow(10, decimals.length);
    const p = Number(m[1]) * q + Number(decimals || "0");
    if (p <= 0) return null;
    const g = gcd(p, q);
    return [p / g, q / g];
  }
  return null;
}

export function gcd(a: number, b: number): number {
  a = Math.abs(a);
  b = Math.abs(b);
  while (b) [a, b] = [b, a % b];
  return a;
}

/** The nearest grid point to (x, y), in graph units. */
export function snapPoint(x: number, y: number, snap: [number, number]): [number, number] {
  const s = snap[0] / snap[1];
  return [Math.round(x / s) * s, Math.round(y / s) * s].map((v) => (Object.is(v, -0) ? 0 : v)) as [number, number];
}

/** A coordinate in snap units, or null when it isn't on the grid. */
function units(v: number, snap: [number, number]): number | null {
  if (!Number.isFinite(v)) return null;
  const k = Math.round((v * snap[1]) / snap[0]);
  const back = (k * snap[0]) / snap[1];
  if (Math.abs(back - v) > 1e-9 * Math.max(1, Math.abs(v))) return null;
  return k;
}

export type Invalid =
  | "unknown_tool"
  | "tool_not_allowed"
  | "wrong_point_count"
  | "off_grid"
  | "out_of_bounds"
  | "same_points"
  | "vertical_parabola_point"
  | "flat_parabola";

/** Largest |coordinate| in snap units: keeps every key product a safe integer. */
const MAX_UNITS = 1e6;

/**
 * The shape's canonical key, or why the object isn't a shape at all. Two
 * objects are the same answer exactly when their keys are equal.
 */
export function canonical(o: GraphObject, board: GraphBoard): { key: string } | { invalid: Invalid } {
  const snap = parseSnap(board.snap);
  if (!snap) return { invalid: "off_grid" };
  if (!GRAPH_TOOLS.includes(o.tool)) return { invalid: "unknown_tool" };
  const need = o.tool === "point" ? 1 : 2;
  if (!Array.isArray(o.points) || o.points.length !== need) return { invalid: "wrong_point_count" };
  const pts: [number, number][] = [];
  for (const p of o.points) {
    if (!Array.isArray(p) || p.length !== 2) return { invalid: "wrong_point_count" };
    const [x, y] = p;
    if (x < board.x[0] - 1e-9 || x > board.x[1] + 1e-9 || y < board.y[0] - 1e-9 || y > board.y[1] + 1e-9) {
      return { invalid: "out_of_bounds" };
    }
    const kx = units(x, snap);
    const ky = units(y, snap);
    if (kx === null || ky === null) return { invalid: "off_grid" };
    // A snap too fine for the board (saved before the schema capped it).
    if (Math.abs(kx) > MAX_UNITS || Math.abs(ky) > MAX_UNITS) return { invalid: "off_grid" };
    pts.push([kx, ky]);
  }
  const [a, b] = pts as [[number, number], [number, number] | undefined];
  if (o.tool === "point") return { key: `P ${a[0]},${a[1]}` };
  const [bx, by] = b!;
  if (a[0] === bx && a[1] === by) return { invalid: "same_points" };
  const dx = bx - a[0];
  const dy = by - a[1];
  switch (o.tool) {
    case "line": {
      // A x + B y = C through both points, reduced, sign fixed.
      let A = dy;
      let B = -dx;
      let C = A * a[0] + B * a[1];
      const g = gcd(gcd(A, B), C) || 1;
      A /= g;
      B /= g;
      C /= g;
      if (A < 0 || (A === 0 && B < 0)) [A, B, C] = [-A, -B, -C];
      return { key: `L ${A},${B},${C}` };
    }
    case "segment": {
      const [p, q] = [a, b!].sort((m, n) => m[0] - n[0] || m[1] - n[1]) as [[number, number], [number, number]];
      return { key: `S ${p[0]},${p[1]},${q[0]},${q[1]}` };
    }
    case "ray": {
      const g = gcd(dx, dy);
      return { key: `R ${a[0]},${a[1]},${dx / g},${dy / g}` };
    }
    case "circle":
      return { key: `C ${a[0]},${a[1]},${dx * dx + dy * dy}` };
    case "parabola": {
      if (dx === 0) return { invalid: "vertical_parabola_point" };
      // Level with the vertex: a = 0 draws the line y = k, whatever h is.
      if (dy === 0) return { invalid: "flat_parabola" };
      // y − k = a (x − h)², a = dy / dx² in snap units.
      let num = dy;
      let den = dx * dx;
      const g = gcd(num, den) || 1;
      num /= g;
      den /= g;
      return { key: `Q ${a[0]},${a[1]},${num}/${den}` };
    }
    default:
      return { invalid: "unknown_tool" };
  }
}

export interface GraphScore {
  /** 0…1. */
  score: number;
  /** For each key object, whether the response has it. */
  matched: boolean[];
  /** Response objects that match nothing in the key (wrong, invalid or a repeat). */
  extra: number;
}

/**
 * The response against the key. `all`: full credit only for exactly the
 * key's shapes. `per_object`: the share of the key's shapes present — but
 * nothing at all when the response has more distinct shapes than the key
 * (so drawing everything isn't a strategy). Repeated shapes count once;
 * objects whose tool the board doesn't offer don't count.
 */
export function scoreGraph(board: GraphBoard, key: GraphKey, response: readonly GraphObject[]): GraphScore {
  const keyKeys: string[] = [];
  for (const o of key.objects) {
    const c = canonical(o, board);
    if ("key" in c && !keyKeys.includes(c.key)) keyKeys.push(c.key);
  }
  const got = new Set<string>();
  let extra = 0;
  for (const o of response) {
    const c = board.tools.includes(o.tool) ? canonical(o, board) : { invalid: "tool_not_allowed" as const };
    if ("invalid" in c) {
      extra++;
      continue;
    }
    if (got.has(c.key)) continue;
    got.add(c.key);
    if (!keyKeys.includes(c.key)) extra++;
  }
  const matched = keyKeys.map((k) => got.has(k));
  const hits = matched.filter(Boolean).length;
  if (keyKeys.length === 0) return { score: 0, matched, extra };
  if (key.scoring === "all") return { score: hits === keyKeys.length && extra === 0 ? 1 : 0, matched, extra };
  if (got.size > keyKeys.length) return { score: 0, matched, extra };
  return { score: hits / keyKeys.length, matched, extra };
}

// ---------- readback ----------

/** A rational a/b as text: "3", "-1/2", "5/3". */
function frac(num: number, den: number): string {
  if (den < 0) [num, den] = [-num, -den];
  const g = gcd(num, den) || 1;
  num /= g;
  den /= g;
  const s = den === 1 ? String(Math.abs(num)) : `${Math.abs(num)}/${den}`;
  return (num < 0 ? "−" : "") + s;
}

/** A value k·p/q (k snap units) as text. */
function val(k: number, snap: [number, number]): string {
  return frac(k * snap[0], snap[1]);
}

function pointText(k: [number, number], snap: [number, number]): string {
  return `(${val(k[0], snap)}, ${val(k[1], snap)})`;
}

/** "+ 3", "− 1/2", "" for zero — the tail of "y = 2x + 3". */
function signed(num: number, den: number): string {
  if (num === 0) return "";
  const t = frac(num, den);
  return t.startsWith("−") ? ` − ${t.slice(1)}` : ` + ${t}`;
}

/** Coefficient before a variable: "", "−", "2", "−(1/2)" — bracketed when a fraction. */
function coeff(num: number, den: number): string {
  if (num === den) return "";
  if (num === -den) return "−";
  const t = frac(num, den);
  if (!t.includes("/")) return t;
  return t.startsWith("−") ? `−(${t.slice(1)})` : `(${t})`;
}

/** The shape in words a teacher reads back: "y = 2x + 1", "circle centre (1, 2), radius 3". */
export function describeObject(o: GraphObject, board: GraphBoard): string {
  const snap = parseSnap(board.snap);
  const c = canonical(o, board);
  if (!snap || "invalid" in c) return "not a complete shape";
  const [p, q] = snap;
  const parts = c.key.slice(2).split(/[,/]/).map(Number);
  switch (c.key[0]) {
    case "P":
      return `point ${pointText([parts[0]!, parts[1]!], snap)}`;
    case "L": {
      const [A, B, C] = parts as [number, number, number];
      // A x + B y = C·s (s = p/q).
      if (B === 0) return `x = ${frac(C * p, A * q)}`;
      const slopeNum = -A;
      const slopeDen = B;
      if (A === 0) return `y = ${frac(C * p, B * q)}`;
      return `y = ${coeff(slopeNum, slopeDen)}x${signed(C * p, B * q)}`;
    }
    case "S":
      return `segment from ${pointText([parts[0]!, parts[1]!], snap)} to ${pointText([parts[2]!, parts[3]!], snap)}`;
    case "R": {
      const k = o.points.map((pt) => [units(pt[0], snap)!, units(pt[1], snap)!] as [number, number]);
      return `ray from ${pointText(k[0]!, snap)} through ${pointText(k[1]!, snap)}`;
    }
    case "C": {
      const [h, k, r2] = parts as [number, number, number];
      const root = Math.round(Math.sqrt(r2));
      const radius = root * root === r2 ? frac(root * p, q) : `√${frac(r2 * p * p, q * q)}`;
      return `circle with centre ${pointText([h, k], snap)} and radius ${radius}`;
    }
    case "Q": {
      const [h, k, num, den] = parts as [number, number, number, number];
      // y − k = (num/den)(x − h)² in snap units → real a = num·q / (den·p).
      const a = coeff(num * q, den * p);
      const hx = h === 0 ? "x" : `(x${signed(-h * p, q)})`;
      return `parabola y = ${a}${hx}²${signed(k * p, q)}`;
    }
    default:
      return "not a complete shape";
  }
}

// ---------- shared by scoring, results and feedback ----------

/** Points available: 1 when all-or-nothing; one per distinct key shape otherwise. */
export function graphMaxPoints(board: GraphBoard, key: GraphKey): number {
  if (key.scoring === "all") return 1;
  const keys = new Set<string>();
  for (const o of key.objects) {
    const c = canonical(o, board);
    if ("key" in c) keys.add(c.key);
  }
  return Math.max(1, keys.size);
}

/** Points earned (whole numbers, as every other item type scores). */
export function graphPoints(board: GraphBoard, key: GraphKey, response: readonly GraphObject[]): number {
  return Math.round(scoreGraph(board, key, response).score * graphMaxPoints(board, key));
}

/**
 * The answer as lines a teacher reads ("y = 2x + 1"), each marked right or
 * wrong against the key when there is one (null when there isn't).
 */
export function graphAnswerLines(
  board: GraphBoard,
  key: GraphKey | null | undefined,
  response: readonly GraphObject[],
): { text: string; correct: boolean | null }[] {
  return response.map((o) => ({
    text: describeObject(o, board),
    correct: key ? scoreGraph(board, { objects: key.objects, scoring: "per_object" }, [o]).extra === 0 : null,
  }));
}

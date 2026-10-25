// Implicit equations and inequality regions (D-4): x²+y²=4, xy>1, 0<y<x.
//
// A quadtree over the view: each box is asked, by interval arithmetic,
// whether F = lhs − rhs could be 0 there (or whether the inequality could
// hold). Boxes that can't are dropped whole; boxes that surely satisfy an
// inequality are filled whole; the rest split until they are about two
// pixels, where marching squares on the corner values draws the curve and a
// centre sample decides the fill. A box whose interval is unbounded (a pole
// inside, as in 1/x = y at x = 0) draws no curve, so a sign change across a
// pole is never drawn as a line.

import type { Relation } from "./ast";
import { compare, type Interval, type IntervalEnv, type IntervalFn, type Truth } from "./interval";

export interface ImplicitView {
  xmin: number;
  xmax: number;
  ymin: number;
  ymax: number;
  widthPx: number;
  heightPx: number;
  /** Leaf size in pixels (default 2). */
  leafPx?: number;
  /** Leaf budget (default 120 000). */
  budget?: number;
}

export interface ImplicitResult {
  /** Curve segments in graph coordinates: [x1, y1, x2, y2, …]. */
  segments: number[];
  /** Filled boxes in graph coordinates: [x, y, w, h, …] (y = bottom). */
  fills: number[];
  /** True when the budget ran out and the picture is incomplete. */
  truncated: boolean;
}

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  level: number;
}

function env(b: Box): IntervalEnv {
  return { x: { lo: b.x0, hi: b.x1, def: "all" }, y: { lo: b.y0, hi: b.y1, def: "all" } };
}

const ZERO: Interval = { lo: 0, hi: 0, def: "all" };

/** The power-of-two grid the quadtree starts from, sized so leaves are ~leafPx. */
function roots(v: ImplicitView): { boxes: Box[]; leafLevel: number } {
  const leafPx = v.leafPx ?? 2;
  const startPx = 64;
  const levels = Math.max(0, Math.round(Math.log2(startPx / leafPx)));
  const cols = Math.max(1, Math.ceil(v.widthPx / startPx));
  const rows = Math.max(1, Math.ceil(v.heightPx / startPx));
  const w = (v.xmax - v.xmin) / cols;
  const h = (v.ymax - v.ymin) / rows;
  const boxes: Box[] = [];
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      boxes.push({ x0: v.xmin + i * w, x1: v.xmin + (i + 1) * w, y0: v.ymin + j * h, y1: v.ymin + (j + 1) * h, level: 0 });
    }
  }
  return { boxes, leafLevel: levels };
}

function split(b: Box): Box[] {
  const mx = (b.x0 + b.x1) / 2;
  const my = (b.y0 + b.y1) / 2;
  const l = b.level + 1;
  return [
    { x0: b.x0, y0: b.y0, x1: mx, y1: my, level: l },
    { x0: mx, y0: b.y0, x1: b.x1, y1: my, level: l },
    { x0: b.x0, y0: my, x1: mx, y1: b.y1, level: l },
    { x0: mx, y0: my, x1: b.x1, y1: b.y1, level: l },
  ];
}

/** Marching squares on one leaf: the zero contour of the corner values. */
function march(b: Box, f: (x: number, y: number) => number, out: number[]): void {
  const v00 = f(b.x0, b.y0);
  const v10 = f(b.x1, b.y0);
  const v01 = f(b.x0, b.y1);
  const v11 = f(b.x1, b.y1);
  if (!Number.isFinite(v00) || !Number.isFinite(v10) || !Number.isFinite(v01) || !Number.isFinite(v11)) return;
  const pts: number[] = [];
  const edge = (xa: number, ya: number, va: number, xb: number, yb: number, vb: number) => {
    if ((va > 0) === (vb > 0)) return;
    const t = va / (va - vb);
    pts.push(xa + t * (xb - xa), ya + t * (yb - ya));
  };
  edge(b.x0, b.y0, v00, b.x1, b.y0, v10); // bottom
  edge(b.x1, b.y0, v10, b.x1, b.y1, v11); // right
  edge(b.x1, b.y1, v11, b.x0, b.y1, v01); // top
  edge(b.x0, b.y1, v01, b.x0, b.y0, v00); // left
  if (pts.length === 4) out.push(pts[0]!, pts[1]!, pts[2]!, pts[3]!);
  else if (pts.length === 8) {
    // A saddle: the centre's sign decides which corners connect.
    const c = f((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2);
    if ((c > 0) === (v00 > 0)) out.push(pts[0]!, pts[1]!, pts[2]!, pts[3]!, pts[4]!, pts[5]!, pts[6]!, pts[7]!);
    else out.push(pts[0]!, pts[1]!, pts[6]!, pts[7]!, pts[2]!, pts[3]!, pts[4]!, pts[5]!);
  }
}

/** Marching squares on a yes/no field: the region's outline at leaf size. */
function marchBool(b: Box, test: (x: number, y: number) => boolean, out: number[]): void {
  const f = (x: number, y: number) => (test(x, y) ? 1 : -1);
  march(b, f, out);
}

export interface ImplicitSpec {
  /** lhs − rhs at a point. */
  f: (x: number, y: number) => number;
  /** lhs − rhs over a box. */
  fi: IntervalFn;
  relation: Relation;
  restrict: ((x: number, y: number) => boolean) | null;
}

/** An equation or a single inequality in x and y. */
export function traceImplicit(spec: ImplicitSpec, view: ImplicitView): ImplicitResult {
  const { boxes, leafLevel } = roots(view);
  const segments: number[] = [];
  const fills: number[] = [];
  let budget = view.budget ?? 120_000;
  const fillable = spec.relation !== "=";
  const stack = boxes.reverse();
  while (stack.length) {
    const b = stack.pop()!;
    if (budget-- <= 0) return { segments, fills, truncated: true };
    const I = spec.fi(env(b));
    if (I.def === "none") continue;
    const onCurve = I.lo <= 0 && I.hi >= 0;
    const truth: Truth = fillable ? compare(I, spec.relation, ZERO) : 0;
    if (!onCurve && truth === 0) continue;
    if (fillable && truth === 2 && !spec.restrict) {
      fills.push(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
      continue;
    }
    if (b.level < leafLevel) {
      for (const s of split(b)) stack.push(s);
      continue;
    }
    // A leaf.
    const cx = (b.x0 + b.x1) / 2;
    const cy = (b.y0 + b.y1) / 2;
    if (spec.restrict && !spec.restrict(cx, cy)) continue;
    if (onCurve && Number.isFinite(I.lo) && Number.isFinite(I.hi)) march(b, spec.f, segments);
    if (fillable) {
      const v = spec.f(cx, cy);
      if (Number.isFinite(v) && holds(v, spec.relation)) fills.push(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
    }
  }
  return { segments, fills, truncated: false };
}

function holds(v: number, r: Relation): boolean {
  switch (r) {
    case "<":
      return v < 0;
    case "<=":
      return v <= 0;
    case ">":
      return v > 0;
    case ">=":
      return v >= 0;
    case "=":
      return v === 0;
  }
}

export interface RegionSpec {
  test: (x: number, y: number) => boolean;
  truth: (env: IntervalEnv) => Truth;
  restrict: ((x: number, y: number) => boolean) | null;
}

/** A chained inequality (0<y<x): fill where it holds, outline at leaf size. */
export function traceRegion(spec: RegionSpec, view: ImplicitView): ImplicitResult {
  const { boxes, leafLevel } = roots(view);
  const segments: number[] = [];
  const fills: number[] = [];
  let budget = view.budget ?? 120_000;
  const stack = boxes.reverse();
  while (stack.length) {
    const b = stack.pop()!;
    if (budget-- <= 0) return { segments, fills, truncated: true };
    const t = spec.truth(env(b));
    if (t === 0) continue;
    if (t === 2 && !spec.restrict) {
      fills.push(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
      continue;
    }
    if (b.level < leafLevel) {
      for (const s of split(b)) stack.push(s);
      continue;
    }
    const cx = (b.x0 + b.x1) / 2;
    const cy = (b.y0 + b.y1) / 2;
    const ok = (x: number, y: number) => spec.test(x, y) && (!spec.restrict || spec.restrict(x, y));
    if (ok(cx, cy)) fills.push(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
    marchBool(b, ok, segments);
  }
  return { segments, fills, truncated: false };
}

/**
 * Joins leaf segments that share an end into polylines, so a curve strokes
 * as one path — round joins, and a dash pattern that runs along it instead
 * of restarting every two pixels. Ends are matched after rounding away the
 * last bits (neighbouring leaves compute a shared edge point from opposite
 * directions).
 */
export function chainSegments(segments: number[], scale: number): number[][] {
  const q = (v: number) => Math.round(v / (scale * 1e-6));
  const key = (x: number, y: number) => `${q(x)},${q(y)}`;
  const n = segments.length / 4;
  const ends = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    for (const e of [0, 1]) {
      const k = key(segments[i * 4 + e * 2]!, segments[i * 4 + e * 2 + 1]!);
      const list = ends.get(k);
      if (list) list.push(i * 2 + e);
      else ends.set(k, [i * 2 + e]);
    }
  }
  const used = new Uint8Array(n);
  const out: number[][] = [];
  const other = (end: number) => end ^ 1;
  const pt = (end: number): [number, number] => {
    const i = end >> 1;
    const e = end & 1;
    return [segments[i * 4 + e * 2]!, segments[i * 4 + e * 2 + 1]!];
  };
  const extend = (line: number[], fromEnd: number, atFront: boolean) => {
    let end = fromEnd;
    for (;;) {
      const [x, y] = pt(end);
      const next = (ends.get(key(x, y)) ?? []).find((e) => !used[e >> 1]);
      if (next === undefined) return;
      used[next >> 1] = 1;
      const far = other(next);
      const [fx, fy] = pt(far);
      if (atFront) line.unshift(fx, fy);
      else line.push(fx, fy);
      end = far;
    }
  };
  for (let i = 0; i < n; i++) {
    if (used[i]) continue;
    used[i] = 1;
    const [ax, ay] = pt(i * 2);
    const [bx, by] = pt(i * 2 + 1);
    const line = [ax, ay, bx, by];
    extend(line, i * 2 + 1, false);
    extend(line, i * 2, true);
    out.push(line);
  }
  return out;
}

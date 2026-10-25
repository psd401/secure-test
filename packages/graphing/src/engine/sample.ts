// Adaptive sampling of y = f(x) (or x = f(y)) for drawing (D-4).
//
// One base interval per pixel, each subdivided where the curve bends more
// than a fraction of a pixel, where it leaves or enters its domain (√x at
// 0), or where it jumps (tan x at π/2). A jump is a break in the polyline,
// never a vertical line. A per-curve evaluation budget bounds pathological
// inputs such as sin(1/x).

export interface SampleOptions {
  /** Pixels across the sampled range (base intervals). */
  pixels: number;
  /** Pixels per unit of f's output, for the flatness and jump tests. */
  valueScale: number;
  /** Output range in pixels. */
  valueSpanPx: number;
  /**
   * The visible output range. Stretches entirely beyond one edge are not
   * refined — x¹⁰ or sec²x far off screen would otherwise spend the whole
   * budget where nothing is drawn.
   */
  visible?: [number, number];
  /** Maximum function evaluations (default 40 000). */
  budget?: number;
}

/** Flat polylines: [t0, v0, t1, v1, …]; separate arrays are separate pieces. */
export type Polyline = number[];

const MAX_DEPTH = 10;
const FLAT_PX = 0.25;
/** A step at the finest level longer than this is checked for a jump. */
const GAP_PX = 1;

export function sampleCurve(
  f: (t: number) => number,
  t0: number,
  t1: number,
  opts: SampleOptions,
): Polyline[] {
  const pieces: Polyline[] = [];
  let current: Polyline = [];
  let budget = opts.budget ?? 40_000;
  const scale = opts.valueScale;
  const jumpPx = Math.max(opts.valueSpanPx, 1);
  const raw = (t: number): number => {
    const v = f(t);
    return typeof v === "number" ? v : NaN;
  };
  const evalf = (t: number): number => {
    budget--;
    return raw(t);
  };
  const [lo, hi] = opts.visible ?? [-Infinity, Infinity];
  // A margin keeps lines that leave the view drawn to its edge at full slope.
  const margin = opts.visible ? (hi - lo) * 0.5 : 0;
  const offscreen = (p: number, q: number, r: number) =>
    (p > hi + margin && q > hi + margin && r > hi + margin) || (p < lo - margin && q < lo - margin && r < lo - margin);
  const finite = Number.isFinite;

  const flush = () => {
    // A lone point draws nothing; keep only real segments.
    if (current.length >= 4) pieces.push(current);
    current = [];
  };

  // Does the gap between f(a) and f(b) survive bisection? A continuous
  // steep stretch (tan just short of π/2) shrinks to nothing; a jump or a
  // pole inside [a, b] keeps it however small the interval gets.
  const isJump = (a: number, fa: number, b: number, fb: number): boolean => {
    // Out of budget: only a sign flip between large values reads as a pole.
    if (budget <= 0) return Math.sign(fa) !== Math.sign(fb) && Math.abs(fb - fa) * scale > jumpPx;
    let l = a;
    let h = b;
    let fl = fa;
    let fh = fb;
    for (let k = 0; k < 40 && budget > 0; k++) {
      const m = (l + h) / 2;
      if (m === l || m === h) break;
      const fm = evalf(m);
      if (!finite(fm)) return true;
      if (Math.abs(fm - fl) >= Math.abs(fh - fm)) {
        h = m;
        fh = fm;
      } else {
        l = m;
        fl = fm;
      }
      if (Math.abs(fh - fl) * scale < GAP_PX) return false;
    }
    return true;
  };
  const emit = (t: number, v: number) => {
    if (current.length === 0 || current[current.length - 2] !== t) current.push(t, v);
  };

  // Moves from a finite end toward a non-finite one to find the domain edge.
  const edge = (good: number, fg: number, bad: number): [number, number] => {
    let g = good;
    let fgv = fg;
    let b = bad;
    for (let k = 0; k < 30 && budget > 0; k++) {
      const m = (g + b) / 2;
      const fm = evalf(m);
      if (finite(fm)) {
        g = m;
        fgv = fm;
      } else b = m;
    }
    return [g, fgv];
  };

  const refine = (a: number, fa: number, b: number, fb: number, depth: number): void => {
    const fina = finite(fa);
    const finb = finite(fb);
    if (budget <= 0 || depth >= MAX_DEPTH) {
      if (fina && finb) {
        if (Math.abs(fb - fa) * scale > GAP_PX && isJump(a, fa, b, fb)) flush();
        emit(b, fb);
      } else if (fina && !finb) {
        const [g, fg] = edge(a, fa, b);
        emit(g, fg);
        flush();
      } else if (!fina && finb) {
        const [g, fg] = edge(b, fb, a);
        flush();
        emit(g, fg);
        emit(b, fb);
      }
      return;
    }
    const m = (a + b) / 2;
    const fm = evalf(m);
    // Undefined at both ends and the middle: treat the stretch as outside
    // the domain rather than spending the budget on it.
    if (!fina && !finb && !finite(fm) && depth >= 1) return;
    if (fina && finb && finite(fm)) {
      // Entirely past one edge of the view: nothing to see, nothing to refine.
      if (offscreen(fa, fm, fb)) {
        emit(b, fb);
        return;
      }
      // The midpoint is on the chord: straight enough, however steep.
      if (Math.abs(fm - (fa + fb) / 2) * scale <= FLAT_PX) {
        emit(b, fb);
        return;
      }
    }
    refine(a, fa, m, fm, depth + 1);
    refine(m, fm, b, fb, depth + 1);
  };

  const n = Math.max(2, Math.ceil(opts.pixels));
  const dt = (t1 - t0) / n;
  let a = t0;
  // The base samples don't count against the refinement budget.
  let fa = raw(a);
  if (finite(fa)) emit(a, fa);
  for (let k = 1; k <= n; k++) {
    const b = k === n ? t1 : t0 + k * dt;
    const fb = raw(b);
    refine(a, fa, b, fb, 0);
    a = b;
    fa = fb;
  }
  flush();
  return pieces;
}

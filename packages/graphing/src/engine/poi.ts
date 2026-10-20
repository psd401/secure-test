// Points of interest on explicit curves (D-4): zeros, extrema, the
// intercept on the other axis, and intersections between two curves. A
// tap on a curve shows these; the trace steps between them.
//
// Every search runs over the visible range, sampled finely and refined
// numerically. The rules that keep the dots honest:
// - A sign change across a pole (1/x at 0) is not a zero, and a pole
//   sampled on the grid (tan(πx) at ½) is not an extremum: both are judged
//   against the curve's typical size, not its largest value.
// - A flat stretch is not a row of points: y = 0, floor(x) on [0, 1) and two
//   coincident lines give no zeros or intersections there; a plateau or a
//   step edge is not an extremum.
// - A touching zero (x² at 0) is an extremum whose value is zero relative
//   to the curve's size; a minimum just below the axis (sin x + 0.999999)
//   also has its two nearby crossings found.

export type PoiKind = "zero" | "max" | "min" | "intercept" | "intersection";

export interface Poi {
  kind: PoiKind;
  /** Along the curve's own axis (x for y = f(x)). */
  t: number;
  /** f(t). */
  v: number;
}

const SAMPLES = 400;

function bisect(f: (t: number) => number, a: number, b: number, fa: number): number {
  let lo = a;
  let hi = b;
  let flo = fa;
  for (let k = 0; k < 100; k++) {
    const m = (lo + hi) / 2;
    if (m === lo || m === hi) break;
    const fm = f(m);
    if (fm === 0) return m;
    if (Math.sign(fm) === Math.sign(flo)) {
      lo = m;
      flo = fm;
    } else hi = m;
  }
  return (lo + hi) / 2;
}

function golden(f: (t: number) => number, a: number, b: number, max: boolean): number {
  const g = (Math.sqrt(5) - 1) / 2;
  const s = max ? -1 : 1;
  let lo = a;
  let hi = b;
  let c = hi - g * (hi - lo);
  let d = lo + g * (hi - lo);
  let fc = s * f(c);
  let fd = s * f(d);
  for (let k = 0; k < 100 && hi - lo > 1e-14 * Math.max(1, Math.abs(lo)); k++) {
    if (fc < fd) {
      hi = d;
      d = c;
      fd = fc;
      c = hi - g * (hi - lo);
      fc = s * f(c);
    } else {
      lo = c;
      c = d;
      fc = fd;
      d = lo + g * (hi - lo);
      fd = s * f(d);
    }
  }
  return (lo + hi) / 2;
}

/**
 * Golden section finds an extremum only to ~√ε of the interval (the curve
 * is flat there); bisecting on the sign of a symmetric difference with a
 * wide step gets to ~1e-11 of it, so a vertex at x = −2 reads as −2.
 */
function refineExtremum(f: (t: number) => number, a: number, b: number, x0: number, max: boolean): number {
  const h = (b - a) * 1e-3;
  const rising = (x: number) => (f(x + h) - f(x - h)) * (max ? 1 : -1) > 0;
  let lo = Math.max(a, x0 - (b - a) / 4);
  let hi = Math.min(b, x0 + (b - a) / 4);
  if (!rising(lo) || rising(hi)) return x0;
  for (let k = 0; k < 100; k++) {
    const m = (lo + hi) / 2;
    if (m === lo || m === hi) break;
    if (rising(m)) lo = m;
    else hi = m;
  }
  const x = (lo + hi) / 2;
  const fx = f(x);
  const f0 = f(x0);
  const better = max ? fx >= f0 - 1e-12 * Math.abs(f0) : fx <= f0 + 1e-12 * Math.abs(f0);
  return better ? x : x0;
}

/**
 * Very flat extrema (x¹⁰ + 1) are a stretch where f is constant in floating
 * point; any point of it is "the" minimum. Use the middle of the stretch,
 * so x¹⁰ + 1 has its minimum at 0, not at 0.025.
 */
function centreOfPlateau(f: (t: number) => number, a: number, b: number, x: number): number {
  const v = f(x);
  const tol = Math.abs(v) * 4e-16 + Number.MIN_VALUE;
  const same = (t: number) => Math.abs(f(t) - v) <= tol;
  const edge = (inside: number, outside: number): number => {
    if (same(outside)) return outside;
    let i = inside;
    let o = outside;
    for (let k = 0; k < 60; k++) {
      const m = (i + o) / 2;
      if (m === i || m === o) break;
      if (same(m)) i = m;
      else o = m;
    }
    return i;
  };
  const left = edge(x, a);
  const right = edge(x, b);
  return right > left ? (left + right) / 2 : x;
}

/**
 * Rounds away float noise relative to `scale`: 0.9999999999998 reads as 1
 * and 0.30000000000000004 as 0.3, but 1.4142… stays as it is.
 */
export function clean(x: number, scale: number): number {
  if (!Number.isFinite(x)) return x;
  const tol = Math.max(Math.abs(scale), Number.MIN_VALUE) * 1e-9;
  const r = Math.round(x);
  if (Math.abs(x - r) < tol) return r === 0 ? 0 : r;
  for (const p of [10, 100, 1000, 10000]) {
    const q = Math.round(x * p) / p;
    if (Math.abs(x - q) < tol) return q === 0 ? 0 : q;
  }
  return x;
}

interface Grid {
  t: number[];
  v: number[];
  /** The curve's typical size: the 90th percentile of |f| on the grid. */
  size: number;
}

function grid(f: (t: number) => number, a: number, b: number, n: number): Grid {
  const t: number[] = [];
  const v: number[] = [];
  for (let k = 0; k <= n; k++) {
    const x = k === n ? b : a + ((b - a) * k) / n;
    t.push(x);
    v.push(f(x));
  }
  const mags = v.filter(Number.isFinite).map(Math.abs).sort((p, q) => p - q);
  const size = mags.length ? mags[Math.min(mags.length - 1, Math.floor(mags.length * 0.9))]! : 0;
  return { t, v, size };
}

/** Is f(x) a plausible curve value rather than a pole hit? */
function tame(fx: number, size: number): boolean {
  return Number.isFinite(fx) && Math.abs(fx) <= 1e4 * Math.max(size, 1e-300);
}

interface Extremum {
  t: number;
  v: number;
  max: boolean;
  /** Grid index, for the crossings beside a shallow dip. */
  k: number;
}

function extremaRaw(f: (t: number) => number, g: Grid): Extremum[] {
  const { t, v, size } = g;
  const out: Extremum[] = [];
  const n = t.length - 1;
  for (let k = 1; k < n; k++) {
    const p = v[k - 1]!;
    const c = v[k]!;
    const q = v[k + 1]!;
    if (!Number.isFinite(p) || !Number.isFinite(c) || !Number.isFinite(q)) continue;
    // Strict on both sides: a plateau or a step edge is not an extremum.
    const isMax = c > p && c > q;
    const isMin = c < p && c < q;
    if (!isMax && !isMin) continue;
    if (!tame(c, size)) continue;
    const x = centreOfPlateau(
      f,
      t[k - 1]!,
      t[k + 1]!,
      refineExtremum(f, t[k - 1]!, t[k + 1]!, golden(f, t[k - 1]!, t[k + 1]!, isMax), isMax),
    );
    const fx = f(x);
    if (!tame(fx, size)) continue;
    // A spike beside a pole runs off far beyond its neighbours.
    const local = Math.max(Math.abs(p - c), Math.abs(q - c));
    if (Math.abs(fx - c) > 10 * local + 1e-300) continue;
    out.push({ t: x, v: fx, max: isMax, k });
  }
  return out;
}

/** Is the extremum's value zero relative to the curve's size (a touching zero)? */
function touches(e: Extremum, size: number): boolean {
  return Math.abs(e.v) <= 1e-12 * Math.max(size, 1e-300);
}

function zerosOn(f: (t: number) => number, a: number, b: number, g: Grid, ext: Extremum[]): number[] {
  const { t, v, size } = g;
  const n = t.length - 1;
  const span = b - a;
  const out: number[] = [];
  for (let k = 0; k <= n; k++) {
    const vk = v[k]!;
    if (vk === 0) {
      // An exact hit counts only when isolated; a run of zeros is a flat stretch.
      const flat = (k > 0 && v[k - 1] === 0) || (k < n && v[k + 1] === 0);
      if (!flat) out.push(t[k]!);
      continue;
    }
    if (k === n) break;
    const vn = v[k + 1]!;
    if (!Number.isFinite(vk) || !Number.isFinite(vn) || vn === 0) continue;
    if (Math.sign(vk) !== Math.sign(vn)) {
      const r = bisect(f, t[k]!, t[k + 1]!, vk);
      // A pole flips sign too; a real zero ends near zero.
      if (Math.abs(f(r)) <= 1e-6 * Math.max(size, 1e-300)) out.push(r);
    }
  }
  for (const e of ext) {
    if (touches(e, size)) {
      out.push(e.t);
      continue;
    }
    // A shallow dip through the axis between two grid samples.
    const p = v[e.k - 1]!;
    const q = v[e.k + 1]!;
    if (p !== 0 && q !== 0 && Math.sign(e.v) !== Math.sign(p) && Math.sign(e.v) !== Math.sign(q)) {
      out.push(bisect(f, t[e.k - 1]!, e.t, p), bisect(f, e.t, t[e.k + 1]!, e.v));
    }
  }
  return dedupe(out.map((x) => clean(x, span)), span);
}

/** Zeros of f on [a, b]. */
export function zeros(f: (t: number) => number, a: number, b: number, n = SAMPLES): number[] {
  const g = grid(f, a, b, n);
  return zerosOn(f, a, b, g, extremaRaw(f, g));
}

function dedupe(xs: number[], span: number): number[] {
  const tol = Math.abs(span) * 1e-7;
  const s = [...xs].sort((p, q) => p - q);
  const out: number[] = [];
  for (const x of s) if (out.length === 0 || Math.abs(x - out[out.length - 1]!) > tol) out.push(x);
  return out;
}

function extremaOn(f: (t: number) => number, a: number, b: number, g: Grid): { t: number; v: number; max: boolean }[] {
  const span = b - a;
  const seen: { t: number; v: number; max: boolean }[] = [];
  for (const e of extremaRaw(f, g)) {
    if (touches(e, g.size)) continue;
    const ct = clean(e.t, span);
    if (seen.some((s) => Math.abs(s.t - ct) < Math.abs(span) * 1e-7)) continue;
    const v = clean(f(ct), Math.abs(e.v));
    if (!Number.isFinite(v)) continue;
    seen.push({ t: ct, v, max: e.max });
  }
  return seen;
}

/** Local maxima and minima strictly inside [a, b] (touching zeros excluded). */
export function extrema(f: (t: number) => number, a: number, b: number, n = SAMPLES): { t: number; v: number; max: boolean }[] {
  return extremaOn(f, a, b, grid(f, a, b, n));
}

/** Everything worth a dot on y = f(x) within [a, b]. */
export function pointsOfInterest(f: (t: number) => number, a: number, b: number): Poi[] {
  const span = b - a;
  const g = grid(f, a, b, SAMPLES);
  const ext = extremaRaw(f, g);
  const out: Poi[] = [];
  for (const z of zerosOn(f, a, b, g, ext)) out.push({ kind: "zero", t: z, v: 0 });
  for (const e of extremaOn(f, a, b, g)) out.push({ kind: e.max ? "max" : "min", t: e.t, v: e.v });
  if (a <= 0 && b >= 0) {
    const v0 = f(0);
    const near = (p: Poi) => Math.abs(p.t) < Math.abs(span) * 1e-7;
    // On a flat stretch of zeros (floor x on [0, 1)) the intercept is no more
    // a point of interest than the rest of the stretch.
    const d = Math.abs(span) * 1e-4;
    const flatZero = v0 === 0 && (f(d) === 0 || f(-d) === 0);
    if (tame(v0, g.size) && !flatZero && !out.some(near)) out.push({ kind: "intercept", t: 0, v: clean(v0, Math.abs(v0)) });
  }
  return out.sort((p, q) => p.t - q.t);
}

/** Where y = f(x) meets y = g(x) on [a, b]. */
export function intersections(
  f: (t: number) => number,
  g: (t: number) => number,
  a: number,
  b: number,
): Poi[] {
  const d = (t: number) => f(t) - g(t);
  const size = grid(f, a, b, SAMPLES).size;
  return zeros(d, a, b)
    .map((t) => {
      const v = f(t);
      return { kind: "intersection" as const, t, v: clean(v, Math.abs(v)) };
    })
    .filter((p) => tame(p.v, size) && Number.isFinite(g(p.t)));
}

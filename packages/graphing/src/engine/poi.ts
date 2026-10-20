// Points of interest on explicit curves (D-4): zeros, extrema, the
// intercept on the other axis, and intersections between two curves. A
// tap on a curve shows these; the trace steps between them.
//
// Every search runs over the visible range, sampled finely and refined
// numerically. A sign change across a pole (1/x at 0) is not a zero, and a
// spike beside a pole is not an extremum.

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
  for (let k = 0; k < 80; k++) {
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
  for (let k = 0; k < 100 && hi - lo > 1e-13 * Math.max(1, Math.abs(lo)); k++) {
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
 * is flat there); bisecting on the sign of a central difference gets to
 * ~1e-11, so a vertex at x = −2 reads as −2.
 */
function refineExtremum(f: (t: number) => number, a: number, b: number, x0: number, max: boolean): number {
  const h = (b - a) * 1e-6;
  const rising = (x: number) => (f(x + h) - f(x - h)) * (max ? 1 : -1) > 0;
  let lo = Math.max(a, x0 - (b - a) / 4);
  let hi = Math.min(b, x0 + (b - a) / 4);
  if (!rising(lo) || rising(hi)) return x0;
  for (let k = 0; k < 80; k++) {
    const m = (lo + hi) / 2;
    if (m === lo || m === hi) break;
    if (rising(m)) lo = m;
    else hi = m;
  }
  const x = (lo + hi) / 2;
  const better = max ? f(x) >= f(x0) - 1e-12 * Math.abs(f(x0)) : f(x) <= f(x0) + 1e-12 * Math.abs(f(x0));
  return better ? x : x0;
}

/** Rounds away float noise so 0.9999999999998 reads as 1. */
export function clean(x: number, span: number): number {
  if (!Number.isFinite(x)) return x;
  const tol = Math.max(Math.abs(span), 1) * 1e-9;
  const r = Math.round(x);
  if (Math.abs(x - r) < tol) return r === 0 ? 0 : r;
  // Also snap to a short decimal (0.5, 0.25, 1.4142 stays as is).
  for (const p of [10, 100, 1000, 10000]) {
    const q = Math.round(x * p) / p;
    if (Math.abs(x - q) < tol) return q;
  }
  return x;
}

function grid(f: (t: number) => number, a: number, b: number, n: number): { t: number[]; v: number[] } {
  const t: number[] = [];
  const v: number[] = [];
  for (let k = 0; k <= n; k++) {
    const x = a + ((b - a) * k) / n;
    t.push(x);
    v.push(f(x));
  }
  return { t, v };
}

/** Zeros of f on [a, b]: sign changes, exact hits, and touching zeros. */
export function zeros(f: (t: number) => number, a: number, b: number, n = SAMPLES): number[] {
  const { t, v } = grid(f, a, b, n);
  const span = b - a;
  const out: number[] = [];
  const scale = magnitude(v);
  for (let k = 0; k <= n; k++) {
    const vk = v[k]!;
    if (vk === 0) {
      out.push(t[k]!);
      continue;
    }
    if (k === n) break;
    const vn = v[k + 1]!;
    if (!Number.isFinite(vk) || !Number.isFinite(vn) || vn === 0) continue;
    if (Math.sign(vk) !== Math.sign(vn)) {
      const r = bisect(f, t[k]!, t[k + 1]!, vk);
      const fr = f(r);
      // A pole flips sign too; a real zero ends near zero.
      if (Number.isFinite(fr) && Math.abs(fr) <= 1e-6 * Math.max(1, scale)) out.push(r);
    }
  }
  // Touching zeros (x² at 0) show up as minima of |f| that reach 0.
  for (const e of extremaRaw(f, t, v)) {
    if (Math.abs(e.v) <= 1e-9 * Math.max(1, scale)) out.push(e.t);
  }
  return dedupe(out.map((x) => clean(x, span)), span);
}

function magnitude(v: number[]): number {
  let m = 0;
  for (const x of v) if (Number.isFinite(x)) m = Math.max(m, Math.abs(x));
  return m;
}

function dedupe(xs: number[], span: number): number[] {
  const tol = Math.abs(span) * 1e-7;
  const s = [...xs].sort((p, q) => p - q);
  const out: number[] = [];
  for (const x of s) if (out.length === 0 || Math.abs(x - out[out.length - 1]!) > tol) out.push(x);
  return out;
}

interface Extremum {
  t: number;
  v: number;
  max: boolean;
}

function extremaRaw(f: (t: number) => number, t: number[], v: number[]): Extremum[] {
  const out: Extremum[] = [];
  const n = t.length - 1;
  for (let k = 1; k < n; k++) {
    const p = v[k - 1]!;
    const c = v[k]!;
    const q = v[k + 1]!;
    if (!Number.isFinite(p) || !Number.isFinite(c) || !Number.isFinite(q)) continue;
    const isMax = c > p && c >= q;
    const isMin = c < p && c <= q;
    if (!isMax && !isMin) continue;
    const x = refineExtremum(f, t[k - 1]!, t[k + 1]!, golden(f, t[k - 1]!, t[k + 1]!, isMax), isMax);
    const fx = f(x);
    if (!Number.isFinite(fx)) continue;
    // A spike beside a pole: the value runs off far beyond its neighbours.
    const local = Math.max(Math.abs(p - c), Math.abs(q - c));
    if (Math.abs(fx - c) > 10 * local + 1e-9) continue;
    out.push({ t: x, v: fx, max: isMax });
  }
  return out;
}

/** Local maxima and minima of f strictly inside [a, b]. */
export function extrema(f: (t: number) => number, a: number, b: number, n = SAMPLES): Extremum[] {
  const { t, v } = grid(f, a, b, n);
  const span = b - a;
  const raw = extremaRaw(f, t, v);
  const seen: Extremum[] = [];
  for (const e of raw) {
    const ct = clean(e.t, span);
    if (seen.some((s) => Math.abs(s.t - ct) < Math.abs(span) * 1e-7)) continue;
    seen.push({ t: ct, v: clean(f(ct), span), max: e.max });
  }
  return seen;
}

/** Everything worth a dot on y = f(x) within [a, b]. */
export function pointsOfInterest(f: (t: number) => number, a: number, b: number): Poi[] {
  const span = b - a;
  const out: Poi[] = [];
  for (const z of zeros(f, a, b)) out.push({ kind: "zero", t: z, v: 0 });
  for (const e of extrema(f, a, b)) {
    // A touching zero is reported once, as a zero.
    if (out.some((p) => p.kind === "zero" && Math.abs(p.t - e.t) < Math.abs(span) * 1e-7)) continue;
    out.push({ kind: e.max ? "max" : "min", t: e.t, v: e.v });
  }
  if (a <= 0 && b >= 0) {
    const v0 = f(0);
    if (Number.isFinite(v0) && !out.some((p) => p.t === 0)) out.push({ kind: "intercept", t: 0, v: clean(v0, span) });
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
  const span = b - a;
  return zeros(d, a, b)
    .map((t) => ({ kind: "intersection" as const, t, v: clean(f(t), span) }))
    .filter((p) => Number.isFinite(p.v) && Number.isFinite(g(p.t)));
}

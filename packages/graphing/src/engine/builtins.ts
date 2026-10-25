// Built-in functions and constants (D-4). Each entry carries a `group` so a
// calculator configuration can switch whole families off — the Washington
// state-test preset (D-6) disables reciprocal and hyperbolic trig,
// distance, some statistics, distributions and `random`.

export type FunctionGroup =
  | "trig"
  | "inverseTrig"
  | "reciprocalTrig"
  | "hyperbolic"
  | "log"
  | "rounding"
  | "numberTheory"
  | "stats"
  | "advancedStats"
  | "combinatorics"
  | "geometry"
  | "misc";

export interface Builtin {
  group: FunctionGroup;
  /** Argument count; `aggregate` functions take any number, lists spread. */
  arity: number | "aggregate";
  /** Second accepted arity (e.g. `round(x)` and `round(x, n)`). */
  altArity?: number;
  /** Angle handling: inputs to `forward` and outputs of `inverse` follow
   *  the degree/radian setting. */
  angle?: "forward" | "inverse";
  fn: (...args: number[]) => number;
}

const R3 = Math.sqrt(3) / 2;
const R2 = Math.SQRT1_2;
/** sin at multiples of 30°, and of 45°. */
const SIN30 = [0, 0.5, R3, 1, R3, 0.5, 0, -0.5, -R3, -1, -R3, -0.5];
const SIN45 = [0, R2, 1, R2, 0, -R2, -1, -R2];

/**
 * [sin, cos] with exact values at the angles students check: sin π and
 * cos 90° are 0, sin 30° is 0.5, tan 45° is 1 — not 1.2e-16, 0.49999999999999994
 * or 0.9999999999999999. `turn` is the angle as a fraction of a full turn.
 */
export function sinCos(rad: number, turn: number): [number, number] {
  for (const [steps, table] of [
    [12, SIN30],
    [8, SIN45],
  ] as const) {
    const k = turn * steps;
    const r = Math.round(k);
    if (Math.abs(k - r) <= 1e-12 * Math.max(1, Math.abs(k))) {
      const i = ((r % steps) + steps) % steps;
      return [table[i]!, table[(i + steps / 4) % steps]!];
    }
  }
  return [Math.sin(rad), Math.cos(rad)];
}

const TURN = 2 * Math.PI;
const trig = (pick: (s: number, c: number) => number) => (x: number) => {
  const [s, c] = sinCos(x, x / TURN);
  return pick(s, c);
};
/** A ratio with an exact-zero denominator is undefined, not ±1.6e16. */
const ratio = (n: number, d: number) => (d === 0 ? NaN : n / d);
export const sin = trig((s) => s);
export const cos = trig((_, c) => c);
export const tan = trig((s, c) => ratio(s, c));
const sec = trig((_, c) => ratio(1, c));
const csc = trig((s) => ratio(1, s));
const cot = trig((s, c) => ratio(c, s));

/** The same functions taking degrees. */
export const DEGREE_TRIG: Record<string, (x: number) => number> = {
  sin: (x) => sinCos(x * (Math.PI / 180), x / 360)[0],
  cos: (x) => sinCos(x * (Math.PI / 180), x / 360)[1],
  tan: (x) => {
    const [s, c] = sinCos(x * (Math.PI / 180), x / 360);
    return ratio(s, c);
  },
  sec: (x) => ratio(1, sinCos(x * (Math.PI / 180), x / 360)[1]),
  csc: (x) => ratio(1, sinCos(x * (Math.PI / 180), x / 360)[0]),
  cot: (x) => {
    const [s, c] = sinCos(x * (Math.PI / 180), x / 360);
    return ratio(c, s);
  },
};

/** log_b x, exact when x is a power of b: log₁₀ 1000 is 3, not 2.9999999999999996. */
export function logBase(x: number, b: number): number {
  if (b === 10) return Math.log10(x);
  if (b === 2) return Math.log2(x);
  const r = Math.log(x) / Math.log(b);
  const n = Math.round(r);
  if (Math.abs(r - n) < 1e-9 && Math.pow(b, n) === x) return n;
  return r;
}

/** Lanczos approximation (g = 7, n = 9); exact at small integers. */
export function gamma(x: number): number {
  if (Number.isInteger(x)) {
    if (x <= 0) return NaN;
    if (x <= 171) {
      let r = 1;
      for (let i = 2; i < x; i++) r *= i;
      return r;
    }
    return Infinity;
  }
  if (x < 0.5) return Math.PI / (Math.sin(Math.PI * x) * gamma(1 - x));
  const g = 7;
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];
  x -= 1;
  let a = c[0]!;
  const t = x + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += c[i]! / (x + i);
  // t^(x+½) overflows before e^-t can bring it back (170.5!): split it.
  const half = Math.pow(t, (x + 0.5) / 2);
  return Math.sqrt(2 * Math.PI) * half * (Math.exp(-t) * a) * half;
}

export function factorial(n: number): number {
  return gamma(n + 1);
}

function gcd2(a: number, b: number): number {
  a = Math.abs(a);
  b = Math.abs(b);
  if (!Number.isInteger(a) || !Number.isInteger(b)) return NaN;
  while (b) [a, b] = [b, a % b];
  return a;
}

function mean(...xs: number[]): number {
  if (xs.length === 0) return NaN;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

function variance(xs: number[], sample: boolean): number {
  const n = xs.length;
  if (n === 0 || (sample && n === 1)) return NaN;
  const m = mean(...xs);
  let s = 0;
  for (const x of xs) s += (x - m) * (x - m);
  return s / (sample ? n - 1 : n);
}

function median(...xs: number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function choose(n: number, k: number): number {
  if (!Number.isInteger(n) || !Number.isInteger(k) || k < 0 || n < 0) return NaN;
  if (k > n) return 0;
  k = Math.min(k, n - k);
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return Math.round(r);
}

function permute(n: number, k: number): number {
  if (!Number.isInteger(n) || !Number.isInteger(k) || k < 0 || n < 0) return NaN;
  if (k > n) return 0;
  let r = 1;
  for (let i = 0; i < k; i++) r *= n - i;
  return r;
}

export const BUILTINS: Record<string, Builtin> = {
  sin: { group: "trig", arity: 1, angle: "forward", fn: sin },
  cos: { group: "trig", arity: 1, angle: "forward", fn: cos },
  tan: { group: "trig", arity: 1, angle: "forward", fn: tan },
  sec: { group: "reciprocalTrig", arity: 1, angle: "forward", fn: sec },
  csc: { group: "reciprocalTrig", arity: 1, angle: "forward", fn: csc },
  cot: { group: "reciprocalTrig", arity: 1, angle: "forward", fn: cot },
  arcsin: { group: "inverseTrig", arity: 1, angle: "inverse", fn: Math.asin },
  arccos: { group: "inverseTrig", arity: 1, angle: "inverse", fn: Math.acos },
  // arctan(y, x) is the two-argument (quadrant-aware) form.
  arctan: {
    group: "inverseTrig",
    arity: 1,
    altArity: 2,
    angle: "inverse",
    fn: (y: number, x?: number) => (x === undefined ? Math.atan(y) : Math.atan2(y, x)),
  },
  arcsec: { group: "reciprocalTrig", arity: 1, angle: "inverse", fn: (x) => Math.acos(1 / x) },
  arccsc: { group: "reciprocalTrig", arity: 1, angle: "inverse", fn: (x) => Math.asin(1 / x) },
  arccot: {
    group: "reciprocalTrig",
    arity: 1,
    angle: "inverse",
    fn: (x) => (x === 0 ? Math.PI / 2 : Math.atan(1 / x) + (x < 0 ? Math.PI : 0)),
  },
  sinh: { group: "hyperbolic", arity: 1, fn: Math.sinh },
  cosh: { group: "hyperbolic", arity: 1, fn: Math.cosh },
  tanh: { group: "hyperbolic", arity: 1, fn: Math.tanh },
  sech: { group: "hyperbolic", arity: 1, fn: (x) => 1 / Math.cosh(x) },
  csch: { group: "hyperbolic", arity: 1, fn: (x) => 1 / Math.sinh(x) },
  coth: { group: "hyperbolic", arity: 1, fn: (x) => 1 / Math.tanh(x) },
  arcsinh: { group: "hyperbolic", arity: 1, fn: Math.asinh },
  arccosh: { group: "hyperbolic", arity: 1, fn: Math.acosh },
  arctanh: { group: "hyperbolic", arity: 1, fn: Math.atanh },
  ln: { group: "log", arity: 1, fn: Math.log },
  // log(x) is base 10; `\log_b x` parses to logb(x, b).
  log: { group: "log", arity: 1, fn: Math.log10 },
  logb: { group: "log", arity: 2, fn: logBase },
  exp: { group: "log", arity: 1, fn: Math.exp },
  sqrt: { group: "misc", arity: 1, fn: Math.sqrt },
  abs: { group: "misc", arity: 1, fn: Math.abs },
  sign: { group: "misc", arity: 1, fn: Math.sign },
  floor: { group: "rounding", arity: 1, fn: Math.floor },
  ceil: { group: "rounding", arity: 1, fn: Math.ceil },
  round: {
    group: "rounding",
    arity: 1,
    altArity: 2,
    fn: (x: number, n?: number) => {
      if (n === undefined) return Math.round(x);
      // Decimal shifting through the exponent avoids 1.005·100 = 100.49999….
      const d = Math.trunc(n);
      const shifted = Math.round(Number(`${x}e${d}`));
      const back = Number(`${shifted}e${-d}`);
      return Number.isFinite(back) ? back : Math.round(x * Math.pow(10, d)) / Math.pow(10, d);
    },
  },
  // Desmos's mod takes the sign of the divisor.
  mod: { group: "numberTheory", arity: 2, fn: (a, b) => a - b * Math.floor(a / b) },
  gcd: {
    group: "numberTheory",
    arity: "aggregate",
    fn: (...xs) => (xs.length ? xs.reduce((a, b) => gcd2(a, b)) : NaN),
  },
  lcm: {
    group: "numberTheory",
    arity: "aggregate",
    fn: (...xs) =>
      xs.length ? xs.reduce((a, b) => (a === 0 || b === 0 ? 0 : Math.abs(a * b) / gcd2(a, b))) : NaN,
  },
  min: { group: "stats", arity: "aggregate", fn: (...xs) => (xs.length ? Math.min(...xs) : NaN) },
  max: { group: "stats", arity: "aggregate", fn: (...xs) => (xs.length ? Math.max(...xs) : NaN) },
  total: { group: "stats", arity: "aggregate", fn: (...xs) => xs.reduce((a, b) => a + b, 0) },
  length: { group: "stats", arity: "aggregate", fn: (...xs) => xs.length },
  mean: { group: "stats", arity: "aggregate", fn: mean },
  median: { group: "stats", arity: "aggregate", fn: median },
  stdev: { group: "stats", arity: "aggregate", fn: (...xs) => Math.sqrt(variance(xs, true)) },
  stdevp: { group: "stats", arity: "aggregate", fn: (...xs) => Math.sqrt(variance(xs, false)) },
  var: { group: "stats", arity: "aggregate", fn: (...xs) => variance(xs, true) },
  varp: { group: "stats", arity: "aggregate", fn: (...xs) => variance(xs, false) },
  mad: {
    group: "advancedStats",
    arity: "aggregate",
    fn: (...xs) => {
      const m = mean(...xs);
      return mean(...xs.map((x) => Math.abs(x - m)));
    },
  },
  nCr: { group: "combinatorics", arity: 2, fn: choose },
  nPr: { group: "combinatorics", arity: 2, fn: permute },
};

/** Function names the parser recognises when typed as a run of letters. */
export const FUNCTION_NAMES: ReadonlySet<string> = new Set([...Object.keys(BUILTINS), "distance"]);

/** LaTeX commands that name a built-in function directly. */
export const LATEX_FUNCTIONS: Readonly<Record<string, string>> = {
  sin: "sin",
  cos: "cos",
  tan: "tan",
  sec: "sec",
  csc: "csc",
  cot: "cot",
  arcsin: "arcsin",
  arccos: "arccos",
  arctan: "arctan",
  sinh: "sinh",
  cosh: "cosh",
  tanh: "tanh",
  coth: "coth",
  ln: "ln",
  log: "log",
  exp: "exp",
  min: "min",
  max: "max",
  gcd: "gcd",
};

export const CONSTANTS: Readonly<Record<string, number>> = {
  pi: Math.PI,
  e: Math.E,
  tau: 2 * Math.PI,
};

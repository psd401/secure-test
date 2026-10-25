// Slice 8 (D-11 "later"): a graph in words and in sound. A curve's summary
// reads its points of interest in the current view — where it crosses the
// axes, its turning points — so a student who can't see the canvas hears
// what a sighted student sees at a glance. The sound side maps a curve's
// value to pitch (higher y, higher note) and its position to stereo pan
// (left of the view, left ear); the UI plays it with Web Audio.

import { formatNumber } from "./format";
import { clean, pointsOfInterest } from "./poi";

export interface View {
  xmin: number;
  xmax: number;
  ymin: number;
  ymax: number;
}

/** Spoken numbers: four significant digits, float noise trimmed. */
export function spokenNumber(x: number, span: number): string {
  const c = clean(x, span);
  if (!Number.isFinite(c)) return "undefined";
  const r = Math.abs(c) >= 1e-6 && Math.abs(c) < 1e12 ? Number(c.toPrecision(4)) : c;
  return formatNumber(r).replace(/^-/, "−");
}

function list(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

const MAX_LISTED = 6;

function capped(items: string[]): string {
  if (items.length <= MAX_LISTED) return list(items);
  return `${list(items.slice(0, MAX_LISTED))}, and ${items.length - MAX_LISTED} more`;
}

/**
 * One curve in words, for the part of it in `view`: "y = x² − 4: crosses
 * the x-axis at x = −2 and 2; minimum at (0, −4); crosses the y-axis at
 * y = −4." `of` is the curve's own axis ("y" for y = f(x)).
 */
export function summarizeCurve(label: string, f: (t: number) => number, of: "x" | "y", view: View): string {
  const ofY = of === "y";
  const [a, b] = ofY ? [view.xmin, view.xmax] : [view.ymin, view.ymax];
  const [lo, hi] = ofY ? [view.ymin, view.ymax] : [view.xmin, view.xmax];
  const tSpan = b - a;
  const vSpan = hi - lo;
  // Is any of it in view at all?
  let seen = false;
  let defined = false;
  for (let k = 0; k <= 200; k++) {
    const v = f(a + (tSpan * k) / 200);
    if (!Number.isFinite(v)) continue;
    defined = true;
    if (v >= lo && v <= hi) {
      seen = true;
      break;
    }
  }
  const name = label.trim() || "This curve";
  if (!defined) return `${name}: not defined anywhere in this view.`;
  if (!seen) return `${name}: not in this view.`;

  const pois = pointsOfInterest(f, a, b).filter((p) => p.v >= lo && p.v <= hi);
  const pt = (t: number, v: number) =>
    ofY ? `(${spokenNumber(t, tSpan)}, ${spokenNumber(v, vSpan)})` : `(${spokenNumber(v, vSpan)}, ${spokenNumber(t, tSpan)})`;
  const own = ofY ? "x" : "y";
  const other = ofY ? "y" : "x";
  const parts: string[] = [];
  const zeros = pois.filter((p) => p.kind === "zero").map((p) => spokenNumber(p.t, tSpan));
  if (zeros.length) parts.push(`crosses the ${own}-axis at ${own} = ${capped(zeros)}`);
  const maxes = pois.filter((p) => p.kind === "max").map((p) => pt(p.t, p.v));
  if (maxes.length) parts.push(`${maxes.length === 1 ? "maximum" : "maxima"} at ${capped(maxes)}`);
  const mins = pois.filter((p) => p.kind === "min").map((p) => pt(p.t, p.v));
  if (mins.length) parts.push(`${mins.length === 1 ? "minimum" : "minima"} at ${capped(mins)}`);
  // The intercept is left out of the points of interest when another one
  // (a turning point, a zero) is already there.
  const cross = pois.find((p) => p.kind === "intercept") ?? pois.find((p) => Math.abs(p.t) < Math.abs(tSpan) * 1e-7);
  if (cross && cross.kind === "zero") parts.push("passes through the origin");
  else if (cross) parts.push(`crosses the ${other}-axis at ${other} = ${spokenNumber(cross.v, vSpan)}`);
  if (!parts.length) parts.push(trend(f, a, b, own, other));
  return `${name}: ${parts.join("; ")}.`;
}

/** For a curve with no points of interest in view: which way it goes. */
function trend(f: (t: number) => number, a: number, b: number, own: string, other: string): string {
  const fa = f(a + (b - a) * 0.01);
  const fb = f(b - (b - a) * 0.01);
  if (!Number.isFinite(fa) || !Number.isFinite(fb)) return "no axis crossings or turning points in this view";
  const d = fb - fa;
  const flat = Math.abs(d) < 1e-9 * Math.max(1, Math.abs(fa));
  if (flat) return `stays at ${other} = ${spokenNumber(fa, Math.abs(fa) || 1)} across this view`;
  return `${other} ${d > 0 ? "increases" : "decreases"} as ${own} increases, with no axis crossings or turning points in this view`;
}

/** Several curves: one sentence each, then the view. */
export function summarizeGraph(curves: string[], view: View): string {
  const span = Math.max(view.xmax - view.xmin, view.ymax - view.ymin);
  const where = `The view shows x from ${spokenNumber(view.xmin, span)} to ${spokenNumber(view.xmax, span)} and y from ${spokenNumber(view.ymin, span)} to ${spokenNumber(view.ymax, span)}.`;
  if (!curves.length) return `Nothing is graphed. ${where}`;
  return `${curves.join(" ")} ${where}`;
}

/** Lowest and highest notes of the sound trace, in hertz (A3 … A5). */
export const LOW_HZ = 220;
export const HIGH_HZ = 880;

/**
 * Pitch for a value: `lo` → LOW_HZ, `hi` → HIGH_HZ, evenly in musical
 * steps (log-frequency) between; outside the view it clamps. Not finite → null.
 */
export function toneFor(v: number, lo: number, hi: number): number | null {
  if (!Number.isFinite(v) || !(hi > lo)) return null;
  const u = Math.max(0, Math.min(1, (v - lo) / (hi - lo)));
  return LOW_HZ * Math.pow(HIGH_HZ / LOW_HZ, u);
}

/** Stereo position for a point along the view: −1 (left) … 1 (right). */
export function panFor(t: number, a: number, b: number): number {
  if (!(b > a)) return 0;
  return Math.max(-1, Math.min(1, ((t - a) / (b - a)) * 2 - 1));
}

export interface Tone {
  /** Hertz, or null for a gap (undefined, or out of the view). */
  freq: number | null;
  pan: number;
}

/**
 * The sweep the sound trace plays: `steps` notes across the view, left to
 * right. A value outside the view is a gap — the curve has left the screen —
 * as is anywhere the curve is undefined.
 */
export function sweep(f: (t: number) => number, of: "x" | "y", view: View, steps = 120): Tone[] {
  const ofY = of === "y";
  const [a, b] = ofY ? [view.xmin, view.xmax] : [view.ymin, view.ymax];
  const [lo, hi] = ofY ? [view.ymin, view.ymax] : [view.xmin, view.xmax];
  const out: Tone[] = [];
  for (let k = 0; k < steps; k++) {
    const t = a + ((b - a) * (k + 0.5)) / steps;
    const v = f(t);
    const inView = Number.isFinite(v) && v >= lo && v <= hi;
    out.push({ freq: inView ? toneFor(v, lo, hi) : null, pan: panFor(t, a, b) });
  }
  return out;
}

// The calculator's editable state — the expression rows, their colours and
// slider ranges, the angle mode and the view — as plain data with pure
// updates, so tests can drive it without a DOM and a graph can be saved
// as JSON (a stimulus, D-8).

import type { Viewport } from "./viewport";

export interface SliderRange {
  min: number;
  max: number;
  step: number;
}

export interface RowState {
  id: string;
  latex: string;
  color: string;
  hidden: boolean;
  /** Present once the row has been a slider; kept across value edits. */
  slider?: SliderRange;
}

export interface CalcState {
  rows: RowState[];
  degrees: boolean;
  viewport: Viewport;
}

/**
 * Curve colours: distinct hues, each at least 4.5:1 on white so a thin
 * line stays visible (WCAG 1.4.11 needs 3:1). Our own palette (D-10).
 */
export const PALETTE = ["#1f5fa8", "#b42b2b", "#2c7a37", "#6a3d9a", "#a35200", "#1a1a1a"] as const;

let counter = 0;
export function newId(): string {
  counter += 1;
  return `r${Date.now().toString(36)}${counter.toString(36)}`;
}

/** The palette colour used least among the rows (earliest on ties). */
export function nextColor(rows: readonly RowState[]): string {
  const counts = new Map<string, number>(PALETTE.map((c) => [c, 0]));
  for (const r of rows) if (counts.has(r.color)) counts.set(r.color, counts.get(r.color)! + 1);
  let best: string = PALETTE[0];
  let bestCount = Infinity;
  for (const c of PALETTE) {
    const n = counts.get(c)!;
    if (n < bestCount) {
      best = c;
      bestCount = n;
    }
  }
  return best;
}

export function emptyRow(rows: readonly RowState[], latex = ""): RowState {
  return { id: newId(), latex, color: nextColor(rows), hidden: false };
}

export function insertRow(rows: readonly RowState[], afterId: string | null, latex = ""): [RowState[], string] {
  const row = emptyRow(rows, latex);
  const i = afterId === null ? rows.length - 1 : rows.findIndex((r) => r.id === afterId);
  const out = [...rows];
  out.splice(i + 1, 0, row);
  return [out, row.id];
}

export function removeRow(rows: readonly RowState[], id: string): RowState[] {
  const out = rows.filter((r) => r.id !== id);
  return out.length ? out : [emptyRow([])];
}

export function updateRow(rows: readonly RowState[], id: string, patch: Partial<RowState>): RowState[] {
  return rows.map((r) => (r.id === id ? { ...r, ...patch } : r));
}

/** Desmos-style default range, widened to include the value. */
export function defaultRange(value: number): SliderRange {
  if (value >= -10 && value <= 10) return { min: -10, max: 10, step: 0 };
  const mag = Math.pow(10, Math.ceil(Math.log10(Math.abs(value) + 1)));
  return { min: value < 0 ? -mag : 0, max: value < 0 ? 0 : mag, step: 0 };
}

/** Rows `a=1`, `b=1`… for undefined names, inserted before `beforeId`. */
export function addSliders(rows: readonly RowState[], names: readonly string[], beforeId: string): RowState[] {
  const i = rows.findIndex((r) => r.id === beforeId);
  const at = i < 0 ? rows.length : i;
  const out = [...rows];
  const made: RowState[] = [];
  for (const name of names) {
    const row: RowState = { ...emptyRow([...out, ...made], `${latexName(name)}=1`), slider: defaultRange(1) };
    made.push(row);
  }
  out.splice(at, 0, ...made);
  return out;
}

/** An engine name as LaTeX: `a_1` → `a_{1}`, `theta` → `\theta`. */
export function latexName(name: string): string {
  const [base, sub] = name.split("_") as [string, string | undefined];
  const b = base.length > 1 ? `\\${base}` : base;
  return sub === undefined ? b : `${b}_{${sub}}`;
}

/** Replaces the value of a slider row's `name=value` LaTeX. */
export function setSliderValue(latex: string, value: number): string {
  const eq = latex.indexOf("=");
  if (eq < 0) return latex;
  return `${latex.slice(0, eq + 1)}${formatSliderValue(value)}`;
}

/** Up to 4 decimals, no float noise: 0.1+0.2 → 0.3. */
export function formatSliderValue(value: number): string {
  const s = Number(value.toFixed(4)).toString();
  return s === "-0" ? "0" : s;
}

/** Snaps a raw slider position to its step (or to 1/100 of the range). */
export function snapSlider(value: number, range: SliderRange): number {
  const step = range.step > 0 ? range.step : (range.max - range.min) / 100;
  const n = Math.round((value - range.min) / step);
  const v = range.min + n * step;
  return Math.min(range.max, Math.max(range.min, Number(v.toPrecision(12))));
}

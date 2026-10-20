// The visible window of the graph and the maths of moving it: pixel ↔
// graph coordinates, zoom about a point, pan, resize, and grid steps of
// 1, 2 or 5 × 10ⁿ. Pure, so it is unit-tested without a canvas.

export interface Viewport {
  xmin: number;
  xmax: number;
  ymin: number;
  ymax: number;
  /** CSS pixels. */
  width: number;
  height: number;
}

/** A square-scaled view centred on (cx, cy) showing ±halfWidth across. */
export function makeViewport(width: number, height: number, halfWidth = 10, cx = 0, cy = 0): Viewport {
  const w = Math.max(width, 1);
  const h = Math.max(height, 1);
  const halfHeight = (halfWidth * h) / w;
  return { xmin: cx - halfWidth, xmax: cx + halfWidth, ymin: cy - halfHeight, ymax: cy + halfHeight, width: w, height: h };
}

export function toPx(v: Viewport, x: number, y: number): [number, number] {
  return [((x - v.xmin) / (v.xmax - v.xmin)) * v.width, ((v.ymax - y) / (v.ymax - v.ymin)) * v.height];
}

export function fromPx(v: Viewport, px: number, py: number): [number, number] {
  return [v.xmin + (px / v.width) * (v.xmax - v.xmin), v.ymax - (py / v.height) * (v.ymax - v.ymin)];
}

/** Pixels per graph unit along x and y. */
export function scale(v: Viewport): [number, number] {
  return [v.width / (v.xmax - v.xmin), v.height / (v.ymax - v.ymin)];
}

const MIN_SPAN = 1e-9;
const MAX_SPAN = 1e12;

/** Zoom by `factor` (> 1 zooms in) keeping the graph point under (px, py) fixed. */
export function zoomAt(v: Viewport, factor: number, px: number, py: number): Viewport {
  const [x, y] = fromPx(v, px, py);
  const span = (v.xmax - v.xmin) / factor;
  if (span < MIN_SPAN || span > MAX_SPAN) return v;
  const fx = px / v.width;
  const fy = py / v.height;
  const xspan = span;
  const yspan = (v.ymax - v.ymin) / factor;
  return {
    ...v,
    xmin: x - fx * xspan,
    xmax: x + (1 - fx) * xspan,
    ymax: y + fy * yspan,
    ymin: y - (1 - fy) * yspan,
  };
}

/** Move the graph with the pointer: dragging right shows what was left. */
export function pan(v: Viewport, dxPx: number, dyPx: number): Viewport {
  const [sx, sy] = scale(v);
  const dx = dxPx / sx;
  const dy = dyPx / sy;
  return { ...v, xmin: v.xmin - dx, xmax: v.xmax - dx, ymin: v.ymin + dy, ymax: v.ymax + dy };
}

/** New pixel size, same centre and scale. */
export function resize(v: Viewport, width: number, height: number): Viewport {
  const w = Math.max(width, 1);
  const h = Math.max(height, 1);
  const [sx, sy] = scale(v);
  const cx = (v.xmin + v.xmax) / 2;
  const cy = (v.ymin + v.ymax) / 2;
  return { xmin: cx - w / sx / 2, xmax: cx + w / sx / 2, ymin: cy - h / sy / 2, ymax: cy + h / sy / 2, width: w, height: h };
}

export interface GridStep {
  major: number;
  minor: number;
}

/** A major step of 1, 2 or 5 × 10ⁿ giving at least `minPx` between lines. */
export function gridStep(span: number, px: number, minPx = 80): GridStep {
  const raw = (span / px) * minPx;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 5, 10]) {
    if (m * p >= raw) {
      const major = m * p;
      return { major, minor: major / (m === 2 ? 4 : 5) };
    }
  }
  return { major: 10 * p, minor: 2 * p };
}

/** Multiples of `step` within [min, max], computed without drift. */
export function ticks(min: number, max: number, step: number): number[] {
  const out: number[] = [];
  const first = Math.ceil(min / step);
  const last = Math.floor(max / step);
  if (last - first > 2000) return out;
  for (let k = first; k <= last; k++) out.push(k * step);
  return out;
}

/** A tick label with only the decimals the step needs: 0.2, not 0.20000000000000004. */
export function tickLabel(value: number, step: number): string {
  if (Math.abs(value) < step * 1e-9) return "0";
  const abs = Math.abs(value);
  if (abs >= 1e6 || (abs < 1e-4 && abs > 0)) {
    const e = Math.floor(Math.log10(abs));
    const m = value / Math.pow(10, e);
    const mt = Number(m.toFixed(Math.max(0, -Math.floor(Math.log10(step / Math.pow(10, e))))));
    return `${mt}×10^${e}`;
  }
  const decimals = Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
  return (value < 0 ? "−" : "") + abs.toFixed(decimals);
}

// A graph as an SVG string (D-5 / D-8): the design tool's preview and print
// views are server-rendered without scripts, so a stimulus graph is drawn
// here, on the server, with the same engine the student's calculator uses.
// Pure string building — no DOM.

import { analyze, type Analysis, type Curve } from "./analyze";
import type { GraphBoard, GraphObject } from "./graphAnswer";
import { chainSegments, traceImplicit, traceRegion } from "./implicit";
import { restricted } from "./index";
import { sampleCurve } from "./sample";
import { gridStep, tickLabel, ticks } from "../ui/viewport";

export interface SvgGraph {
  rows: { latex: string; color?: string; hidden?: boolean }[];
  view: { xmin: number; xmax: number; ymin: number; ymax: number };
  degrees?: boolean;
}

export interface SvgOptions {
  width?: number;
  height?: number;
  /** Accessible name (the stimulus's alt text). */
  title?: string;
}

const DEFAULT_COLORS = ["#1f5fa8", "#b42b2b", "#2c7a37", "#6a3d9a", "#a35200", "#1a1a1a"];

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function color(c: string | undefined, i: number): string {
  return c && /^#[0-9a-fA-F]{6}$/.test(c) ? c : DEFAULT_COLORS[i % DEFAULT_COLORS.length]!;
}

const r1 = (v: number) => Math.round(v * 10) / 10;

export function renderGraphSvg(g: SvgGraph, opts: SvgOptions = {}): string {
  const W = opts.width ?? 480;
  const H = opts.height ?? 360;
  const { xmin, xmax, ymin, ymax } = g.view;
  const sx = W / (xmax - xmin);
  const sy = H / (ymax - ymin);
  const X = (x: number) => (x - xmin) * sx;
  const Y = (y: number) => (ymax - y) * sy;
  const clampPx = (v: number) => Math.max(-1e5, Math.min(1e5, v));
  const out: string[] = [];
  const title = opts.title ?? "Graph";
  // Several graphs on one page share a clip only when they share a size.
  const clip = `gclip-${W}x${H}`;
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(title)}" class="graph-svg">`,
    `<title>${esc(title)}</title>`,
    `<defs><clipPath id="${clip}"><rect x="0" y="0" width="${W}" height="${H}"/></clipPath></defs>`,
    `<rect x="0" y="0" width="${W}" height="${H}" fill="#ffffff" stroke="#cfd5dd"/>`,
  );

  // Grid: one step for both axes when the scales match.
  const stepX = gridStep(xmax - xmin, W);
  const square = Math.abs(sx - sy) / sx < 1e-6;
  const stepY = square ? stepX : gridStep(ymax - ymin, H);
  const path = (xs: number[], ys: number[]) => [
    ...xs.map((x) => `M${r1(X(x))} 0V${H}`),
    ...ys.map((y) => `M0 ${r1(Y(y))}H${W}`),
  ];
  out.push(
    `<path d="${path(ticks(xmin, xmax, stepX.minor), ticks(ymin, ymax, stepY.minor)).join("")}" stroke="#eef0f3" stroke-width="1"/>`,
    `<path d="${path(ticks(xmin, xmax, stepX.major), ticks(ymin, ymax, stepY.major)).join("")}" stroke="#d3d8df" stroke-width="1"/>`,
  );
  const ox = X(0);
  const oy = Y(0);
  const axes: string[] = [];
  if (oy >= 0 && oy <= H) axes.push(`M0 ${r1(oy)}H${W}`);
  if (ox >= 0 && ox <= W) axes.push(`M${r1(ox)} 0V${H}`);
  if (axes.length) out.push(`<path d="${axes.join("")}" stroke="#2b2f36" stroke-width="1.5"/>`);
  const labels: string[] = [];
  const ly = Math.min(Math.max(oy + 14, 14), H - 4);
  for (const x of ticks(xmin, xmax, stepX.major)) {
    if (Math.abs(x) < stepX.major * 1e-9) continue;
    const px = X(x);
    if (px < 12 || px > W - 12) continue;
    labels.push(`<text x="${r1(px)}" y="${r1(ly)}" text-anchor="middle">${esc(tickLabel(x, stepX.major))}</text>`);
  }
  const lx = Math.min(Math.max(ox - 5, 26), W - 4);
  for (const y of ticks(ymin, ymax, stepY.major)) {
    if (Math.abs(y) < stepY.major * 1e-9) continue;
    const py = Y(y);
    if (py < 10 || py > H - 10) continue;
    labels.push(`<text x="${r1(lx)}" y="${r1(py + 4)}" text-anchor="end">${esc(tickLabel(y, stepY.major))}</text>`);
  }
  out.push(
    `<g font-family="-apple-system, Helvetica, Arial, sans-serif" font-size="11" fill="#3a404b" stroke="#ffffff" stroke-width="3" paint-order="stroke">${labels.join("")}</g>`,
  );

  // The rows, through the same analysis the calculator uses.
  const analyses = analyze(
    g.rows.map((r, i) => ({ id: String(i), latex: r.latex })),
    { degrees: g.degrees === true, disabled: new Set() },
  );
  const body: string[] = [];
  analyses.forEach((a, i) => {
    const row = g.rows[i]!;
    if (row.hidden) return;
    const c = color(row.color, i);
    body.push(...drawAnalysis(a, c, { W, H, xmin, xmax, ymin, ymax, X, Y, sx, sy, clampPx }));
  });
  out.push(`<g clip-path="url(#${clip})" fill="none" stroke-linecap="round" stroke-linejoin="round">${body.join("")}</g>`, `</svg>`);
  return out.join("");
}

interface Frame {
  W: number;
  H: number;
  xmin: number;
  xmax: number;
  ymin: number;
  ymax: number;
  X: (x: number) => number;
  Y: (y: number) => number;
  sx: number;
  sy: number;
  clampPx: (v: number) => number;
}

function curvePaths(c: Curve, f: Frame): number[][] {
  const fn = restricted(c);
  const ofY = c.of === "y";
  const pieces = ofY
    ? sampleCurve(fn, f.xmin, f.xmax, { pixels: f.W, valueScale: f.sy, valueSpanPx: f.H, visible: [f.ymin, f.ymax] })
    : sampleCurve(fn, f.ymin, f.ymax, { pixels: f.H, valueScale: f.sx, valueSpanPx: f.W, visible: [f.xmin, f.xmax] });
  return pieces.map((p) => {
    const pts: number[] = [];
    for (let k = 0; k < p.length; k += 2) {
      const [x, y] = ofY ? [p[k]!, p[k + 1]!] : [p[k + 1]!, p[k]!];
      pts.push(f.clampPx(f.X(x)), f.clampPx(f.Y(y)));
    }
    return pts;
  });
}

function d(points: number[]): string {
  let s = `M${r1(points[0]!)} ${r1(points[1]!)}`;
  for (let k = 2; k < points.length; k += 2) s += `L${r1(points[k]!)} ${r1(points[k + 1]!)}`;
  return s;
}

function drawAnalysis(a: Analysis, c: string, f: Frame): string[] {
  const out: string[] = [];
  const curve = a.kind === "curve" ? a : a.kind === "function" ? a.plot : null;
  if (curve) {
    const pieces = curvePaths(curve, f).filter((p) => p.length >= 4);
    const strict = curve.relation === "<" || curve.relation === ">";
    if (curve.relation !== "=") {
      const above = curve.relation === ">" || curve.relation === ">=";
      for (const p of pieces) {
        const ofY = curve.of === "y";
        const edge = ofY ? (above ? 0 : f.H) : above ? f.W : 0;
        const close = ofY
          ? `L${r1(p[p.length - 2]!)} ${edge}L${r1(p[0]!)} ${edge}Z`
          : `L${edge} ${r1(p[p.length - 1]!)}L${edge} ${r1(p[1]!)}Z`;
        out.push(`<path d="${d(p)}${close}" fill="${c}" fill-opacity="0.22" stroke="none"/>`);
      }
    }
    for (const p of pieces) {
      out.push(`<path d="${d(p)}" stroke="${c}" stroke-width="2.5"${strict ? ' stroke-dasharray="8 6"' : ""}/>`);
    }
  } else if (a.kind === "points") {
    for (const [x, y] of a.points) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      out.push(`<circle cx="${r1(f.X(x))}" cy="${r1(f.Y(y))}" r="4.5" fill="${c}" stroke="none"/>`);
    }
  } else if (a.kind === "implicit" || a.kind === "region") {
    const view = { xmin: f.xmin, xmax: f.xmax, ymin: f.ymin, ymax: f.ymax, widthPx: f.W, heightPx: f.H, leafPx: 2, budget: 60_000 };
    const r =
      a.kind === "implicit"
        ? traceImplicit({ f: a.f, fi: a.fi, relation: a.relation, restrict: a.restrict }, view)
        : traceRegion({ test: a.test, truth: a.truth, restrict: a.restrict }, view);
    if (r.fills.length) {
      let fill = "";
      for (let k = 0; k < r.fills.length; k += 4) {
        const x = f.X(r.fills[k]!);
        const y = f.Y(r.fills[k + 1]! + r.fills[k + 3]!);
        fill += `M${r1(x)} ${r1(y)}h${r1(r.fills[k + 2]! * f.sx + 0.5)}v${r1(r.fills[k + 3]! * f.sy + 0.5)}h${-r1(r.fills[k + 2]! * f.sx + 0.5)}Z`;
      }
      out.push(`<path d="${fill}" fill="${c}" fill-opacity="0.22" stroke="none"/>`);
    }
    const strict = a.kind === "implicit" && (a.relation === "<" || a.relation === ">");
    for (const line of chainSegments(r.segments, Math.max(f.xmax - f.xmin, f.ymax - f.ymin))) {
      const pts: number[] = [];
      for (let k = 0; k < line.length; k += 2) pts.push(f.X(line[k]!), f.Y(line[k + 1]!));
      out.push(`<path d="${d(pts)}" stroke="${c}" stroke-width="2.5"${strict ? ' stroke-dasharray="8 6"' : ""}/>`);
    }
  }
  return out;
}

// ---------- graph answers (D-9) ----------


export interface BoardSvgOptions {
  width?: number;
  title?: string;
  /** The student's objects (solid blue). */
  answer?: GraphObject[];
  /** The key's objects (dashed green). */
  key?: GraphObject[];
}

/**
 * A graph-answer board as SVG: the grid at the board's spacing, axes,
 * labels, the fixed objects, and optionally an answer and / or the key —
 * for the no-script preview, print, and the teacher's review of an answer.
 */
export function renderBoardSvg(board: GraphBoard, opts: BoardSvgOptions = {}): string {
  const W = opts.width ?? 400;
  const spanX = board.x[1] - board.x[0];
  const spanY = board.y[1] - board.y[0];
  const H = Math.round((W * spanY) / spanX);
  const X = (x: number) => ((x - board.x[0]) / spanX) * W;
  const Y = (y: number) => ((board.y[1] - y) / spanY) * H;
  const title = opts.title ?? "Graph";
  const clip = `bclip-${W}x${H}`;
  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(title)}" class="graph-svg">`,
    `<title>${esc(title)}</title>`,
    `<defs><clipPath id="${clip}"><rect x="0" y="0" width="${W}" height="${H}"/></clipPath></defs>`,
    `<rect x="0" y="0" width="${W}" height="${H}" fill="#ffffff" stroke="#cfd5dd"/>`,
  ];
  const grid = [
    ...ticks(board.x[0], board.x[1], board.grid).map((x) => `M${r1(X(x))} 0V${H}`),
    ...ticks(board.y[0], board.y[1], board.grid).map((y) => `M0 ${r1(Y(y))}H${W}`),
  ];
  out.push(`<path d="${grid.join("")}" stroke="#e3e7ec" stroke-width="1"/>`);
  const axes: string[] = [];
  if (board.y[0] <= 0 && board.y[1] >= 0) axes.push(`M0 ${r1(Y(0))}H${W}`);
  if (board.x[0] <= 0 && board.x[1] >= 0) axes.push(`M${r1(X(0))} 0V${H}`);
  if (axes.length) out.push(`<path d="${axes.join("")}" stroke="#2b2f36" stroke-width="1.5"/>`);
  const labels: string[] = [];
  const sx = gridStep(spanX, W, 40).major;
  const sy = gridStep(spanY, H, 40).major;
  const ly = Math.min(Math.max(Y(0) + 13, 13), H - 3);
  for (const x of ticks(board.x[0], board.x[1], sx)) {
    if (Math.abs(x) < sx * 1e-9 || X(x) < 10 || X(x) > W - 10) continue;
    labels.push(`<text x="${r1(X(x))}" y="${r1(ly)}" text-anchor="middle">${esc(tickLabel(x, sx))}</text>`);
  }
  const lx = Math.min(Math.max(X(0) - 4, 20), W - 2);
  for (const y of ticks(board.y[0], board.y[1], sy)) {
    if (Math.abs(y) < sy * 1e-9 || Y(y) < 8 || Y(y) > H - 8) continue;
    labels.push(`<text x="${r1(lx)}" y="${r1(Y(y) + 4)}" text-anchor="end">${esc(tickLabel(y, sy))}</text>`);
  }
  out.push(
    `<g font-family="-apple-system, Helvetica, Arial, sans-serif" font-size="11" fill="#3a404b" stroke="#ffffff" stroke-width="3" paint-order="stroke">${labels.join("")}</g>`,
  );
  const shapes: string[] = [];
  const draw = (o: GraphObject, color: string, dashed: boolean) => shapes.push(objectSvg(o, color, dashed, board, X, Y, W));
  for (const o of board.fixed ?? []) draw(o, "#6b7280", false);
  for (const o of opts.key ?? []) draw(o, "#2c7a37", true);
  for (const o of opts.answer ?? []) draw(o, "#1f5fa8", false);
  out.push(`<g clip-path="url(#${clip})" fill="none" stroke-width="2.5" stroke-linecap="round">${shapes.join("")}</g>`, "</svg>");
  return out.join("");
}

function objectSvg(
  o: GraphObject,
  color: string,
  dashed: boolean,
  board: GraphBoard,
  X: (x: number) => number,
  Y: (y: number) => number,
  W: number,
): string {
  const dash = dashed ? ' stroke-dasharray="7 5"' : "";
  const dot = (p: [number, number]) => `<circle cx="${r1(X(p[0]))}" cy="${r1(Y(p[1]))}" r="4.5" fill="${color}" stroke="none"/>`;
  const [a, b] = o.points as [[number, number], [number, number] | undefined];
  if (!a || !Number.isFinite(a[0]) || !Number.isFinite(a[1])) return "";
  if (o.tool === "point" || !b) return dot(a);
  if (!Number.isFinite(b[0]) || !Number.isFinite(b[1]) || (a[0] === b[0] && a[1] === b[1])) return dot(a);
  let path = "";
  if (o.tool === "segment") {
    path = `<path d="M${r1(X(a[0]))} ${r1(Y(a[1]))}L${r1(X(b[0]))} ${r1(Y(b[1]))}" stroke="${color}"${dash}/>`;
  } else if (o.tool === "line" || o.tool === "ray") {
    const big = 4 * Math.max(board.x[1] - board.x[0], board.y[1] - board.y[0]);
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const ux = ((b[0] - a[0]) / len) * big;
    const uy = ((b[1] - a[1]) / len) * big;
    const s = o.tool === "ray" ? a : [a[0] - ux, a[1] - uy];
    path = `<path d="M${r1(X(s[0]!))} ${r1(Y(s[1]!))}L${r1(X(a[0] + ux))} ${r1(Y(a[1] + uy))}" stroke="${color}"${dash}/>`;
  } else if (o.tool === "circle") {
    const r = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const rx = Math.abs(X(a[0] + r) - X(a[0]));
    const ry = Math.abs(Y(a[1] + r) - Y(a[1]));
    path = `<ellipse cx="${r1(X(a[0]))}" cy="${r1(Y(a[1]))}" rx="${r1(rx)}" ry="${r1(ry)}" stroke="${color}"${dash}/>`;
  } else if (o.tool === "parabola") {
    if (b[0] === a[0]) return dot(a);
    const k = (b[1] - a[1]) / ((b[0] - a[0]) * (b[0] - a[0]));
    const pts: string[] = [];
    for (let px = 0; px <= W; px += 3) {
      const x = board.x[0] + (px / W) * (board.x[1] - board.x[0]);
      const y = k * (x - a[0]) * (x - a[0]) + a[1];
      pts.push(`${pts.length ? "L" : "M"}${px} ${r1(Math.max(-1e4, Math.min(1e4, Y(y))))}`);
    }
    path = `<path d="${pts.join("")}" stroke="${color}"${dash}/>`;
  }
  return path + dot(a) + dot(b);
}

// Draws implicit equations, inequality regions and chained regions (slice
// 4) from the engine's quadtree tracer. Results are cached per analysis and
// view, so panning redraws without re-tracing until the view settles.

import type { Analysis } from "../engine/analyze";
import { chainSegments, traceImplicit, traceRegion, type ImplicitResult } from "../engine/implicit";
import { toPx, type Viewport } from "./viewport";

type Traceable = Extract<Analysis, { kind: "implicit" | "region" }>;

const cache = new WeakMap<Traceable, { key: string; result: ImplicitResult; lines: number[][] }>();

function rgba(hex: string, alpha: number): string {
  const n = parseInt(hex.replace("#", ""), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

export function traceFor(a: Traceable, v: Viewport): { result: ImplicitResult; lines: number[][] } {
  const key = `${v.xmin}|${v.xmax}|${v.ymin}|${v.ymax}|${v.width}|${v.height}`;
  const hit = cache.get(a);
  if (hit && hit.key === key) return hit;
  const view = { xmin: v.xmin, xmax: v.xmax, ymin: v.ymin, ymax: v.ymax, widthPx: v.width, heightPx: v.height };
  const result =
    a.kind === "implicit"
      ? traceImplicit({ f: a.f, fi: a.fi, relation: a.relation, restrict: a.restrict }, view)
      : traceRegion({ test: a.test, truth: a.truth, restrict: a.restrict }, view);
  const lines = chainSegments(result.segments, Math.max(v.xmax - v.xmin, v.ymax - v.ymin));
  const entry = { key, result, lines };
  cache.set(a, entry);
  return entry;
}

export function drawImplicit(ctx: CanvasRenderingContext2D, v: Viewport, a: Traceable, color: string, selected = false): void {
  const { result: r, lines } = traceFor(a, v);
  const sx = v.width / (v.xmax - v.xmin);
  const sy = v.height / (v.ymax - v.ymin);
  if (r.fills.length) {
    ctx.fillStyle = rgba(color, 0.22);
    ctx.beginPath();
    for (let k = 0; k < r.fills.length; k += 4) {
      const [px, py] = toPx(v, r.fills[k]!, r.fills[k + 1]! + r.fills[k + 3]!);
      // Snap to whole pixels so neighbouring boxes don't leave hairline seams.
      const x0 = Math.floor(px);
      const y0 = Math.floor(py);
      const x1 = Math.ceil(px + r.fills[k + 2]! * sx);
      const y1 = Math.ceil(py + r.fills[k + 3]! * sy);
      ctx.rect(x0, y0, x1 - x0, y1 - y0);
    }
    ctx.fill();
  }
  if (lines.length) {
    const strict = a.kind === "implicit" && (a.relation === "<" || a.relation === ">");
    ctx.strokeStyle = color;
    ctx.lineWidth = selected ? 3.5 : 2.5;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.setLineDash(strict ? [8, 6] : []);
    ctx.beginPath();
    for (const line of lines) {
      const [ax, ay] = toPx(v, line[0]!, line[1]!);
      ctx.moveTo(ax, ay);
      for (let k = 2; k < line.length; k += 2) {
        const [bx, by] = toPx(v, line[k]!, line[k + 1]!);
        ctx.lineTo(bx, by);
      }
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

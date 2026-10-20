// The graph: a canvas for grid, curves, shading and points (D-5), with a
// DOM layer for what a keyboard or screen reader must reach — the focusable
// graph region, the label of the point being looked at, and a live region.
//
// Interaction: drag the background to pan; wheel, pinch or the buttons to
// zoom; press on a curve to select it and trace along it; a selected curve
// shows its points of interest, and pressing one labels it. Keyboard: arrows
// pan, + / − zoom, 0 resets.

import type { Analysis, Curve } from "../engine/analyze";
import { formatNumber } from "../engine/format";
import { clean, intersections, pointsOfInterest, type Poi } from "../engine/poi";
import { sampleCurve } from "../engine/sample";
import { restricted } from "../engine/index";
import { drawImplicit } from "./implicit";
import { fromPx, gridStep, pan, scale, tickLabel, ticks, toPx, zoomAt, type Viewport } from "./viewport";

export interface PlotItem {
  id: string;
  color: string;
  hidden: boolean;
  analysis: Analysis;
}

interface Drawn {
  id: string;
  curve: Curve;
  f: (t: number) => number;
  /** Pixel polylines, flat [x, y, …]. */
  px: number[][];
}

interface Marker {
  x: number;
  y: number;
  kind: Poi["kind"] | "trace" | "point";
  /** The row the marker belongs to (for colour). */
  id: string;
}

export interface GraphOptions {
  onViewport: (v: Viewport) => void;
  onSelect: (id: string | null) => void;
  /** Called when the reset/home control is used. */
  onHome: () => void;
  readOnly?: boolean;
}

const HIT_PX = 10;
const CLAMP_PX = 1e5;

function rgba(hex: string, alpha: number): string {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.replace(/(.)/g, "$1$1") : h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

function clampPx(v: number): number {
  return v > CLAMP_PX ? CLAMP_PX : v < -CLAMP_PX ? -CLAMP_PX : v;
}

function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len = dx * dx + dy * dy;
  let t = len ? ((px - ax) * dx + (py - ay) * dy) / len : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

export function coordLabel(x: number, y: number, span: number): string {
  return `(${formatNumber(clean(x, span))}, ${formatNumber(clean(y, span))})`;
}

export class GraphView {
  readonly element: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly label: HTMLElement;
  private readonly live: HTMLElement;
  private items: PlotItem[] = [];
  private selected: string | null = null;
  private v: Viewport;
  private drawn: Drawn[] = [];
  private pois: Marker[] = [];
  private poiKey = "";
  private pinned: Marker | null = null;
  private trace: Marker | null = null;
  private frame = 0;
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private mode: "none" | "pan" | "trace" = "none";
  private pinchDist = 0;
  private readonly resizeObserver: ResizeObserver | null = null;

  constructor(
    host: HTMLElement,
    viewport: Viewport,
    private readonly opts: GraphOptions,
  ) {
    this.v = viewport;
    this.element = document.createElement("div");
    this.element.className = "gc-graph";
    this.element.tabIndex = 0;
    this.element.setAttribute("role", "application");
    this.element.setAttribute("aria-roledescription", "graph");
    this.element.setAttribute(
      "aria-label",
      "Graph. Arrow keys move the view, plus and minus zoom, 0 resets.",
    );
    this.canvas = document.createElement("canvas");
    this.canvas.setAttribute("aria-hidden", "true");
    this.element.append(this.canvas);
    this.label = document.createElement("div");
    this.label.className = "gc-point-label";
    this.label.hidden = true;
    this.element.append(this.label);
    this.live = document.createElement("div");
    this.live.className = "gc-sr-only";
    this.live.setAttribute("aria-live", "polite");
    this.element.append(this.live);
    this.element.append(this.zoomControls());
    host.append(this.element);
    this.ctx = this.canvas.getContext("2d")!;

    this.element.addEventListener("pointerdown", (e) => this.down(e));
    this.element.addEventListener("pointermove", (e) => this.move(e));
    this.element.addEventListener("pointerup", (e) => this.up(e));
    this.element.addEventListener("pointercancel", (e) => this.up(e));
    this.element.addEventListener("wheel", (e) => this.wheel(e), { passive: false });
    this.element.addEventListener("keydown", (e) => this.key(e));
    // Safari / WKWebView trackpad pinch.
    let gestureStart = 1;
    this.element.addEventListener("gesturestart", ((e: Event) => {
      e.preventDefault();
      gestureStart = 1;
    }) as EventListener);
    this.element.addEventListener("gesturechange", ((e: Event & { scale: number; clientX: number; clientY: number }) => {
      e.preventDefault();
      const r = this.canvas.getBoundingClientRect();
      this.setViewport(zoomAt(this.v, e.scale / gestureStart, e.clientX - r.left, e.clientY - r.top), true);
      gestureStart = e.scale;
    }) as EventListener);
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => this.schedule());
      this.resizeObserver.observe(this.element);
    }
  }

  destroy(): void {
    this.resizeObserver?.disconnect();
    this.frame = 0;
    this.element.remove();
  }

  private zoomControls(): HTMLElement {
    const box = document.createElement("div");
    box.className = "gc-zoom";
    const mk = (label: string, text: string, act: () => void) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "gc-zoom-btn";
      b.setAttribute("aria-label", label);
      b.textContent = text;
      b.addEventListener("pointerdown", (e) => e.stopPropagation());
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        act();
      });
      return b;
    };
    const centre = () => [this.v.width / 2, this.v.height / 2] as const;
    box.append(
      mk("Zoom in", "+", () => this.setViewport(zoomAt(this.v, 1.5, ...centre()), true)),
      mk("Zoom out", "−", () => this.setViewport(zoomAt(this.v, 1 / 1.5, ...centre()), true)),
      mk("Default view", "⌂", () => this.opts.onHome()),
    );
    return box;
  }

  get viewport(): Viewport {
    return this.v;
  }

  setViewport(v: Viewport, notify = false): void {
    this.v = v;
    this.pinned = null;
    this.trace = null;
    this.label.hidden = true;
    if (notify) this.opts.onViewport(v);
    this.schedule();
  }

  setItems(items: PlotItem[], selected: string | null): void {
    this.items = items;
    if (selected !== this.selected) {
      this.pinned = null;
      this.trace = null;
      this.label.hidden = true;
    }
    this.selected = selected;
    this.poiKey = "";
    this.schedule();
  }

  schedule(): void {
    if (this.frame) return;
    // A frame callback, with a timer behind it: WebKit pauses frames for a
    // window that isn't on screen, and the graph must still be drawn.
    const run = () => {
      if (!this.frame) return;
      this.frame = 0;
      clearTimeout(timer);
      this.render();
    };
    this.frame = 1;
    const timer = setTimeout(run, 50);
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
  }

  /** Reads a colour token from CSS, falling back to `dflt`. */
  private token(name: string, dflt: string): string {
    const v = getComputedStyle(this.element).getPropertyValue(name).trim();
    return v || dflt;
  }

  render(): void {
    const rect = this.element.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    if (w !== this.v.width || h !== this.v.height) {
      // Keep the centre and scale; tell the owner so state follows.
      const sx = this.v.width / (this.v.xmax - this.v.xmin);
      const sy = this.v.height / (this.v.ymax - this.v.ymin);
      const cx = (this.v.xmin + this.v.xmax) / 2;
      const cy = (this.v.ymin + this.v.ymax) / 2;
      this.v = { xmin: cx - w / sx / 2, xmax: cx + w / sx / 2, ymin: cy - h / sy / 2, ymax: cy + h / sy / 2, width: w, height: h };
      this.opts.onViewport(this.v);
    }
    const dpr = (typeof devicePixelRatio === "number" && devicePixelRatio) || 1;
    if (this.canvas.width !== w * dpr || this.canvas.height !== h * dpr) {
      this.canvas.width = w * dpr;
      this.canvas.height = h * dpr;
      this.canvas.style.width = `${w}px`;
      this.canvas.style.height = `${h}px`;
    }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = this.token("--gc-paper", "#ffffff");
    ctx.fillRect(0, 0, w, h);
    this.drawGrid();
    this.drawn = [];
    for (const item of this.items) {
      if (item.hidden) continue;
      // One row's failure must not blank the rest of the graph.
      try {
        this.drawItem(item);
      } catch {
        /* the row's own analysis carries its error */
      }
    }
    this.drawPois();
    this.drawMarker(this.pinned);
    this.drawMarker(this.trace);
  }

  private drawGrid(): void {
    const { ctx, v } = this;
    const minorColor = this.token("--gc-grid-minor", "#eceff3");
    const majorColor = this.token("--gc-grid-major", "#cfd5dd");
    const axisColor = this.token("--gc-axis", "#2b2b2b");
    const labelColor = this.token("--gc-label", "#333333");
    const paper = this.token("--gc-paper", "#ffffff");
    const sx = gridStep(v.xmax - v.xmin, v.width);
    const sy = gridStep(v.ymax - v.ymin, v.height);
    // One step for both axes when the scales match, so squares stay square.
    const [kx, ky] = scale(v);
    const square = Math.abs(kx - ky) / kx < 1e-6;
    const stepY = square ? sx : sy;

    const line = (x0: number, y0: number, x1: number, y1: number) => {
      ctx.moveTo(Math.round(x0) + 0.5, Math.round(y0) + 0.5);
      ctx.lineTo(Math.round(x1) + 0.5, Math.round(y1) + 0.5);
    };
    ctx.lineWidth = 1;
    ctx.strokeStyle = minorColor;
    ctx.beginPath();
    for (const x of ticks(v.xmin, v.xmax, sx.minor)) {
      const [px] = toPx(v, x, 0);
      line(px, 0, px, v.height);
    }
    for (const y of ticks(v.ymin, v.ymax, stepY.minor)) {
      const [, py] = toPx(v, 0, y);
      line(0, py, v.width, py);
    }
    ctx.stroke();
    ctx.strokeStyle = majorColor;
    ctx.beginPath();
    for (const x of ticks(v.xmin, v.xmax, sx.major)) {
      const [px] = toPx(v, x, 0);
      line(px, 0, px, v.height);
    }
    for (const y of ticks(v.ymin, v.ymax, stepY.major)) {
      const [, py] = toPx(v, 0, y);
      line(0, py, v.width, py);
    }
    ctx.stroke();

    const [ox, oy] = toPx(v, 0, 0);
    ctx.strokeStyle = axisColor;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    if (oy >= 0 && oy <= v.height) {
      ctx.moveTo(0, oy);
      ctx.lineTo(v.width, oy);
    }
    if (ox >= 0 && ox <= v.width) {
      ctx.moveTo(ox, 0);
      ctx.lineTo(ox, v.height);
    }
    ctx.stroke();

    // Labels hug the axis, or the nearest edge when the axis is off screen.
    ctx.font = "12px -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif";
    ctx.fillStyle = labelColor;
    const labelY = Math.min(Math.max(oy + 4, 4), v.height - 16);
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (const x of ticks(v.xmin, v.xmax, sx.major)) {
      if (Math.abs(x) < sx.major * 1e-9) continue;
      const [px] = toPx(v, x, 0);
      const text = tickLabel(x, sx.major);
      // A label that would be cut by the edge is left out.
      const half = ctx.measureText(text).width / 2;
      if (px - half < 2 || px + half > v.width - 2) continue;
      this.haloText(text, px, labelY, paper);
    }
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    const labelX = Math.min(Math.max(ox - 6, 30), v.width - 4);
    for (const y of ticks(v.ymin, v.ymax, stepY.major)) {
      if (Math.abs(y) < stepY.major * 1e-9) continue;
      const [, py] = toPx(v, 0, y);
      if (py < 8 || py > v.height - 8) continue;
      this.haloText(tickLabel(y, stepY.major), labelX, py, paper);
    }
    if (ox >= 0 && ox <= v.width && oy >= 0 && oy <= v.height) {
      ctx.textAlign = "right";
      ctx.textBaseline = "top";
      this.haloText("0", ox - 6, oy + 4, paper);
    }
  }

  private haloText(text: string, x: number, y: number, paper: string): void {
    const { ctx } = this;
    ctx.save();
    ctx.lineWidth = 3;
    ctx.strokeStyle = paper;
    ctx.strokeText(text, x, y);
    ctx.restore();
    ctx.fillText(text, x, y);
  }

  private drawItem(item: PlotItem): void {
    const a = item.analysis;
    if (a.kind === "curve") this.drawCurve(item.id, a, item.color);
    else if (a.kind === "function" && a.plot) this.drawCurve(item.id, a.plot, item.color);
    else if (a.kind === "points") this.drawPoints(a.points, item.color);
    else if (a.kind === "implicit" || a.kind === "region") drawImplicit(this.ctx, this.v, a, item.color, this.selected === item.id);
  }

  private drawCurve(id: string, c: Curve, color: string): void {
    const { ctx, v } = this;
    const f = restricted(c);
    const ofY = c.of === "y";
    const [kx, ky] = scale(v);
    const pieces = ofY
      ? sampleCurve(f, v.xmin, v.xmax, { pixels: v.width, valueScale: ky, valueSpanPx: v.height, visible: [v.ymin, v.ymax] })
      : sampleCurve(f, v.ymin, v.ymax, { pixels: v.height, valueScale: kx, valueSpanPx: v.width, visible: [v.xmin, v.xmax] });
    const px: number[][] = pieces.map((p) => {
      const out: number[] = [];
      for (let k = 0; k < p.length; k += 2) {
        const [x, y] = ofY ? toPx(v, p[k]!, p[k + 1]!) : toPx(v, p[k + 1]!, p[k]!);
        out.push(clampPx(x), clampPx(y));
      }
      return out;
    });
    this.drawn.push({ id, curve: c, f, px });

    const strict = c.relation === "<" || c.relation === ">";
    if (c.relation !== "=") {
      // Shade toward the side the inequality names.
      const above = c.relation === ">" || c.relation === ">=";
      ctx.fillStyle = rgba(color, 0.22);
      for (const p of px) {
        if (p.length < 4) continue;
        ctx.beginPath();
        ctx.moveTo(p[0]!, p[1]!);
        for (let k = 2; k < p.length; k += 2) ctx.lineTo(p[k]!, p[k + 1]!);
        if (ofY) {
          const edge = above ? 0 : v.height;
          ctx.lineTo(p[p.length - 2]!, edge);
          ctx.lineTo(p[0]!, edge);
        } else {
          const edge = above ? v.width : 0;
          ctx.lineTo(edge, p[p.length - 1]!);
          ctx.lineTo(edge, p[1]!);
        }
        ctx.closePath();
        ctx.fill();
      }
    }

    const selected = this.selected === id;
    ctx.strokeStyle = color;
    ctx.lineWidth = selected ? 3.5 : 2.5;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.setLineDash(strict ? [8, 6] : []);
    for (const p of px) {
      if (p.length < 4) continue;
      ctx.beginPath();
      ctx.moveTo(p[0]!, p[1]!);
      for (let k = 2; k < p.length; k += 2) ctx.lineTo(p[k]!, p[k + 1]!);
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  private drawPoints(points: [number, number][], color: string): void {
    const { ctx, v } = this;
    ctx.fillStyle = color;
    for (const [x, y] of points) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      const [px, py] = toPx(v, x, y);
      if (px < -10 || py < -10 || px > v.width + 10 || py > v.height + 10) continue;
      ctx.beginPath();
      ctx.arc(px, py, 5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /** Points of interest for the selected curve, recomputed when the view or data changes. */
  private computePois(): void {
    const v = this.v;
    const key = `${this.selected}|${v.xmin}|${v.xmax}|${v.ymin}|${v.ymax}|${this.drawn.length}`;
    if (key === this.poiKey) return;
    this.poiKey = key;
    this.pois = [];
    const sel = this.drawn.find((d) => d.id === this.selected);
    if (!sel) return;
    const ofY = sel.curve.of === "y";
    const [a, b] = ofY ? [v.xmin, v.xmax] : [v.ymin, v.ymax];
    const add = (p: Poi) => {
      const [x, y] = ofY ? [p.t, p.v] : [p.v, p.t];
      if (Number.isFinite(x) && Number.isFinite(y)) this.pois.push({ x, y, kind: p.kind, id: sel.id });
    };
    for (const p of pointsOfInterest(sel.f, a, b)) add(p);
    for (const other of this.drawn) {
      if (other === sel || other.curve.of !== sel.curve.of) continue;
      for (const p of intersections(sel.f, other.f, a, b)) add(p);
    }
  }

  private drawPois(): void {
    this.computePois();
    const { ctx, v } = this;
    const grey = this.token("--gc-poi", "#6b7280");
    for (const p of this.pois) {
      const [px, py] = toPx(v, p.x, p.y);
      if (px < 0 || py < 0 || px > v.width || py > v.height) continue;
      ctx.beginPath();
      ctx.arc(px, py, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = grey;
      ctx.fill();
    }
  }

  private drawMarker(m: Marker | null): void {
    if (!m) return;
    const { ctx, v } = this;
    const [px, py] = toPx(v, m.x, m.y);
    const item = this.items.find((i) => i.id === m.id);
    ctx.beginPath();
    ctx.arc(px, py, 6, 0, Math.PI * 2);
    ctx.fillStyle = m.kind === "trace" ? item?.color ?? "#333" : this.token("--gc-poi", "#6b7280");
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = this.token("--gc-paper", "#ffffff");
    ctx.stroke();
    this.showLabel(m);
  }

  private showLabel(m: Marker): void {
    const [px, py] = toPx(this.v, m.x, m.y);
    const span = this.v.xmax - this.v.xmin;
    const kindText: Record<Marker["kind"], string> = {
      zero: "x-intercept",
      max: "maximum",
      min: "minimum",
      intercept: "y-intercept",
      intersection: "intersection",
      trace: "",
      point: "point",
    };
    const text = coordLabel(m.x, m.y, span);
    this.label.textContent = text;
    this.label.hidden = false;
    // Keep the label inside the graph: flip left / below near the edges.
    const right = px > this.v.width - 140;
    const top = py < 40;
    this.label.style.left = `${right ? px - 10 : px + 10}px`;
    this.label.style.top = `${top ? py + 10 : py - 10}px`;
    this.label.style.transform = `translate(${right ? "-100%" : "0"}, ${top ? "0" : "-100%"})`;
    const spoken = kindText[m.kind] ? `${kindText[m.kind]} ${text}` : text;
    if (this.live.textContent !== spoken) this.live.textContent = spoken;
  }

  private localPoint(e: PointerEvent | WheelEvent): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  /** The nearest drawn curve within reach of (px, py). */
  private hitCurve(px: number, py: number): Drawn | null {
    let best: Drawn | null = null;
    let bestD = HIT_PX;
    for (const d of this.drawn) {
      for (const p of d.px) {
        for (let k = 2; k < p.length; k += 2) {
          const dist = distToSegment(px, py, p[k - 2]!, p[k - 1]!, p[k]!, p[k + 1]!);
          if (dist < bestD) {
            bestD = dist;
            best = d;
          }
        }
      }
    }
    return best;
  }

  private hitPoi(px: number, py: number): Marker | null {
    for (const m of this.pois) {
      const [mx, my] = toPx(this.v, m.x, m.y);
      if (Math.hypot(mx - px, my - py) <= HIT_PX) return m;
    }
    return null;
  }

  private traceTo(d: Drawn, px: number, py: number): void {
    const [x, y] = fromPx(this.v, px, py);
    const t = d.curve.of === "y" ? x : y;
    const val = d.f(t);
    if (!Number.isFinite(val)) return;
    this.trace = d.curve.of === "y" ? { x: t, y: val, kind: "trace", id: d.id } : { x: val, y: t, kind: "trace", id: d.id };
    this.pinned = null;
    this.schedule();
  }

  private down(e: PointerEvent): void {
    if ((e.target as HTMLElement).closest(".gc-zoom")) return;
    this.element.focus({ preventScroll: true });
    const [px, py] = this.localPoint(e);
    this.pointers.set(e.pointerId, { x: px, y: py });
    this.element.setPointerCapture?.(e.pointerId);
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()] as [{ x: number; y: number }, { x: number; y: number }];
      this.pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
      this.mode = "pan";
      return;
    }
    const poi = this.hitPoi(px, py);
    if (poi) {
      this.pinned = poi;
      this.trace = null;
      this.mode = "none";
      this.schedule();
      return;
    }
    const hit = this.hitCurve(px, py);
    if (hit) {
      if (this.selected !== hit.id) this.opts.onSelect(hit.id);
      this.mode = "trace";
      this.traceTo(hit, px, py);
      return;
    }
    this.mode = "pan";
    if (this.pinned || this.trace) {
      this.pinned = null;
      this.trace = null;
      this.label.hidden = true;
      this.schedule();
    }
  }

  private move(e: PointerEvent): void {
    const prev = this.pointers.get(e.pointerId);
    if (!prev) return;
    const [px, py] = this.localPoint(e);
    this.pointers.set(e.pointerId, { x: px, y: py });
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()] as [{ x: number; y: number }, { x: number; y: number }];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (this.pinchDist > 0) {
        this.setViewport(zoomAt(this.v, dist / this.pinchDist, (a.x + b.x) / 2, (a.y + b.y) / 2), true);
      }
      this.pinchDist = dist;
      return;
    }
    if (this.mode === "pan") {
      this.setViewport(pan(this.v, px - prev.x, py - prev.y), true);
    } else if (this.mode === "trace") {
      const d = this.drawn.find((x) => x.id === this.selected);
      if (d) this.traceTo(d, px, py);
    }
  }

  private up(e: PointerEvent): void {
    this.pointers.delete(e.pointerId);
    if (this.pointers.size === 0) this.mode = "none";
    this.pinchDist = 0;
  }

  private wheel(e: WheelEvent): void {
    e.preventDefault();
    const [px, py] = this.localPoint(e);
    const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.002));
    this.setViewport(zoomAt(this.v, factor, px, py), true);
  }

  private key(e: KeyboardEvent): void {
    const step = 40;
    const c: [number, number] = [this.v.width / 2, this.v.height / 2];
    let next: Viewport | null = null;
    switch (e.key) {
      case "ArrowLeft":
        next = pan(this.v, step, 0);
        break;
      case "ArrowRight":
        next = pan(this.v, -step, 0);
        break;
      case "ArrowUp":
        next = pan(this.v, 0, step);
        break;
      case "ArrowDown":
        next = pan(this.v, 0, -step);
        break;
      case "+":
      case "=":
        next = zoomAt(this.v, 1.5, ...c);
        break;
      case "-":
      case "_":
        next = zoomAt(this.v, 1 / 1.5, ...c);
        break;
      case "0":
        this.opts.onHome();
        e.preventDefault();
        return;
      case "Escape":
        this.element.blur();
        return;
      default:
        return;
    }
    e.preventDefault();
    this.setViewport(next, true);
  }
}

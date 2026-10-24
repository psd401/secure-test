// The graph: a canvas for grid, curves, shading and points (D-5), with a
// DOM layer for what a keyboard or screen reader must reach — the focusable
// graph region, the label of the point being looked at, and a live region.
//
// Interaction: drag the background to pan; wheel, pinch or the buttons to
// zoom; press on a curve to select it and trace along it; a selected curve
// shows its points of interest, and pressing one labels it. Keyboard: arrows
// pan, + / − zoom, 0 resets; S describes the graph in words, T traces a
// curve note by note (left / right step, Shift jumps between points of
// interest, up / down changes curve), H plays the curve as sound (slice 8).

import type { Analysis, Curve } from "../engine/analyze";
import { formatNumber } from "../engine/format";
import { clean, intersections, pointsOfInterest, type Poi } from "../engine/poi";
import { sampleCurve } from "../engine/sample";
import { restricted } from "../engine/index";
import { summarizeCurve, summarizeGraph, sweep, toneFor, panFor } from "../engine/summary";
import { Tones } from "./audio";
import { drawImplicit } from "./implicit";
import { fromPx, gridStep, pan, scale, tickLabel, ticks, toPx, zoomAt, type Viewport } from "./viewport";

export interface PlotItem {
  id: string;
  color: string;
  hidden: boolean;
  analysis: Analysis;
  /** The row in words ("y = x² − 4"), for the summary and the trace. */
  label?: string;
}

/** What the graph's keys do, for its accessible name. */
export const GRAPH_KEYS =
  "Arrow keys move the view, plus and minus zoom, 0 resets. S describes the graph, T traces a curve, H plays it as sound.";

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
  /** Spoken before the coordinates (the keyboard trace names its curve). */
  note?: string;
}

export interface GraphOptions {
  onViewport: (v: Viewport) => void;
  onSelect: (id: string | null) => void;
  /** Called when the reset/home control is used. */
  onHome: () => void;
  readOnly?: boolean;
  /**
   * Keep the graph-unit bounds when the box changes size (a stimulus: a
   * question on a hidden page lays out at no size, and the teacher's view
   * must still be what appears). The calculator instead keeps its scale.
   */
  keepBounds?: boolean;
}

const HIT_PX = 10;
const CLAMP_PX = 1e5;

/** Relative luminance (WCAG) of a CSS colour in #rgb / #rrggbb / rgb() form. */
export function luminance(color: string): number {
  let r = 255;
  let g = 255;
  let b = 255;
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (m) {
    const h = m[1]!.length === 3 ? m[1]!.replace(/(.)/g, "$1$1") : m[1]!;
    const n = parseInt(h, 16);
    [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  } else {
    const c = /rgba?\(\s*(\d+)[ ,]+(\d+)[ ,]+(\d+)/.exec(color);
    if (c) [r, g, b] = [Number(c[1]), Number(c[2]), Number(c[3])];
  }
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/**
 * A curve colour readable on the paper. The palette is chosen for white;
 * on a dark contrast set each colour is mixed toward white until it stands
 * out (3:1 or better, WCAG 1.4.11).
 */
export function curveColor(hex: string, paper: string): string {
  const pl = luminance(paper);
  if (pl > 0.4) return hex;
  const n = parseInt(hex.replace("#", ""), 16);
  let [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  for (let k = 0; k < 10; k++) {
    const l = luminance(`rgb(${r}, ${g}, ${b})`);
    if ((l + 0.05) / (pl + 0.05) >= 4.5) break;
    r = Math.round(r + (255 - r) * 0.25);
    g = Math.round(g + (255 - g) * 0.25);
    b = Math.round(b + (255 - b) * 0.25);
  }
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

function rgbOf(color: string): [number, number, number] {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (m) {
    const h = m[1]!.length === 3 ? m[1]!.replace(/(.)/g, "$1$1") : m[1]!;
    const n = parseInt(h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const c = /rgba?\(\s*(\d+)[ ,]+(\d+)[ ,]+(\d+)/.exec(color);
  return c ? [Number(c[1]), Number(c[2]), Number(c[3])] : [255, 255, 255];
}

/** `ink` laid over `paper` at `amount` — grid lines that suit any contrast set. */
export function mix(paper: string, ink: string, amount: number): string {
  const [pr, pg, pb] = rgbOf(paper);
  const [ir, ig, ib] = rgbOf(ink);
  const f = (p: number, i: number) => Math.round(p + (i - p) * amount);
  return `rgb(${f(pr, ir)}, ${f(pg, ig)}, ${f(pb, ib)})`;
}

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
  private textScale = 1;
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private mode: "none" | "pan" | "trace" = "none";
  private pinchDist = 0;
  private readonly resizeObserver: ResizeObserver | null = null;
  private readonly summary: HTMLElement;
  private readonly summaryText: HTMLElement;
  private readonly tones = new Tones();
  /** Keyboard trace mode: the arrows walk the selected curve. */
  private keyTrace = false;

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
      `Graph. ${GRAPH_KEYS}`,
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
    this.summary = document.createElement("div");
    this.summary.className = "gc-summary";
    this.summary.hidden = true;
    this.summary.setAttribute("role", "region");
    this.summary.setAttribute("aria-label", "Graph description");
    this.summaryText = document.createElement("p");
    // Focus moves here when the description opens (finding S-1): VoiceOver
    // dropped the long polite live-region message, and from here it can be
    // read again. The graph itself is role="application"; "document" puts
    // VoiceOver back into reading mode for the text.
    this.summaryText.tabIndex = -1;
    this.summaryText.setAttribute("role", "document");
    const close = document.createElement("button");
    close.type = "button";
    close.className = "gc-summary-close";
    close.setAttribute("aria-label", "Close the description");
    close.textContent = "×";
    close.addEventListener("pointerdown", (e) => e.stopPropagation());
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      this.summary.hidden = true;
      this.element.focus({ preventScroll: true });
    });
    this.summary.append(this.summaryText, close);
    this.summary.addEventListener("pointerdown", (e) => e.stopPropagation());
    this.element.append(this.summary);
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
    this.tones.close();
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
      mk("Describe the graph in words", "≡", () => this.describe()),
      mk("Play the curve as sound", "♪", () => this.play()),
    );
    const [, , , describeBtn, playBtn] = Array.from(box.children) as HTMLButtonElement[];
    describeBtn!.title = "Describe the graph (S)";
    playBtn!.title = "Play the curve as sound (H)";
    return box;
  }

  get viewport(): Viewport {
    return this.v;
  }

  /** The student has panned or zoomed: from now on a resize keeps the scale. */
  private moved = false;

  setViewport(v: Viewport, notify = false): void {
    if (notify) this.moved = true;
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
    // Hidden (the calculator's Graph toggle): keep the view as it was.
    if (rect.width === 0 && rect.height === 0) return;
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    if ((w !== this.v.width || h !== this.v.height) && this.opts.keepBounds && !this.moved) {
      this.v = { ...this.v, width: w, height: h };
    } else if (w !== this.v.width || h !== this.v.height) {
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
    // Fonts follow the page's zoom: the root's font size against its 15 px default.
    this.textScale = (parseFloat(getComputedStyle(this.element).fontSize) || 15) / 15;
    const paper = this.token("--gc-paper", "#ffffff");
    for (const item of this.items) {
      if (item.hidden) continue;
      const shown = { ...item, color: curveColor(item.color, paper) };
      // One row's failure must not blank the rest of the graph.
      try {
        this.drawItem(shown);
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
    // Grid lines are the ink faded into the paper, so they stay quiet on
    // every contrast set (a light grey grid glares on black).
    const ink = this.token("--gc-ink", "#1d2433");
    const paperColor = this.token("--gc-paper", "#ffffff");
    const minorColor = this.token("--gc-grid-minor", "") || mix(paperColor, ink, 0.07);
    const majorColor = this.token("--gc-grid-major", "") || mix(paperColor, ink, 0.18);
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
    ctx.font = `${Math.round(12 * this.textScale)}px -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif`;
    ctx.fillStyle = labelColor;
    const labelY = Math.min(Math.max(oy + 4, 4), v.height - 16 * this.textScale);
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
    const paperTone = this.token("--gc-paper", "#ffffff");
    ctx.fillStyle = m.kind === "trace" ? curveColor(item?.color ?? "#333333", paperTone) : this.token("--gc-poi", "#6b7280");
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
    const kind = kindText[m.kind] ? `${kindText[m.kind]} ${text}` : text;
    const spoken = m.note ? `${m.note} ${kind}` : kind;
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
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (this.keyTrace && this.traceKey(e)) {
      e.preventDefault();
      return;
    }
    switch (e.key.toLowerCase()) {
      case "s":
        e.preventDefault();
        this.describe();
        return;
      case "t":
        e.preventDefault();
        this.startTrace();
        return;
      case "h":
        e.preventDefault();
        this.play();
        return;
    }
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
        if (!this.summary.hidden || this.tones.busy) {
          const inSummary = this.summary.contains(document.activeElement);
          this.summary.hidden = true;
          this.tones.stop();
          e.preventDefault();
          if (inSummary) this.element.focus({ preventScroll: true });
          return;
        }
        this.element.blur();
        return;
      default:
        return;
    }
    e.preventDefault();
    this.setViewport(next, true);
  }

  // ---- Slice 8: the graph in words and in sound ----

  private say(text: string): void {
    // Re-set even when unchanged, so the same words are spoken again.
    this.live.textContent = "";
    this.live.textContent = text;
  }

  private labelOf(id: string): string {
    return this.items.find((i) => i.id === id)?.label ?? "";
  }

  /** The curve the trace and the sound follow: the selected one, else the first drawn. */
  private focusCurve(): Drawn | null {
    return this.drawn.find((d) => d.id === this.selected) ?? this.drawn[0] ?? null;
  }

  private select(id: string): void {
    if (this.selected === id) return;
    // Set first, so the owner's setItems keeps the trace point.
    this.selected = id;
    this.poiKey = "";
    this.opts.onSelect(id);
  }

  describe(): void {
    const v = this.v;
    const others = this.items.filter(
      (i) => !i.hidden && (i.analysis.kind === "points" || i.analysis.kind === "implicit" || i.analysis.kind === "region"),
    );
    const sentences = this.drawn.map((d) => summarizeCurve(this.labelOf(d.id), d.f, d.curve.of, v));
    for (const i of others) sentences.push(`${i.label?.trim() || "A relation"}: graphed.`);
    const text = summarizeGraph(sentences, v);
    this.summaryText.textContent = text;
    this.summary.hidden = false;
    this.summaryText.focus({ preventScroll: true });
  }

  private startTrace(): void {
    const d = this.focusCurve();
    if (!d) {
      this.say("There is no curve to trace.");
      return;
    }
    this.keyTrace = true;
    this.select(d.id);
    const [a, b] = this.along(d);
    this.traceAt(d, (a + b) / 2, "Tracing", true);
  }

  /** The curve's own-axis range in view. */
  private along(d: Drawn): [number, number] {
    return d.curve.of === "y" ? [this.v.xmin, this.v.xmax] : [this.v.ymin, this.v.ymax];
  }

  private step(d: Drawn): number {
    const [a, b] = this.along(d);
    const px = d.curve.of === "y" ? this.v.width : this.v.height;
    return gridStep(b - a, px).minor;
  }

  /** Puts the trace point at t (snapped to the step), nearest defined point if t isn't. */
  private traceAt(d: Drawn, t: number, note: string, snap: boolean): void {
    const s = this.step(d);
    const [a, b] = this.along(d);
    let at = snap ? Math.round(t / s) * s : t;
    at = Math.max(a, Math.min(b, at));
    let val = d.f(at);
    if (!Number.isFinite(val) && snap) {
      for (let k = 1; k < 200 && !Number.isFinite(val); k++) {
        for (const c of [at + k * s, at - k * s]) {
          if (c < a || c > b) continue;
          const w = d.f(c);
          if (Number.isFinite(w)) {
            at = c;
            val = w;
            break;
          }
        }
      }
    }
    const label = this.labelOf(d.id);
    if (!Number.isFinite(val)) {
      this.say(`${note ? `${note} ${label}. ` : ""}Undefined at ${d.curve.of === "y" ? "x" : "y"} = ${formatNumber(clean(at, s))}.`);
      return;
    }
    const [x, y] = d.curve.of === "y" ? [at, val] : [val, at];
    const prefix = note === "Tracing" ? `Tracing ${label || "the curve"}.` : note;
    this.trace = { x, y, kind: "trace", id: d.id, note: prefix || undefined };
    this.pinned = null;
    const [lo, hi] = d.curve.of === "y" ? [this.v.ymin, this.v.ymax] : [this.v.xmin, this.v.xmax];
    this.tones.note({ freq: toneFor(val, lo, hi), pan: panFor(at, a, b) });
    this.schedule();
  }

  /** Keys while tracing; false lets the key do what it does otherwise. */
  private traceKey(e: KeyboardEvent): boolean {
    const d = this.drawn.find((x) => x.id === this.selected) ?? null;
    if (e.key === "Escape") {
      this.keyTrace = false;
      this.trace = null;
      this.label.hidden = true;
      this.tones.stop();
      this.schedule();
      this.say("Trace off. Arrow keys move the view.");
      return true;
    }
    if (!d) return false;
    const [a, b] = this.along(d);
    const cur = this.trace ? (d.curve.of === "y" ? this.trace.x : this.trace.y) : (a + b) / 2;
    const dir = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (dir && e.shiftKey) {
      this.computePois();
      const s = this.step(d) * 1e-6;
      const sorted = this.pois.filter((p) => p.id === d.id).map((p) => ({ p, t: d.curve.of === "y" ? p.x : p.y }));
      const next = dir > 0 ? sorted.filter((q) => q.t > cur + s).sort((m, n) => m.t - n.t)[0] : sorted.filter((q) => q.t < cur - s).sort((m, n) => n.t - m.t)[0];
      if (!next) {
        this.say(dir > 0 ? "No more points of interest to the right." : "No more points of interest to the left.");
        return true;
      }
      const [own, other] = d.curve.of === "y" ? ["x", "y"] : ["y", "x"];
      const words: Record<string, string> = { zero: `${own}-intercept`, max: "Maximum", min: "Minimum", intercept: `${other}-intercept`, intersection: "Intersection" };
      this.traceAt(d, next.t, words[next.p.kind] ?? "", false);
      return true;
    }
    if (dir) {
      const t = cur + dir * this.step(d);
      if (t < a - 1e-9 * (b - a) || t > b + 1e-9 * (b - a)) {
        this.say("Edge of the view.");
        return true;
      }
      this.traceAt(d, t, "", true);
      return true;
    }
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      const k = this.drawn.indexOf(d);
      const n = this.drawn.length;
      if (n < 2) {
        this.say("This is the only curve.");
        return true;
      }
      const other = this.drawn[(k + (e.key === "ArrowDown" ? 1 : n - 1)) % n]!;
      // The new curve's own axis may differ (y = f(x) vs x = g(y)): take its
      // parameter from the trace point, not the old curve's parameter.
      const [oa, ob] = this.along(other);
      const t = this.trace ? (other.curve.of === "y" ? this.trace.x : this.trace.y) : (oa + ob) / 2;
      this.select(other.id);
      this.traceAt(other, t, "Tracing", true);
      return true;
    }
    return false;
  }

  play(): void {
    if (this.tones.busy) {
      this.tones.stop();
      return;
    }
    const d = this.focusCurve();
    if (!d) {
      this.say("There is no curve to play.");
      return;
    }
    const ok = this.tones.sweep(sweep(d.f, d.curve.of, this.v), 3);
    const label = this.labelOf(d.id) || "the curve";
    this.say(ok ? `Playing ${label}, left to right. Higher notes are higher on the graph.` : "Sound isn't available here.");
  }
}

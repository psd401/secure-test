// The graph answer board (D-9, D-11): choose a tool, then place its points
// on the grid — by clicking (each click snaps), by keyboard (arrow keys move
// a cursor one snap step, Enter places), or by typing the coordinates. All
// three make the same objects, so a student who can't drag or point loses
// nothing. Every object is listed in words ("y = 2x + 1") with a Remove
// button, and each change is announced.
//
// The same board serves the teacher drawing the key (design tool) and the
// review of an answer against the key (read-only, key shown dashed).

import {
  describeObject,
  parseSnap,
  scoreGraph,
  snapPoint,
  type GraphBoard,
  type GraphKey,
  type GraphObject,
  type GraphTool,
} from "../engine/graphAnswer";
import { installStyles } from "./calculator";
import { curveColor, mix } from "./graph";
import { gridStep, tickLabel, ticks } from "./viewport";

export interface GraphAnswerOptions {
  initial?: GraphObject[];
  onChange?: (objects: GraphObject[]) => void;
  readOnly?: boolean;
  /** Review: the key, drawn dashed, with each answer object marked. */
  key?: GraphKey;
  /** Label for the board, e.g. "Your answer" or "Answer key". */
  label?: string;
}

export interface GraphAnswerHandle {
  objects(): GraphObject[];
  destroy(): void;
}

const TOOL_NAMES: Record<GraphTool, string> = {
  point: "Point",
  line: "Line",
  segment: "Segment",
  ray: "Ray",
  circle: "Circle",
  parabola: "Parabola",
};

const TOOL_HINTS: Record<GraphTool, [string, string?]> = {
  point: ["Place the point."],
  line: ["Place a point on the line.", "Place a second point on the line."],
  segment: ["Place one end of the segment.", "Place the other end."],
  ray: ["Place the ray's endpoint.", "Place a point the ray goes through."],
  circle: ["Place the centre.", "Place a point on the circle."],
  parabola: ["Place the vertex.", "Place another point on the parabola."],
};

export const ANSWER_COLOR = "#1f5fa8";
export const KEY_COLOR = "#2c7a37";
export const FIXED_COLOR = "#6b7280";

function fmt(v: number): string {
  const r = Math.round(v * 1e6) / 1e6;
  return (r < 0 ? "−" : "") + String(Math.abs(r));
}

export function mountGraphAnswer(container: HTMLElement, board: GraphBoard, opts: GraphAnswerOptions = {}): GraphAnswerHandle {
  installStyles(container.ownerDocument);
  const snap = parseSnap(board.snap) ?? [1, 1];
  const step = snap[0] / snap[1];
  const readOnly = opts.readOnly === true;
  let objects: GraphObject[] = (opts.initial ?? []).map((o) => ({ tool: o.tool, points: o.points.map((p) => [p[0], p[1]] as [number, number]) }));
  let tool: GraphTool = board.tools[0] ?? "point";
  let pending: [number, number] | null = null;
  let cursor: [number, number] = snapPoint((board.x[0] + board.x[1]) / 2, (board.y[0] + board.y[1]) / 2, snap);
  let hover: [number, number] | null = null;

  const root = document.createElement("div");
  root.className = "gc-root gc-answer";
  container.append(root);

  const live = document.createElement("div");
  live.className = "gc-sr-only";
  live.setAttribute("aria-live", "polite");
  const say = (text: string) => {
    live.textContent = "";
    live.textContent = text;
  };

  // --- toolbar ---
  const bar = document.createElement("div");
  bar.className = "gc-answer-tools";
  bar.setAttribute("role", "toolbar");
  bar.setAttribute("aria-label", "Graphing tools");
  const toolButtons = new Map<GraphTool, HTMLButtonElement>();
  for (const t of board.tools) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "gc-answer-tool";
    b.textContent = TOOL_NAMES[t];
    b.addEventListener("click", () => {
      tool = t;
      pending = null;
      refresh();
      say(`${TOOL_NAMES[t]}. ${TOOL_HINTS[t][0]}`);
    });
    toolButtons.set(t, b);
    bar.append(b);
  }
  const undo = document.createElement("button");
  undo.type = "button";
  undo.className = "gc-answer-tool gc-answer-undo";
  undo.textContent = "Undo";
  undo.addEventListener("click", () => {
    if (pending) pending = null;
    else objects = objects.slice(0, -1);
    changed("Undone.");
  });
  const clear = document.createElement("button");
  clear.type = "button";
  clear.className = "gc-answer-tool gc-answer-undo";
  clear.textContent = "Clear all";
  clear.addEventListener("click", () => {
    pending = null;
    objects = [];
    changed("Cleared.");
  });
  bar.append(undo, clear);
  if (!readOnly) root.append(bar);

  const hint = document.createElement("p");
  hint.className = "gc-answer-hint";
  if (!readOnly) root.append(hint);

  // --- board ---
  const area = document.createElement("div");
  area.className = "gc-answer-board";
  area.tabIndex = 0;
  area.setAttribute("role", "application");
  area.setAttribute("aria-roledescription", "graph");
  // Fixed objects are part of the question: say them, not only draw them.
  const given = (board.fixed ?? []).map((o) => describeObject(o, board));
  area.setAttribute(
    "aria-label",
    `${opts.label ?? "Graph"}. ${
      readOnly ? "" : "Arrow keys move the cursor one grid step; Enter places a point; Escape cancels. "
    }x from ${fmt(board.x[0])} to ${fmt(board.x[1])}, y from ${fmt(board.y[0])} to ${fmt(board.y[1])}.${
      given.length ? ` Given: ${given.join("; ")}.` : ""
    }`,
  );
  const canvas = document.createElement("canvas");
  canvas.setAttribute("aria-hidden", "true");
  area.append(canvas, live);
  root.append(area);
  const ctx = canvas.getContext("2d");

  // --- typed entry ---
  const form = document.createElement("form");
  form.className = "gc-answer-type";
  form.setAttribute("aria-label", "Type an object's coordinates");
  const formTool = document.createElement("select");
  formTool.setAttribute("aria-label", "Tool");
  for (const t of board.tools) {
    const opt = document.createElement("option");
    opt.value = t;
    opt.textContent = TOOL_NAMES[t];
    formTool.append(opt);
  }
  const coord = (label: string) => {
    const i = document.createElement("input");
    i.type = "text";
    i.inputMode = "decimal";
    i.size = 4;
    i.className = "gc-answer-coord";
    i.setAttribute("aria-label", label);
    return i;
  };
  const x1 = coord("First point x");
  const y1 = coord("First point y");
  const x2 = coord("Second point x");
  const y2 = coord("Second point y");
  const second = document.createElement("span");
  second.className = "gc-answer-second";
  second.append(" and (", x2, ", ", y2, ")");
  const add = document.createElement("button");
  add.type = "submit";
  add.className = "gc-answer-tool";
  add.textContent = "Add";
  const formError = document.createElement("span");
  formError.className = "gc-error";
  formError.setAttribute("role", "status");
  form.append(formTool, " at (", x1, ", ", y1, ")", second, " ", add, " ", formError);
  const syncForm = () => {
    second.hidden = formTool.value === "point";
  };
  formTool.addEventListener("change", syncForm);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const t = formTool.value as GraphTool;
    const nums = (t === "point" ? [x1, y1] : [x1, y1, x2, y2]).map((i) => parseCoordinate(i.value));
    if (nums.some((n) => n === null)) {
      formError.textContent = "Type a number in each box (fractions like 1/2 are fine).";
      return;
    }
    const pts: [number, number][] = [];
    for (let k = 0; k < nums.length; k += 2) pts.push([nums[k]!, nums[k + 1]!]);
    const problem = placeable(t, pts);
    if (problem) {
      formError.textContent = problem;
      return;
    }
    formError.textContent = "";
    objects = [...objects, { tool: t, points: pts }];
    for (const i of [x1, y1, x2, y2]) i.value = "";
    changed(`${describeObject({ tool: t, points: pts }, board)} added.`);
  });
  if (!readOnly) root.append(form);
  syncForm();

  // --- lists ---
  if (given.length) {
    const box = document.createElement("div");
    box.className = "gc-answer-given";
    const title = document.createElement("p");
    title.className = "gc-answer-hint";
    title.textContent = "Given on the graph (dotted):";
    const ul = document.createElement("ul");
    ul.className = "gc-answer-list";
    ul.setAttribute("aria-label", "Given on the graph");
    for (const text of given) {
      const li = document.createElement("li");
      li.textContent = text;
      ul.append(li);
    }
    box.append(title, ul);
    root.append(box);
  }
  const list = document.createElement("ol");
  list.className = "gc-answer-list";
  list.setAttribute("aria-label", readOnly ? "Objects" : "Your objects");
  root.append(list);

  function placeable(t: GraphTool, pts: [number, number][]): string | null {
    for (const [x, y] of pts) {
      if (x < board.x[0] || x > board.x[1] || y < board.y[0] || y > board.y[1]) return "That point is outside the grid.";
      const [sx, sy] = snapPoint(x, y, snap);
      if (Math.abs(sx - x) > 1e-9 || Math.abs(sy - y) > 1e-9) return `Use whole steps of ${board.snap}.`;
    }
    if (pts.length === 2 && pts[0]![0] === pts[1]![0] && pts[0]![1] === pts[1]![1]) return "The two points must be different.";
    if (t === "parabola" && pts.length === 2 && pts[0]![0] === pts[1]![0]) return "The second point can't be straight above or below the vertex.";
    if (t === "parabola" && pts.length === 2 && pts[0]![1] === pts[1]![1]) return "The second point can't be level with the vertex.";
    if (objects.length >= board.max_objects) return `This question takes at most ${board.max_objects}.`;
    return null;
  }

  function changed(message: string): void {
    refresh();
    say(message);
    opts.onChange?.(objects.map((o) => ({ tool: o.tool, points: o.points.map((p) => [p[0], p[1]] as [number, number]) })));
  }

  function place(p: [number, number]): void {
    if (readOnly) return;
    if (objects.length >= board.max_objects) {
      say(`This question takes at most ${board.max_objects}. Remove one to add another.`);
      return;
    }
    if (tool === "point") {
      const problem = placeable(tool, [p]);
      if (problem) {
        say(problem);
        return;
      }
      objects = [...objects, { tool, points: [p] }];
      changed(`Point (${fmt(p[0])}, ${fmt(p[1])}) added.`);
      return;
    }
    if (!pending) {
      pending = p;
      refresh();
      say(`First point at (${fmt(p[0])}, ${fmt(p[1])}). ${TOOL_HINTS[tool][1] ?? ""}`);
      return;
    }
    const problem = placeable(tool, [pending, p]);
    if (problem) {
      say(problem);
      return;
    }
    const o: GraphObject = { tool, points: [pending, p] };
    pending = null;
    objects = [...objects, o];
    changed(`${describeObject(o, board)} added.`);
  }

  // --- geometry of the canvas ---
  let W = 400;
  let H = 400;
  const X = (x: number) => ((x - board.x[0]) / (board.x[1] - board.x[0])) * W;
  const Y = (y: number) => ((board.y[1] - y) / (board.y[1] - board.y[0])) * H;
  const fromPx = (px: number, py: number): [number, number] => [
    board.x[0] + (px / W) * (board.x[1] - board.x[0]),
    board.y[1] - (py / H) * (board.y[1] - board.y[0]),
  ];

  function size(): void {
    const width = Math.max(200, Math.min(560, area.clientWidth || 400));
    W = width;
    H = Math.round((width * (board.y[1] - board.y[0])) / (board.x[1] - board.x[0]));
    const dpr = (typeof devicePixelRatio === "number" && devicePixelRatio) || 1;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;
    ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function drawObject(c: CanvasRenderingContext2D, o: GraphObject, color: string, dash: number[]): void {
    c.strokeStyle = color;
    c.fillStyle = color;
    c.lineWidth = 2.5;
    c.setLineDash(dash);
    const [a, b] = o.points as [[number, number], [number, number] | undefined];
    const dot = (p: [number, number]) => {
      c.beginPath();
      c.arc(X(p[0]), Y(p[1]), 4.5, 0, Math.PI * 2);
      c.fill();
    };
    if (o.tool === "point" || !b) {
      dot(a);
      return;
    }
    c.beginPath();
    if (o.tool === "segment") {
      c.moveTo(X(a[0]), Y(a[1]));
      c.lineTo(X(b[0]), Y(b[1]));
    } else if (o.tool === "line" || o.tool === "ray") {
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const big = 4 * Math.max(board.x[1] - board.x[0], board.y[1] - board.y[0]);
      const len = Math.hypot(dx, dy);
      const ux = (dx / len) * big;
      const uy = (dy / len) * big;
      const start: [number, number] = o.tool === "ray" ? a : [a[0] - ux, a[1] - uy];
      c.moveTo(X(start[0]), Y(start[1]));
      c.lineTo(X(a[0] + ux), Y(a[1] + uy));
    } else if (o.tool === "circle") {
      const r = Math.hypot(b[0] - a[0], b[1] - a[1]);
      c.ellipse(X(a[0]), Y(a[1]), (r / (board.x[1] - board.x[0])) * W, (r / (board.y[1] - board.y[0])) * H, 0, 0, Math.PI * 2);
    } else if (o.tool === "parabola") {
      const k = (b[1] - a[1]) / ((b[0] - a[0]) * (b[0] - a[0]));
      for (let px = 0; px <= W; px += 2) {
        const [x] = fromPx(px, 0);
        const y = k * (x - a[0]) * (x - a[0]) + a[1];
        const py = Math.max(-1e4, Math.min(1e4, Y(y)));
        if (px === 0) c.moveTo(px, py);
        else c.lineTo(px, py);
      }
    }
    c.stroke();
    c.setLineDash([]);
    dot(a);
    dot(b);
  }

  function draw(): void {
    if (!ctx) return;
    size();
    const c = ctx;
    // Every colour from the page tokens, like the calculator's own graph:
    // the board ignored the contrast set and drew dark grey on black
    // (finding C-1, 2026-10-24 hand-run). Labels grow with the page zoom.
    const css = getComputedStyle(root);
    const token = (name: string, dflt: string) => css.getPropertyValue(name).trim() || dflt;
    const paper = token("--gc-paper", "#ffffff");
    const ink = token("--gc-ink", "#1d2433");
    const textScale = (parseFloat(css.fontSize) || 15) / 15;
    const answerColor = curveColor(ANSWER_COLOR, paper);
    const keyColor = curveColor(KEY_COLOR, paper);
    const fixedColor = curveColor(FIXED_COLOR, paper);
    c.fillStyle = paper;
    c.fillRect(0, 0, W, H);
    // Grid at the board's spacing; labels at a readable step.
    c.lineWidth = 1;
    c.strokeStyle = mix(paper, ink, 0.18);
    c.beginPath();
    for (const x of ticks(board.x[0], board.x[1], board.grid)) {
      c.moveTo(Math.round(X(x)) + 0.5, 0);
      c.lineTo(Math.round(X(x)) + 0.5, H);
    }
    for (const y of ticks(board.y[0], board.y[1], board.grid)) {
      c.moveTo(0, Math.round(Y(y)) + 0.5);
      c.lineTo(W, Math.round(Y(y)) + 0.5);
    }
    c.stroke();
    c.strokeStyle = token("--gc-axis", "#2b2f36");
    c.lineWidth = 1.5;
    c.beginPath();
    if (board.y[0] <= 0 && board.y[1] >= 0) {
      c.moveTo(0, Y(0));
      c.lineTo(W, Y(0));
    }
    if (board.x[0] <= 0 && board.x[1] >= 0) {
      c.moveTo(X(0), 0);
      c.lineTo(X(0), H);
    }
    c.stroke();
    const labelStep = gridStep(board.x[1] - board.x[0], W, 40).major;
    c.font = `${Math.round(12 * textScale)}px -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif`;
    c.fillStyle = token("--gc-label", "#3a404b");
    c.textAlign = "center";
    c.textBaseline = "top";
    const ly = Math.min(Math.max(Y(0) + 3, 2), H - 14 * textScale);
    for (const x of ticks(board.x[0], board.x[1], labelStep)) {
      if (Math.abs(x) < 1e-9 || X(x) < 8 || X(x) > W - 8) continue;
      c.fillText(tickLabel(x, labelStep), X(x), ly);
    }
    c.textAlign = "right";
    c.textBaseline = "middle";
    const lx = Math.min(Math.max(X(0) - 4, 20 * textScale), W - 2);
    const labelStepY = gridStep(board.y[1] - board.y[0], H, 40).major;
    for (const y of ticks(board.y[0], board.y[1], labelStepY)) {
      if (Math.abs(y) < 1e-9 || Y(y) < 8 || Y(y) > H - 8) continue;
      c.fillText(tickLabel(y, labelStepY), lx, Y(y));
    }
    // Fixed dotted, key dashed, answer solid: more than colour tells them apart.
    for (const o of board.fixed ?? []) drawObject(c, o, fixedColor, [2, 4]);
    if (opts.key) for (const o of opts.key.objects) drawObject(c, o, keyColor, [7, 5]);
    for (const o of objects) drawObject(c, o, answerColor, []);
    // In progress: the first point, and the cursor / hover target.
    if (pending) {
      c.strokeStyle = answerColor;
      c.lineWidth = 2;
      c.beginPath();
      c.arc(X(pending[0]), Y(pending[1]), 6, 0, Math.PI * 2);
      c.stroke();
    }
    const target = hover ?? (document.activeElement === area ? cursor : null);
    if (target && !readOnly) {
      c.strokeStyle = token("--gc-accent", "#2563c9");
      c.lineWidth = 2;
      c.beginPath();
      c.arc(X(target[0]), Y(target[1]), 8, 0, Math.PI * 2);
      c.stroke();
    }
  }

  function refresh(): void {
    for (const [t, b] of toolButtons) b.setAttribute("aria-pressed", String(t === tool));
    const full = objects.length >= board.max_objects;
    hint.textContent = full
      ? `That's ${board.max_objects} — the most this question takes. Remove one to add another.`
      : `${TOOL_NAMES[tool]}: ${pending ? TOOL_HINTS[tool][1] ?? "" : TOOL_HINTS[tool][0]}`;
    undo.disabled = !pending && objects.length === 0;
    clear.disabled = objects.length === 0 && !pending;
    add.disabled = full;
    list.replaceChildren();
    const marks = opts.key ? markAnswers() : null;
    objects.forEach((o, i) => {
      const li = document.createElement("li");
      const text = document.createElement("span");
      text.textContent = describeObject(o, board);
      li.append(text);
      if (marks) {
        const m = document.createElement("span");
        m.className = marks[i] ? "gc-mark-right" : "gc-mark-wrong";
        m.textContent = marks[i] ? " ✓" : " ✗";
        m.setAttribute("aria-label", marks[i] ? "matches the key" : "not in the key");
        li.append(m);
      }
      if (!readOnly) {
        const rm = document.createElement("button");
        rm.type = "button";
        rm.className = "gc-chip";
        rm.textContent = "Remove";
        rm.setAttribute("aria-label", `Remove ${describeObject(o, board)}`);
        rm.addEventListener("click", () => {
          const gone = describeObject(o, board);
          objects = objects.filter((_, k) => k !== i);
          changed(`${gone} removed.`);
          // The list was rebuilt: keep focus on the Remove button now in this
          // place, else the one before it, else the board.
          const buttons = list.querySelectorAll<HTMLButtonElement>("button.gc-chip");
          (buttons[Math.min(i, buttons.length - 1)] ?? area).focus();
        });
        li.append(" ", rm);
      }
      list.append(li);
    });
    if (objects.length === 0) {
      const li = document.createElement("li");
      li.className = "gc-note";
      li.textContent = readOnly ? "Nothing placed." : "Nothing placed yet.";
      list.append(li);
    }
    draw();
  }

  /** For review: does each answer object match some key object? */
  function markAnswers(): boolean[] {
    return objects.map((o) => scoreGraph(board, { objects: opts.key!.objects, scoring: "per_object" }, [o]).extra === 0);
  }

  // --- input ---
  const local = (e: PointerEvent): [number, number] => {
    const r = canvas.getBoundingClientRect();
    return fromPx(e.clientX - r.left, e.clientY - r.top);
  };
  canvas.addEventListener("pointermove", (e) => {
    if (readOnly) return;
    hover = snapInside(local(e), board, snap);
    draw();
  });
  canvas.addEventListener("pointerleave", () => {
    hover = null;
    draw();
  });
  canvas.addEventListener("pointerdown", (e) => {
    if (readOnly) return;
    e.preventDefault();
    area.focus({ preventScroll: true });
    const p = snapInside(local(e), board, snap);
    cursor = p;
    place(p);
  });
  area.addEventListener("focus", () => draw());
  area.addEventListener("blur", () => draw());
  area.addEventListener("keydown", (e) => {
    if (readOnly) return;
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, step],
      ArrowDown: [0, -step],
    };
    const mv = moves[e.key];
    if (mv) {
      e.preventDefault();
      const nx = Math.min(board.x[1], Math.max(board.x[0], cursor[0] + mv[0]));
      const ny = Math.min(board.y[1], Math.max(board.y[0], cursor[1] + mv[1]));
      cursor = snapInside([nx, ny], board, snap);
      draw();
      say(`(${fmt(cursor[0])}, ${fmt(cursor[1])})`);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      place(cursor);
    } else if (e.key === "Escape" && pending) {
      e.preventDefault();
      pending = null;
      refresh();
      say("Cancelled.");
    }
  });
  const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => draw()) : null;
  ro?.observe(area);
  refresh();

  return {
    objects: () => objects.map((o) => ({ tool: o.tool, points: o.points.map((p) => [p[0], p[1]] as [number, number]) })),
    destroy() {
      ro?.disconnect();
      root.remove();
    },
  };
}

/**
 * The nearest grid point that is still on the board. Bounds needn't be
 * multiples of the snap (x to 5 with snap 2): rounding can overshoot the
 * edge, so step back one snap step inside.
 */
export function snapInside(p: [number, number], board: GraphBoard, snap: [number, number]): [number, number] {
  const s = snap[0] / snap[1];
  const [x, y] = snapPoint(p[0], p[1], snap);
  const inside = (v: number, [lo, hi]: [number, number]) => (v > hi + 1e-9 ? v - s : v < lo - 1e-9 ? v + s : v);
  return [inside(x, board.x), inside(y, board.y)];
}

/** "3", "-2.5", "1/2", "−3/4" → number; anything else → null. */
export function parseCoordinate(text: string): number | null {
  const t = text.trim().replace(/−/g, "-");
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  const m = /^(-?)(\d+)\s*\/\s*(\d+)$/.exec(t);
  if (m && Number(m[3]) !== 0) return (m[1] ? -1 : 1) * (Number(m[2]) / Number(m[3]));
  return null;
}

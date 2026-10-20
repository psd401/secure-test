// The graphing calculator, assembled: expression list on the left, graph on
// the right, keypad beneath (D-5, D-6). One instance per container; the
// MathLive class is passed in so the page can load MathLive lazily (D-3).

import type { MathfieldElement } from "mathlive";
import { analyze, type Analysis } from "../engine/analyze";
import type { FunctionGroup } from "../engine/builtins";
import { latexToText } from "../engine/describe";
import { GraphView } from "./graph";
import { Keypad } from "./keypad";
import { ExpressionList } from "./list";
import { presetFor, type Mode } from "./presets";
import {
  addSliders,
  defaultRange,
  emptyRow,
  insertRow,
  removeRow,
  updateRow,
  type CalcState,
  type RowState,
  type SliderRange,
} from "./state";
import { INLINE_SHORTCUTS } from "./shortcuts";
import { CALCULATOR_CSS } from "./styles";
import { makeViewport, type Viewport } from "./viewport";

export interface SavedRow {
  latex: string;
  color?: string;
  hidden?: boolean;
  slider?: SliderRange;
}

export interface SavedGraph {
  rows: SavedRow[];
  degrees?: boolean;
  /** The view's bounds; the graph keeps its pixel size. */
  view?: { xmin: number; xmax: number; ymin: number; ymax: number };
}

export interface CalculatorOptions {
  MathfieldElement: typeof MathfieldElement;
  initial?: SavedGraph;
  /** graphing (default), scientific (no graph) or four_function. */
  mode?: Mode;
  /** A configuration from presets.ts ("full", "state_wa"); default "full". */
  preset?: string;
  /** Overrides the preset's disabled function groups. */
  disabled?: Iterable<FunctionGroup>;
  /** Show the keypad toggle (default true). */
  keypad?: boolean;
  /** Initial angle mode when `initial` doesn't say (default radians). */
  degrees?: boolean;
  readOnly?: boolean;
  onChange?: (saved: SavedGraph) => void;
}

export interface CalculatorHandle {
  readonly element: HTMLElement;
  save(): SavedGraph;
  load(saved: SavedGraph): void;
  destroy(): void;
}

let styled = false;

/** The calculator's stylesheet, once per document. */
export function installStyles(doc: Document = document): void {
  if (styled && doc === document) return;
  const style = doc.createElement("style");
  style.dataset.gc = "1";
  style.textContent = CALCULATOR_CSS;
  doc.head.append(style);
  if (doc === document) styled = true;
}

export function configureMathLive(M: typeof MathfieldElement): void {
  // Nothing loads from the network (CSP default-src 'none'): fonts are the
  // page's inlined KaTeX faces; sounds are off and never constructed (D-2).
  M.fontsDirectory = null;
  M.soundsDirectory = null;
  M.keypressSound = null;
  M.plonkSound = null;
  (M as unknown as { playSound: () => Promise<void> }).playSound = async () => {};
}

export function mountGraphing(container: HTMLElement, opts: CalculatorOptions): CalculatorHandle {
  installStyles(container.ownerDocument);
  configureMathLive(opts.MathfieldElement);
  const mode: Mode = opts.mode ?? "graphing";
  const preset = presetFor(opts.preset, mode);
  const disabled = new Set(opts.disabled ?? preset.disabled);
  const readOnly = opts.readOnly ?? false;
  const graphing = mode === "graphing";

  const root = document.createElement("div");
  root.className = `gc-root gc-mode-${mode}`;
  if (readOnly) root.classList.add("gc-readonly");
  const left = document.createElement("div");
  left.className = "gc-left";
  const right = document.createElement("div");
  right.className = "gc-right";
  const bottom = document.createElement("div");
  bottom.className = "gc-bottom";
  root.append(left, right, bottom);
  container.append(root);

  const toolbar = document.createElement("div");
  toolbar.className = "gc-toolbar";
  left.append(toolbar);

  const rect = right.getBoundingClientRect();
  let state: CalcState = {
    rows: [],
    degrees: opts.degrees ?? preset.degrees,
    viewport: makeViewport(rect.width || 600, rect.height || 400),
  };
  let home: SavedGraph["view"] | undefined;
  let analyses: Analysis[] = [];
  let selected: string | null = null;

  const makeField = (): MathfieldElement => {
    const f = new opts.MathfieldElement();
    // Most options need the field in the document; MathLive fires `mount`.
    f.addEventListener(
      "mount",
      () => {
        f.mathVirtualKeyboardPolicy = "manual";
        f.menuItems = [];
        f.popoverPolicy = "off";
        f.smartFence = true;
        f.smartSuperscript = true;
        f.inlineShortcuts = INLINE_SHORTCUTS;
        // Space is a thin space, as in other calculators — MathLive's default
        // jumps out of the bracket (cos(pi x) became cos(π)x).
        f.mathModeSpace = "\\,";
      },
      { once: true },
    );
    return f;
  };

  const list = new ExpressionList(
    left,
    makeField,
    {
      onEdit: (id, latex) => set({ rows: updateRow(state.rows, id, { latex }) }),
      onInsertAfter: (id) => {
        const [rows, newId] = insertRow(state.rows, id);
        set({ rows });
        list.focusRow(newId);
      },
      onRemove: (id, focusPrevious) => {
        const i = state.rows.findIndex((r) => r.id === id);
        const rows = removeRow(state.rows, id);
        set({ rows });
        const target = rows[Math.max(0, focusPrevious ? i - 1 : Math.min(i, rows.length - 1))];
        if (target) list.focusRow(target.id);
      },
      onToggle: (id) => {
        const row = state.rows.find((r) => r.id === id);
        if (row) set({ rows: updateRow(state.rows, id, { hidden: !row.hidden }) });
      },
      onFocus: (id) => {
        selected = id;
        render();
      },
      onSlider: (id, latex, range) => set({ rows: updateRow(state.rows, id, { latex, slider: range }) }),
      onAddSliders: (id, names) => set({ rows: addSliders(state.rows, names, id) }),
      onAdd: () => {
        const [rows, newId] = insertRow(state.rows, null);
        set({ rows });
        list.focusRow(newId);
      },
    },
    readOnly,
    graphing,
  );

  const graph: GraphView | null = !graphing ? null : new GraphView(right, state.viewport, {
    onViewport: (v: Viewport) => {
      state = { ...state, viewport: v };
      emit();
    },
    onSelect: (id) => {
      selected = id;
      render();
    },
    onHome: () => graph?.setViewport(homeViewport(), true),
    readOnly,
  });

  let keypad: Keypad | null = null;
  if (!readOnly && opts.keypad !== false) {
    keypad = new Keypad(
      bottom,
      () => list.current,
      () => {
        const id = selected ?? state.rows.at(-1)?.id ?? null;
        if (id) {
          const [rows, newId] = insertRow(state.rows, id);
          set({ rows });
          list.focusRow(newId);
        }
      },
      disabled,
      preset.pages,
      preset.sqrtKey,
    );
    // A scientific or four-function calculator is mostly its keypad.
    bottom.hidden = graphing;
  }

  // Toolbar: angle mode and keypad.
  const angle = document.createElement("div");
  angle.className = "gc-angle";
  angle.setAttribute("role", "radiogroup");
  angle.setAttribute("aria-label", "Angle units");
  const angleButton = (label: string, deg: boolean) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "gc-seg";
    b.setAttribute("role", "radio");
    b.textContent = label;
    b.addEventListener("click", () => set({ degrees: deg }));
    angle.append(b);
    return b;
  };
  const radBtn = angleButton("Radians", false);
  const degBtn = angleButton("Degrees", true);
  toolbar.append(angle);
  if (keypad) {
    const kb = document.createElement("button");
    kb.type = "button";
    kb.className = "gc-keypad-toggle";
    kb.textContent = "Keypad";
    kb.setAttribute("aria-expanded", String(!bottom.hidden));
    kb.addEventListener("click", () => {
      bottom.hidden = !bottom.hidden;
      kb.setAttribute("aria-expanded", String(!bottom.hidden));
      graph?.schedule();
    });
    toolbar.append(kb);
  }
  // Angles mean nothing to a four-function calculator.
  if (readOnly || mode === "four_function") angle.hidden = true;

  function homeViewport(): Viewport {
    const v = graph?.viewport ?? state.viewport;
    if (home) {
      // Fit the saved bounds to the current pixel size, keeping them in view.
      return { ...fitBounds(home, v.width, v.height) };
    }
    return makeViewport(v.width, v.height);
  }

  function set(patch: Partial<CalcState>): void {
    state = { ...state, ...patch };
    // A row that has become a slider keeps a range from then on.
    render();
    emit();
  }

  function emit(): void {
    opts.onChange?.(save());
  }

  function render(): void {
    analyses = analyze(state.rows, { degrees: state.degrees, disabled, functions: preset.functions });
    let rows = state.rows;
    analyses.forEach((a, i) => {
      if (a.kind === "slider" && !rows[i]!.slider) rows = updateRow(rows, rows[i]!.id, { slider: defaultRange(a.value) });
    });
    state = { ...state, rows };
    list.update(state.rows, analyses);
    graph?.setItems(
      state.rows.map((r, i) => ({ id: r.id, color: r.color, hidden: r.hidden, analysis: analyses[i]!, label: latexToText(r.latex) })),
      selected,
    );
    radBtn.setAttribute("aria-checked", String(!state.degrees));
    degBtn.setAttribute("aria-checked", String(state.degrees));
  }

  function save(): SavedGraph {
    const v = graph?.viewport ?? state.viewport;
    return {
      rows: state.rows.map((r) => ({
        latex: r.latex,
        color: r.color,
        ...(r.hidden ? { hidden: true } : {}),
        ...(r.slider ? { slider: r.slider } : {}),
      })),
      degrees: state.degrees,
      view: { xmin: v.xmin, xmax: v.xmax, ymin: v.ymin, ymax: v.ymax },
    };
  }

  function load(saved: SavedGraph): void {
    const rows: RowState[] = [];
    for (const r of saved.rows) {
      const row = emptyRow(rows, r.latex);
      rows.push({ ...row, color: r.color ?? row.color, hidden: r.hidden ?? false, ...(r.slider ? { slider: r.slider } : {}) });
    }
    if (rows.length === 0) rows.push(emptyRow([]));
    home = saved.view;
    state = { ...state, rows, degrees: saved.degrees ?? state.degrees };
    render();
    graph?.setViewport(homeViewport(), false);
  }

  load(opts.initial ?? { rows: [] });

  return {
    element: root,
    save,
    load,
    destroy() {
      graph?.destroy();
      root.remove();
    },
  };
}

/**
 * Saved bounds shown exactly in a w×h box. The scales may differ (a
 * stimulus may show x 0…100 against y 0…10); zooming keeps that ratio.
 */
export function fitBounds(b: { xmin: number; xmax: number; ymin: number; ymax: number }, w: number, h: number): Viewport {
  return { xmin: b.xmin, xmax: b.xmax, ymin: b.ymin, ymax: b.ymax, width: Math.max(w, 1), height: Math.max(h, 1) };
}

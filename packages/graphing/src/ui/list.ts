// The expression list (D-6): one row per expression with its colour
// swatch (also the show/hide toggle), a MathLive math field, and beneath it
// whatever the engine says about the row — a value, a slider, an error
// with "add slider" buttons.
//
// Keyboard: Enter adds a row below, Backspace in an empty row removes it,
// ↑ / ↓ at the edge of a field move between rows, Tab leaves as usual.

import type { MathfieldElement } from "mathlive";
import type { Analysis } from "../engine/analyze";
import { formatNumber } from "../engine/format";
import {
  defaultRange,
  formatSliderValue,
  setSliderValue,
  snapSlider,
  type RowState,
  type SliderRange,
} from "./state";

export interface ListCallbacks {
  /** A row's LaTeX changed by typing. */
  onEdit(id: string, latex: string): void;
  onInsertAfter(id: string): void;
  onRemove(id: string, focusPrevious: boolean): void;
  onToggle(id: string): void;
  onFocus(id: string | null): void;
  onSlider(id: string, latex: string, range: SliderRange): void;
  onAddSliders(id: string, names: string[]): void;
  onAdd(): void;
}

interface RowView {
  root: HTMLElement;
  index: HTMLElement;
  swatch: HTMLButtonElement;
  field: MathfieldElement;
  info: HTMLElement;
  remove: HTMLButtonElement;
  /** The analysis last rendered, to skip identical refreshes. */
  infoKey: string;
  range: HTMLInputElement | null;
}

export type MathfieldFactory = () => MathfieldElement;

export class ExpressionList {
  readonly element: HTMLElement;
  private readonly body: HTMLElement;
  private readonly views = new Map<string, RowView>();
  private order: string[] = [];
  private rows: RowState[] = [];
  /** Suppresses `input` handling while the list writes a field itself. */
  private writing = false;
  current: MathfieldElement | null = null;

  constructor(
    host: HTMLElement,
    private readonly makeField: MathfieldFactory,
    private readonly cb: ListCallbacks,
    private readonly readOnly = false,
    /** False on the scientific and four-function calculators: no graph. */
    private readonly graphing = true,
  ) {
    this.element = document.createElement("div");
    this.element.className = "gc-list";
    this.element.setAttribute("role", "list");
    this.element.setAttribute("aria-label", "Expressions");
    this.body = document.createElement("div");
    this.body.className = "gc-rows";
    this.element.append(this.body);
    if (!readOnly) {
      const add = document.createElement("button");
      add.type = "button";
      add.className = "gc-add-row";
      add.textContent = "+ Add expression";
      add.addEventListener("click", () => cb.onAdd());
      this.element.append(add);
    }
    host.append(this.element);
  }

  /** Brings the DOM in line with `rows` and their analyses. */
  update(rows: RowState[], analyses: Analysis[]): void {
    this.rows = rows;
    const ids = rows.map((r) => r.id);
    for (const [id, view] of this.views) {
      if (!ids.includes(id)) {
        view.root.remove();
        this.views.delete(id);
      }
    }
    rows.forEach((row, i) => {
      let view = this.views.get(row.id);
      if (!view) {
        view = this.build(row);
        this.views.set(row.id, view);
      }
      const before = this.body.children[i];
      if (before !== view.root) this.body.insertBefore(view.root, before ?? null);
      this.refresh(view, row, i, analyses[i] ?? { kind: "empty" });
    });
    this.order = ids;
  }

  focusRow(id: string, atEnd = true): void {
    const view = this.views.get(id);
    if (!view) return;
    view.field.focus();
    if (atEnd) view.field.executeCommand("moveToMathfieldEnd");
  }

  private build(row: RowState): RowView {
    const root = document.createElement("div");
    root.className = "gc-row";
    root.setAttribute("role", "listitem");
    root.dataset.id = row.id;

    const gutter = document.createElement("div");
    gutter.className = "gc-gutter";
    const index = document.createElement("span");
    index.className = "gc-index";
    const swatch = document.createElement("button");
    swatch.type = "button";
    swatch.className = "gc-swatch";
    swatch.addEventListener("click", () => this.cb.onToggle(row.id));
    gutter.append(index, swatch);

    const main = document.createElement("div");
    main.className = "gc-main";
    const field = this.makeField();
    field.className = "gc-field";
    if (this.readOnly) field.readOnly = true;
    this.writing = true;
    field.value = row.latex;
    this.writing = false;
    field.addEventListener("input", () => {
      if (this.writing) return;
      this.cb.onEdit(row.id, field.value);
    });
    field.addEventListener("focus", () => {
      this.current = field;
      root.classList.add("gc-row-focus");
      this.cb.onFocus(row.id);
    });
    field.addEventListener("blur", () => {
      root.classList.remove("gc-row-focus");
    });
    field.addEventListener("keydown", (e: KeyboardEvent) => {
      if (this.readOnly) return;
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.cb.onInsertAfter(row.id);
      } else if (e.key === "Backspace" && field.value === "" && this.rows.length > 1) {
        e.preventDefault();
        this.cb.onRemove(row.id, true);
      }
    });
    field.addEventListener("move-out", ((e: CustomEvent<{ direction: string }>) => {
      const i = this.order.indexOf(row.id);
      const dir = e.detail.direction;
      const target = dir === "upward" ? this.order[i - 1] : dir === "downward" ? this.order[i + 1] : undefined;
      if (target) {
        e.preventDefault();
        this.focusRow(target, dir === "upward");
      }
    }) as EventListener);
    const info = document.createElement("div");
    info.className = "gc-info";
    main.append(field, info);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "gc-delete";
    remove.textContent = "×";
    remove.hidden = this.readOnly;
    remove.addEventListener("click", () => this.cb.onRemove(row.id, false));

    root.append(gutter, main, remove);
    return { root, index, swatch, field, info, remove, infoKey: "", range: null };
  }

  private refresh(view: RowView, row: RowState, i: number, a: Analysis): void {
    const n = String(i + 1);
    view.index.textContent = n;
    view.field.setAttribute("aria-label", `Expression ${n}`);
    view.remove.setAttribute("aria-label", `Delete expression ${n}`);
    if (view.field.value !== row.latex && !view.field.hasFocus()) {
      this.writing = true;
      view.field.value = row.latex;
      this.writing = false;
    }
    const drawable = a.kind === "curve" || a.kind === "points" || a.kind === "implicit" || a.kind === "region" || (a.kind === "function" && a.plot !== null);
    view.swatch.style.setProperty("--gc-row-color", row.color);
    view.swatch.classList.toggle("gc-swatch-off", row.hidden);
    view.swatch.hidden = !drawable || !this.graphing;
    view.swatch.setAttribute("aria-pressed", String(!row.hidden));
    view.swatch.setAttribute("aria-label", `${row.hidden ? "Show" : "Hide"} expression ${n} on the graph`);

    const key = JSON.stringify({ a: infoShape(a), s: row.slider ?? null });
    if (key === view.infoKey) {
      // Same slider: move the thumb only (not while it is being dragged).
      if (a.kind === "slider" && view.range && document.activeElement !== view.range) {
        view.range.value = String(a.value);
      }
      return;
    }
    view.infoKey = key;
    view.range = null;
    view.info.replaceChildren();
    view.root.classList.toggle("gc-row-error", a.kind === "error");
    switch (a.kind) {
      case "error": {
        const msg = document.createElement("div");
        msg.className = "gc-error";
        msg.setAttribute("role", "note");
        msg.textContent = a.message;
        view.info.append(msg);
        if (a.missing.length && !this.readOnly) view.info.append(this.sliderButtons(row.id, a.missing));
        break;
      }
      case "value": {
        const val = document.createElement("div");
        val.className = "gc-value";
        val.textContent = "= " + (Array.isArray(a.value) ? `[${a.value.map(formatNumber).join(", ")}]` : formatNumber(a.value));
        view.info.append(val);
        break;
      }
      case "curve":
      case "implicit":
      case "region":
      case "points":
        if (!this.graphing) view.info.append(note("Graphs need the graphing calculator."));
        break;
      case "slider": {
        const s = this.slider(row, a.name, a.value);
        view.range = s.querySelector("input[type=range]");
        view.info.append(s);
        break;
      }
      default:
        break;
    }
  }

  private sliderButtons(id: string, names: string[]): HTMLElement {
    const box = document.createElement("div");
    box.className = "gc-add-sliders";
    const label = document.createElement("span");
    label.textContent = "add slider:";
    box.append(label);
    const mk = (text: string, ns: string[], aria: string) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "gc-chip";
      b.textContent = text;
      b.setAttribute("aria-label", aria);
      b.addEventListener("click", () => this.cb.onAddSliders(id, ns));
      box.append(b);
    };
    for (const name of names) mk(display(name), [name], `Add a slider for ${display(name)}`);
    if (names.length > 1) mk("all", names, "Add sliders for all");
    return box;
  }

  private slider(row: RowState, name: string, value: number): HTMLElement {
    const range = row.slider ?? defaultRange(value);
    const box = document.createElement("div");
    box.className = "gc-slider";
    const min = numberInput(range.min, `Slider ${display(name)} minimum`);
    const max = numberInput(range.max, `Slider ${display(name)} maximum`);
    const input = document.createElement("input");
    input.type = "range";
    input.className = "gc-range";
    input.min = String(range.min);
    input.max = String(range.max);
    input.step = "any";
    input.value = String(value);
    input.setAttribute("aria-label", `${display(name)} slider`);
    input.setAttribute("aria-valuetext", `${display(name)} = ${formatSliderValue(value)}`);
    const emit = (v: number, r: SliderRange) => {
      const latex = setSliderValue(this.rows.find((x) => x.id === row.id)?.latex ?? row.latex, v);
      this.cb.onSlider(row.id, latex, r);
    };
    input.addEventListener("input", () => {
      const r = this.rows.find((x) => x.id === row.id)?.slider ?? range;
      const v = snapSlider(Number(input.value), r);
      input.setAttribute("aria-valuetext", `${display(name)} = ${formatSliderValue(v)}`);
      emit(v, r);
    });
    const onRange = () => {
      const lo = Number(min.value);
      const hi = Number(max.value);
      if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo >= hi) return;
      const r = { ...range, min: lo, max: hi };
      emit(Math.min(hi, Math.max(lo, Number(input.value))), r);
    };
    min.addEventListener("change", onRange);
    max.addEventListener("change", onRange);
    // Step buttons: a tap alternative to dragging (WCAG 2.5.7).
    const step = (dir: number) => {
      const r = this.rows.find((x) => x.id === row.id)?.slider ?? range;
      const s = r.step > 0 ? r.step : (r.max - r.min) / 100;
      const cur = Number(input.value);
      emit(snapSlider(cur + dir * s, r), r);
    };
    const less = stepButton("−", `Decrease ${display(name)}`, () => step(-1));
    const more = stepButton("+", `Increase ${display(name)}`, () => step(1));
    box.append(min, less, input, more, max);
    return box;
  }
}

function note(text: string): HTMLElement {
  const d = document.createElement("div");
  d.className = "gc-note";
  d.textContent = text;
  return d;
}

function numberInput(value: number, label: string): HTMLInputElement {
  const i = document.createElement("input");
  i.type = "number";
  i.className = "gc-slider-bound";
  i.value = String(value);
  i.step = "any";
  i.setAttribute("aria-label", label);
  return i;
}

function stepButton(text: string, label: string, act: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "gc-step";
  b.textContent = text;
  b.setAttribute("aria-label", label);
  b.addEventListener("click", act);
  return b;
}

function display(name: string): string {
  const greek: Record<string, string> = { theta: "θ", alpha: "α", beta: "β", lambda: "λ", mu: "μ", phi: "φ", omega: "ω" };
  const [base, sub] = name.split("_") as [string, string | undefined];
  return (greek[base] ?? base) + (sub ? `_${sub}` : "");
}

/** The parts of an analysis the info line shows (functions don't serialise). */
function infoShape(a: Analysis): unknown {
  switch (a.kind) {
    case "error":
      return [a.kind, a.message, a.missing];
    case "value":
      return [a.kind, a.value];
    case "slider":
      // The value is left out: dragging must not rebuild the slider.
      return [a.kind, a.name];
    default:
      return [a.kind];
  }
}

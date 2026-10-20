// A teacher's graph shown with a question (D-8): read-only, but the student
// can pan, zoom and reset it, and tap a curve for its points of interest.
// No MathLive — the expressions are listed as a legend, typeset by the
// page's KaTeX when it is there and as readable text when it is not. The
// teacher's alt text is the graph's accessible name and is also shown on
// request, so the picture never stands alone.

import { analyze } from "../engine/analyze";
import { latexToText } from "../engine/describe";
import { GRAPH_KEYS, GraphView } from "./graph";
import { installStyles } from "./calculator";
import { PALETTE } from "./state";
import { fitBounds } from "./calculator";
import type { Viewport } from "./viewport";

export interface StimulusGraph {
  rows: { latex: string; color?: string; hidden?: boolean }[];
  view: { xmin: number; xmax: number; ymin: number; ymax: number };
  degrees?: boolean;
  alt: string;
}

interface KatexLike {
  render(tex: string, el: HTMLElement, opts: Record<string, unknown>): void;
}

export interface StimulusHandle {
  destroy(): void;
}

export function mountStimulus(container: HTMLElement, g: StimulusGraph): StimulusHandle {
  installStyles(container.ownerDocument);
  const root = document.createElement("figure");
  root.className = "gc-root gc-stimulus";
  const area = document.createElement("div");
  area.className = "gc-stimulus-graph";
  root.append(area);
  container.append(root);

  const rows = g.rows.map((r, i) => ({
    id: `s${i}`,
    color: r.color && /^#[0-9a-fA-F]{6}$/.test(r.color) ? r.color : PALETTE[i % PALETTE.length]!,
    hidden: r.hidden === true,
    latex: r.latex,
  }));
  const analyses = analyze(rows, { degrees: g.degrees === true, disabled: new Set() });
  const home = (): Viewport => fitBounds(g.view, view.viewport.width, view.viewport.height);
  let selected: string | null = null;
  const view = new GraphView(area, fitBounds(g.view, 480, 360), {
    onViewport: () => {},
    onSelect: (id) => {
      selected = id;
      draw();
    },
    onHome: () => view.setViewport(home(), false),
    readOnly: true,
    keepBounds: true,
  });
  view.element.setAttribute("aria-label", `${g.alt} ${GRAPH_KEYS}`);
  const draw = () =>
    view.setItems(
      rows.map((r, i) => ({ id: r.id, color: r.color, hidden: r.hidden, analysis: analyses[i]!, label: latexToText(r.latex) })),
      selected,
    );
  draw();

  const legend = document.createElement("ul");
  legend.className = "gc-legend";
  const katex = (globalThis as { katex?: KatexLike }).katex;
  rows.forEach((r) => {
    if (r.hidden || !r.latex.trim()) return;
    const li = document.createElement("li");
    const sw = document.createElement("span");
    sw.className = "gc-legend-swatch";
    sw.style.background = r.color;
    sw.setAttribute("aria-hidden", "true");
    const expr = document.createElement("span");
    expr.className = "gc-legend-expr";
    if (katex) {
      try {
        katex.render(r.latex, expr, { throwOnError: false, strict: "ignore", trust: false });
      } catch {
        expr.textContent = latexToText(r.latex);
      }
    } else {
      expr.textContent = latexToText(r.latex);
    }
    li.append(sw, expr);
    legend.append(li);
  });
  const caption = document.createElement("figcaption");
  caption.className = "gc-stimulus-caption";
  const details = document.createElement("details");
  const summary = document.createElement("summary");
  summary.textContent = "Describe this graph";
  const alt = document.createElement("p");
  alt.textContent = g.alt;
  details.append(summary, alt);
  caption.append(legend, details);
  root.append(caption);

  return {
    destroy() {
      view.destroy();
      root.remove();
    },
  };
}

// The slice-2 playground: the calculator in a plain page, for judging look
// and feel, plus a capture of every LaTeX string MathLive produced — the
// corpus the parser's grammar is checked against (D-4).
import { MathfieldElement } from "mathlive";
import { mountGraphing, type SavedGraph } from "../src/ui/index";
import { mountGraphAnswer } from "../src/ui/graphAnswer";

const SAMPLES: SavedGraph = {
  rows: [
    { latex: "y=x^{2}-4" },
    { latex: "y=m\\cdot x+b" },
    { latex: "m=1" },
    { latex: "b=2" },
    { latex: "y\\le\\sin\\left(x\\right)\\left\\{x>0\\right\\}" },
    { latex: "f\\left(x\\right)=\\frac{1}{x-3}" },
    { latex: "\\left(2,3\\right),\\left(-4,1\\right)" },
    { latex: "\\operatorname{mean}\\left(1,2,3,10\\right)" },
    { latex: "x^{2}+y^{2}=16" },
    { latex: "xy<-2" },
    { latex: "0<y<x\\left\\{x<4\\right\\}" },
    { latex: "x^{2}+y^{2}=16" },
    { latex: "xy<-2" },
    { latex: "0<y<x\\left\\{x<4\\right\\}" },
  ],
};

const KEY = "gc-playground";
const CORPUS = "gc-playground-corpus";

function load(): SavedGraph {
  try {
    const s = localStorage.getItem(KEY);
    if (s) return JSON.parse(s) as SavedGraph;
  } catch {}
  return SAMPLES;
}

const corpus = new Set<string>();
try {
  for (const l of JSON.parse(localStorage.getItem(CORPUS) ?? "[]") as string[]) corpus.add(l);
} catch {}
const corpusBox = document.getElementById("corpus") as HTMLTextAreaElement;
const showCorpus = () => (corpusBox.value = [...corpus].join("\n"));
showCorpus();

const host = document.getElementById("calc")!;
let calc = mountGraphing(host, { MathfieldElement, initial: load(), onChange: save });

function save(g: SavedGraph): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(g));
  } catch {}
  let grew = false;
  for (const r of g.rows) {
    if (r.latex && !corpus.has(r.latex)) {
      corpus.add(r.latex);
      grew = true;
    }
  }
  if (grew) {
    showCorpus();
    try {
      localStorage.setItem(CORPUS, JSON.stringify([...corpus]));
    } catch {}
  }
}

document.getElementById("reset")!.addEventListener("click", () => {
  calc.destroy();
  calc = mountGraphing(host, { MathfieldElement, initial: SAMPLES, onChange: save });
});
document.getElementById("clear")!.addEventListener("click", () => {
  calc.destroy();
  calc = mountGraphing(host, { MathfieldElement, initial: { rows: [] }, onChange: save });
});

// `#answer`: the graph-answer board (slice 7), with a key for review below.
if (location.hash === "#answer") {
  calc.destroy();
  host.style.overflow = "auto";
  host.style.padding = "12px";
  const board = { x: [-6, 6] as [number, number], y: [-6, 6] as [number, number], grid: 1, snap: "1", tools: ["point", "line", "segment", "ray", "circle", "parabola"] as const, max_objects: 3 };
  const top = document.createElement("div");
  const bottom = document.createElement("div");
  host.append(top, bottom);
  const key = { objects: [{ tool: "line" as const, points: [[0, 1], [1, 3]] as [number, number][] }], scoring: "all" as const };
  mountGraphAnswer(top, { ...board, tools: [...board.tools] }, { label: "Your answer", onChange: (o) => console.log(JSON.stringify(o)) });
  mountGraphAnswer(bottom, { ...board, tools: [...board.tools] }, {
    readOnly: true,
    key,
    label: "Review",
    initial: [{ tool: "line", points: [[1, 3], [2, 5]] }, { tool: "point", points: [[2, 2]] }],
  });
}

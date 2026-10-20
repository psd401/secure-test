// What the design tool's server uses (no DOM, no MathLive): the SVG of a
// stimulus graph for preview and print, the alt-text draft, and the engine.
export { renderGraphSvg, type SvgGraph, type SvgOptions } from "./engine/svg";
export { describeGraph, latexToText } from "./engine/describe";
export { analyze, type Analysis } from "./engine/analyze";

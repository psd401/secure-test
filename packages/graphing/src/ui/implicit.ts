// Implicit equations and inequalities (x²+y²=4, xy>1, 0<y<x) — drawn in
// slice 4 with interval arithmetic and marching squares. Until then they
// draw nothing; the row itself still shows no error.

import type { Analysis } from "../engine/analyze";
import type { Viewport } from "./viewport";

export function drawImplicit(
  _ctx: CanvasRenderingContext2D,
  _v: Viewport,
  _a: Extract<Analysis, { kind: "implicit" | "region" }>,
  _color: string,
): void {}

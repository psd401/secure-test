import { z } from "zod";

// Graph answers (docs/graphing-calculator-design.md D-9). The student places
// objects on a snapped grid; the key is objects drawn the same way. Scoring
// compares shapes with exact integer arithmetic (packages/graphing,
// engine/graphAnswer.ts) — these are only the wire shapes.

export const GRAPH_TOOLS = ["point", "line", "segment", "ray", "circle", "parabola"] as const;
export const GraphToolSchema = z.enum(GRAPH_TOOLS);
export type GraphTool = z.infer<typeof GraphToolSchema>;

const Coord = z.number().finite().min(-1e6).max(1e6);

// A point has one point; every other tool two (click order).
export const GraphObjectSchema = z
  .object({
    tool: GraphToolSchema,
    points: z.array(z.tuple([Coord, Coord])).min(1).max(2),
  })
  .refine((o) => o.points.length === (o.tool === "point" ? 1 : 2), {
    message: "a point has one point; every other object two",
    path: ["points"],
  });
export type GraphObject = z.infer<typeof GraphObjectSchema>;

// Snap as a rational: "1", "1/2", "0.25" (at most 6 decimals).
const SNAP_RE = /^(\d+(\.\d{1,6})?|\d+\/\d+)$/;

export const GraphBoardSchema = z
  .object({
    x: z.tuple([Coord, Coord]),
    y: z.tuple([Coord, Coord]),
    grid: z.number().finite().positive(),
    snap: z.string().regex(SNAP_RE),
    tools: z.array(GraphToolSchema).min(1).max(GRAPH_TOOLS.length),
    max_objects: z.number().int().min(1).max(10),
    fixed: z.array(GraphObjectSchema).max(10).optional(),
  })
  .refine((b) => b.x[0] < b.x[1] && b.y[0] < b.y[1], { message: "the board's minimums must be below its maximums" })
  .refine((b) => (b.x[1] - b.x[0]) / b.grid <= 100 && (b.y[1] - b.y[0]) / b.grid <= 100, {
    message: "at most 100 grid lines across",
  })
  .refine((b) => new Set(b.tools).size === b.tools.length, { message: "a tool is listed twice" });
export type GraphBoard = z.infer<typeof GraphBoardSchema>;

export const GraphKeySchema = z.object({
  objects: z.array(GraphObjectSchema).min(1).max(10),
  scoring: z.enum(["all", "per_object"]),
});
export type GraphKey = z.infer<typeof GraphKeySchema>;

// What the student sends: the objects they placed, at most ten.
export const GraphResponseSchema = z.object({
  type: z.literal("graph"),
  objects: z.array(GraphObjectSchema).max(10),
});
export type GraphResponse = z.infer<typeof GraphResponseSchema>;

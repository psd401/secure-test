"use client";

// Graphing calculator D-9: a "Graph it" question. The teacher sets the grid
// (its extent, spacing and snap), the tools students may use and how many
// objects they may place, then draws the answer key on the same board the
// student will use — each key object read back in words so the teacher can
// check it ("y = 2x + 1"). The key is optional while drafting; without one
// the question is hand-scored.

import { useEffect, useRef, useState } from "react";
import type { GraphBoard, GraphKey, GraphObject, GraphTool } from "@secure-test/schema";
import { describeObject, GRAPH_TOOLS, parseSnap } from "@secure-test/graphing/server";

export const DEFAULT_GRAPH_BOARD: GraphBoard = {
  x: [-10, 10],
  y: [-10, 10],
  grid: 1,
  snap: "1",
  tools: ["point", "line"],
  max_objects: 2,
};

const TOOL_LABEL: Record<GraphTool, string> = {
  point: "Point",
  line: "Line",
  segment: "Segment",
  ray: "Ray",
  circle: "Circle",
  parabola: "Parabola",
};

type Handle = { objects(): GraphObject[]; destroy(): void };

export function GraphItemEditor({
  board,
  graphKey,
  onChange,
  disabled,
}: {
  board: GraphBoard;
  graphKey: GraphKey | null;
  onChange: (patch: { board?: GraphBoard; graph_key?: GraphKey | null }) => void;
  disabled: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const handle = useRef<Handle | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Text fields hold what the teacher typed; the board changes when valid.
  const [fields, setFields] = useState({
    x0: String(board.x[0]),
    x1: String(board.x[1]),
    y0: String(board.y[0]),
    y1: String(board.y[1]),
    grid: String(board.grid),
    snap: board.snap,
  });
  const [fieldError, setFieldError] = useState<string | null>(null);
  const boardKey = JSON.stringify(board);

  // (Re)mount the key board when the board changes; the key drawn so far stays.
  useEffect(() => {
    if (!host.current) return;
    let cancelled = false;
    void (async () => {
      const { mountGraphAnswer } = await import("@secure-test/graphing/ui");
      if (cancelled || !host.current) return;
      handle.current?.destroy();
      handle.current = mountGraphAnswer(host.current, board, {
        initial: graphKey?.objects ?? [],
        readOnly: disabled,
        label: "Answer key",
        onChange: (objects) =>
          onChange({ graph_key: objects.length ? { objects, scoring: graphKey?.scoring ?? "all" } : null }),
      });
    })().catch((e) => setLoadError(`The grid couldn't load: ${e instanceof Error ? e.message : String(e)}`));
    return () => {
      cancelled = true;
      handle.current?.destroy();
      handle.current = null;
    };
    // The key is read on (re)mount; later key edits come from the board itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardKey, disabled]);

  function applyFields(next: typeof fields) {
    setFields(next);
    const nums = [next.x0, next.x1, next.y0, next.y1, next.grid].map(Number);
    if (nums.some((n) => !Number.isFinite(n))) return setFieldError("Use numbers for the grid.");
    const [x0, x1, y0, y1, grid] = nums as [number, number, number, number, number];
    if (!(x0 < x1 && y0 < y1)) return setFieldError("Each “from” must be below its “to”.");
    if (!(grid > 0)) return setFieldError("Grid lines need a positive spacing.");
    if ((x1 - x0) / grid > 100 || (y1 - y0) / grid > 100) return setFieldError("At most 100 grid lines across.");
    if (!parseSnap(next.snap)) return setFieldError("Snap to a positive number or a fraction like 1/2.");
    setFieldError(null);
    onChange({ board: { ...board, x: [x0, x1], y: [y0, y1], grid, snap: next.snap.trim() } });
  }

  function toggleTool(t: GraphTool, on: boolean) {
    const tools = GRAPH_TOOLS.filter((x) => (x === t ? on : board.tools.includes(x)));
    if (tools.length === 0) return;
    onChange({ board: { ...board, tools } });
  }

  const num = (label: string, key: keyof typeof fields, width = "w-20") => (
    <label className="text-sm">
      <span className="sr-only">{label}</span>
      <input
        aria-label={label}
        value={fields[key]}
        onChange={(e) => applyFields({ ...fields, [key]: e.target.value })}
        disabled={disabled}
        className={`${width} rounded-md border border-border bg-transparent px-2 py-1 text-sm`}
      />
    </label>
  );

  return (
    <div className="space-y-3">
      <fieldset className="space-y-2 rounded-md border border-border p-3">
        <legend className="px-1 text-sm font-medium">The grid</legend>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          x from {num("x from", "x0")} to {num("x to", "x1")}, y from {num("y from", "y0")} to {num("y to", "y1")}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          Grid lines every {num("Grid spacing", "grid", "w-16")}; points snap to steps of {num("Snap", "snap", "w-16")}
        </div>
        {fieldError ? (
          <p className="text-sm text-destructive" role="alert">
            {fieldError}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-3 text-sm" role="group" aria-label="Tools students may use">
          <span>Students may place:</span>
          {GRAPH_TOOLS.map((t) => (
            <label key={t} className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={board.tools.includes(t)}
                onChange={(e) => toggleTool(t, e.target.checked)}
                disabled={disabled || (board.tools.length === 1 && board.tools.includes(t))}
              />
              {TOOL_LABEL[t]}
            </label>
          ))}
        </div>
        <label className="flex items-center gap-2 text-sm">
          At most
          <input
            type="number"
            min={1}
            max={10}
            value={board.max_objects}
            onChange={(e) => {
              const n = Math.max(1, Math.min(10, Math.round(Number(e.target.value) || 1)));
              onChange({ board: { ...board, max_objects: n } });
            }}
            disabled={disabled}
            className="w-16 rounded-md border border-border bg-transparent px-2 py-1 text-sm"
          />
          objects
        </label>
      </fieldset>

      <div className="space-y-2">
        <p className="text-sm font-medium">Answer key</p>
        <p className="text-xs text-muted-foreground">
          Draw the answer on the grid as a student would. Any two points on the right line count as the same line,
          and so on for every shape. Leave it empty to score this question by hand.
        </p>
        <div ref={host} />
        {loadError ? <p className="text-sm text-destructive">{loadError}</p> : null}
        {graphKey ? (
          <>
            <ul className="list-disc pl-5 text-sm" aria-label="The key, in words">
              {graphKey.objects.map((o, i) => (
                <li key={i}>{describeObject(o, board)}</li>
              ))}
            </ul>
            <label className="flex items-center gap-2 text-sm">
              Scoring
              <select
                value={graphKey.scoring}
                onChange={(e) => onChange({ graph_key: { ...graphKey, scoring: e.target.value as GraphKey["scoring"] } })}
                disabled={disabled}
                className="rounded-md border border-border bg-transparent px-2 py-1 text-sm"
              >
                <option value="all">All or nothing (1 point)</option>
                <option value="per_object">A point for each object in the key</option>
              </select>
            </label>
            {graphKey.objects.length > board.max_objects ? (
              <p className="text-sm text-destructive" role="alert">
                The key has more objects than students may place.
              </p>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}

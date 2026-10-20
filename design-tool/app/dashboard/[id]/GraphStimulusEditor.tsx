"use client";

// Graphing calculator D-8: a teacher-authored graph shown with a question.
// The teacher builds it in the same calculator students use (loaded only
// when "Add a graph" is pressed — MathLive is large), sets the view by
// panning and zooming, and writes the alt text, drafted for them from the
// expressions. Saving puts the graph on the item; the question's own Save
// sends it.

import { useEffect, useRef, useState } from "react";
import type { StimulusGraph } from "@secure-test/schema";
import { describeGraph, renderGraphSvg } from "@secure-test/graphing/server";
import { Button } from "@/components/ui/button";

type Handle = { save(): SavedGraph; destroy(): void };
type SavedGraph = {
  rows: { latex: string; color?: string; hidden?: boolean }[];
  degrees?: boolean;
  view?: { xmin: number; xmax: number; ymin: number; ymax: number };
};

const DEFAULT_VIEW = { xmin: -10, xmax: 10, ymin: -7.5, ymax: 7.5 };

/** The calculator's saved state as a stimulus graph (rows trimmed and capped). */
export function toStimulus(saved: SavedGraph, alt: string): StimulusGraph | null {
  const rows = saved.rows
    .filter((r) => r.latex.trim() !== "")
    .slice(0, 20)
    .map((r) => ({
      latex: r.latex.slice(0, 500),
      ...(r.color && /^#[0-9a-fA-F]{6}$/.test(r.color) ? { color: r.color } : {}),
      ...(r.hidden ? { hidden: true as const } : {}),
    }));
  if (rows.length === 0) return null;
  const view = saved.view ?? DEFAULT_VIEW;
  return {
    rows,
    view: { xmin: view.xmin, xmax: view.xmax, ymin: view.ymin, ymax: view.ymax },
    ...(saved.degrees ? { degrees: true as const } : {}),
    alt: alt.trim(),
  };
}

export function GraphStimulusEditor({
  value,
  onChange,
  disabled,
}: {
  value: StimulusGraph | null;
  onChange: (next: StimulusGraph | null) => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [alt, setAlt] = useState(value?.alt ?? "");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const host = useRef<HTMLDivElement>(null);
  const handle = useRef<Handle | null>(null);

  useEffect(() => {
    if (!open || !host.current) return;
    let cancelled = false;
    setLoading(true);
    void (async () => {
      const [{ mountGraphing }, { MathfieldElement }] = await Promise.all([
        import("@secure-test/graphing/ui"),
        import("@secure-test/graphing/mathlive"),
      ]);
      if (cancelled || !host.current) return;
      handle.current = mountGraphing(host.current, {
        MathfieldElement,
        initial: value
          ? { rows: value.rows, degrees: value.degrees === true, view: value.view }
          : { rows: [{ latex: "" }], view: DEFAULT_VIEW },
      });
      setLoading(false);
    })().catch((e) => {
      setError(`The calculator couldn't load: ${e instanceof Error ? e.message : String(e)}`);
      setLoading(false);
    });
    return () => {
      cancelled = true;
      handle.current?.destroy();
      handle.current = null;
    };
    // `value` is read once, when the editor opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function draft() {
    const saved = handle.current?.save();
    if (!saved) return;
    const g = toStimulus(saved, "x");
    setAlt(g ? describeGraph(g) : "");
  }

  function save() {
    const saved = handle.current?.save();
    if (!saved) return;
    if (!alt.trim()) {
      setError("Describe the graph for students who can't see it (you can start from the draft).");
      return;
    }
    const g = toStimulus(saved, alt);
    if (!g) {
      setError("Add at least one expression to graph.");
      return;
    }
    if (!(g.view.xmin < g.view.xmax && g.view.ymin < g.view.ymax)) {
      setError("The graph's view isn't valid; press the home button and try again.");
      return;
    }
    setError(null);
    onChange(g);
    setOpen(false);
  }

  if (!open) {
    return (
      <div className="mt-2">
        {value ? (
          <figure className="max-w-sm rounded-md border border-border p-2">
            {/* Our own SVG, shown as an image: nothing is parsed into the page. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(renderGraphSvg(value, { title: value.alt }))}`}
              alt={value.alt}
              className="w-full"
            />
            <figcaption className="mt-1 text-xs text-muted-foreground">{value.alt}</figcaption>
          </figure>
        ) : null}
        <div className="mt-2 flex gap-2">
          <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => setOpen(true)}>
            {value ? "Edit graph" : "Add a graph"}
          </Button>
          {value ? (
            <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => onChange(null)}>
              Remove graph
            </Button>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="mt-2 rounded-md border border-border p-3">
      <p className="text-sm font-medium">Graph shown with this question</p>
      <p className="text-xs text-muted-foreground">
        Type expressions as students would. Pan and zoom to the view students should see first — they can move it, and
        the home button brings it back.
      </p>
      <div ref={host} className="mt-2 h-[28rem] w-full overflow-hidden rounded-md border border-border">
        {loading ? <p className="p-3 text-sm text-muted-foreground">Loading the calculator…</p> : null}
      </div>
      <label className="mt-3 block">
        <span className="block text-sm font-medium">Describe the graph</span>
        <span className="block text-xs text-muted-foreground">
          Read aloud to students who can&rsquo;t see it, and shown under the graph on request.
        </span>
        <textarea
          value={alt}
          onChange={(e) => setAlt(e.target.value)}
          maxLength={1000}
          rows={2}
          className="mt-1 w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm"
        />
      </label>
      {error ? (
        <p className="mt-1 text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      <div className="mt-2 flex gap-2">
        <Button type="button" variant="outline" size="sm" onClick={draft} disabled={loading}>
          Draft a description
        </Button>
        <Button type="button" size="sm" onClick={save} disabled={loading}>
          Use this graph
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

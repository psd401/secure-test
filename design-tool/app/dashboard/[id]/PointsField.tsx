"use client";

// B1 slice 2 (docs/point-weighting-design.md): what a question is worth.
// Empty = the natural maximum (the placeholder shows it). The typed text is
// kept locally, and only a valid value (D5: > 0, ≤ 100, ≤ 2 decimals) or an
// empty box reaches the item, so a half-typed "1." never autosaves a 400.

import { useEffect, useId, useState } from "react";
import { naturalMaxPoints, pointsHint } from "@/lib/scoring/maxPoints";
import { viewMaxInput, type ItemView } from "./editorModel";

export function parsePoints(text: string): { ok: true; value: number | null } | { ok: false; message: string } {
  const t = text.trim();
  if (t === "") return { ok: true, value: null };
  const n = Number(t);
  if (!Number.isFinite(n)) return { ok: false, message: "Enter a number." };
  if (n <= 0) return { ok: false, message: "Points must be more than 0." };
  if (n > 100) return { ok: false, message: "Points can be at most 100." };
  if (Math.abs(n * 100 - Math.round(n * 100)) > 1e-9) {
    return { ok: false, message: "Use at most 2 decimal places." };
  }
  return { ok: true, value: n };
}

export function PointsField({
  item,
  onChange,
}: {
  item: ItemView;
  onChange: (points: number | null) => void;
}) {
  const id = useId();
  const stored = item.points ?? null;
  const [text, setText] = useState(stored == null ? "" : String(stored));
  // An outside change (History → Restore, a type change) resets the box.
  useEffect(() => {
    setText((cur) => {
      const parsed = parsePoints(cur);
      return parsed.ok && parsed.value === stored ? cur : stored == null ? "" : String(stored);
    });
  }, [stored]);

  const parsed = parsePoints(text);
  const input = viewMaxInput(item);
  const natural = naturalMaxPoints(input);
  const hint = pointsHint(input);

  return (
    <div className="mt-3">
      <label htmlFor={id} className="block text-sm font-medium">
        Points{" "}
        <span className="font-normal text-muted-foreground">(what this question is worth)</span>
      </label>
      <input
        id={id}
        type="number"
        inputMode="decimal"
        min={0.01}
        max={100}
        step="any"
        value={text}
        placeholder={String(natural)}
        aria-describedby={`${id}-hint`}
        aria-invalid={!parsed.ok}
        onChange={(e) => {
          setText(e.target.value);
          const next = parsePoints(e.target.value);
          if (next.ok && next.value !== stored) onChange(next.value);
        }}
        // Each valid prefix saves as it is typed ("1.23" on the way to
        // "1.234"), so on leaving the box an invalid entry shows the value
        // that was actually kept rather than an error over a different number.
        onBlur={() => {
          if (!parsePoints(text).ok) setText(stored == null ? "" : String(stored));
        }}
        className="mt-1 w-28 rounded-md border border-border bg-transparent px-3 py-2 text-sm"
      />
      <p id={`${id}-hint`} className={`mt-1 text-xs ${parsed.ok ? "text-muted-foreground" : "text-destructive"}`}>
        {parsed.ok
          ? (hint ??
            `${stored == null ? "Leave empty for" : "Clear to go back to"} ${natural} point${natural === 1 ? "" : "s"}.`)
          : parsed.message}
      </p>
    </div>
  );
}

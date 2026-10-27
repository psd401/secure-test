"use client";

import { useState } from "react";
import { GripVertical } from "lucide-react";
import type { MatchPair } from "@secure-test/schema";
import { matchSwapAnnouncement, swapMatchRights } from "@/lib/authoring/keyOrder";
import { MoveAnnouncer, SortableRows } from "./SortableRows";

// Slice 47: pair-list editor for match items. Pairs are plain strings v1.
// The left/right of one row belong together — that IS the answer key; the
// preview (and later the student client) displays rights out of authored
// order so the layout doesn't give matches away. Minimum two pairs
// (server-enforced); ids are generated here and never shown to teachers.

interface Props {
  pairs: MatchPair[];
  onChange: (pairs: MatchPair[]) => void;
  disabled: boolean;
  /**
   * R-7 (Phase 4 slice C), the new editor only: re-pair by dragging a right
   * onto another row, or by Swap then "Swap with this" — both swap the two
   * rows' rights and announce the new matches.
   */
  repairable?: boolean;
}

function nextPairId(pairs: MatchPair[]): string {
  const ids = new Set(pairs.map((p) => p.id));
  let n = pairs.length + 1;
  while (ids.has(`p${n}`)) n += 1;
  return `p${n}`;
}

export function MatchPairsEditor({ pairs, onChange, disabled, repairable = false }: Props) {
  if (repairable) return <RepairablePairs pairs={pairs} onChange={onChange} disabled={disabled} />;
  const update = (idx: number, patch: Partial<MatchPair>) =>
    onChange(pairs.map((p, i) => (i === idx ? { ...p, ...patch } : p)));

  return (
    <div className="space-y-2">
      <div className="text-sm font-medium">
        Pairs{" "}
        <span className="font-normal text-muted-foreground">
          (each left matches its own right; students see the rights shuffled)
        </span>
      </div>
      {pairs.map((p, i) => (
        <div key={p.id} className="flex items-center gap-2">
          <input
            value={p.left}
            placeholder="Left (prompt)"
            disabled={disabled}
            onChange={(e) => update(i, { left: e.target.value })}
            className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm"
          />
          <span aria-hidden className="text-muted-foreground">
            ↔
          </span>
          <input
            value={p.right}
            placeholder="Right (match)"
            disabled={disabled}
            onChange={(e) => update(i, { right: e.target.value })}
            className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm"
          />
          <button
            onClick={() => onChange(pairs.filter((_, x) => x !== i))}
            disabled={disabled || pairs.length <= 2}
            title={pairs.length <= 2 ? "A match item needs at least two pairs" : "Remove pair"}
            className="shrink-0 rounded-md border border-border px-2 py-1 text-xs disabled:opacity-40"
          >
            Remove
          </button>
        </div>
      ))}
      <button
        onClick={() =>
          onChange([...pairs, { id: nextPairId(pairs), left: "", right: "" }])
        }
        disabled={disabled}
        className="rounded-md border border-border px-2 py-1 text-xs disabled:opacity-40"
      >
        Add pair
      </button>
    </div>
  );
}

const INPUT = "w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm";
const SMALL = "shrink-0 rounded-md border border-border px-2 py-1 text-xs disabled:opacity-40 aria-pressed:bg-accent";

function RepairablePairs({ pairs, onChange, disabled }: Omit<Props, "repairable">) {
  // The row whose right was picked by Swap, waiting for "Swap with this".
  const [picked, setPicked] = useState<number | null>(null);
  const [message, setMessage] = useState("");
  const update = (idx: number, patch: Partial<MatchPair>) =>
    onChange(pairs.map((p, i) => (i === idx ? { ...p, ...patch } : p)));
  const swap = (a: number, b: number) => {
    setPicked(null);
    if (a === b) return;
    const next = swapMatchRights(pairs, a, b);
    onChange(next);
    setMessage(matchSwapAnnouncement(next, a, b));
  };

  return (
    <div className="space-y-2">
      <div className="text-sm font-medium">
        Pairs{" "}
        <span className="font-normal text-muted-foreground">
          (each left matches its own right; students see the rights shuffled. To re-pair, drag a right onto another
          row, or press Swap on one and Swap with this on the other.)
        </span>
      </div>
      <SortableRows
        ids={pairs.map((p) => p.id)}
        onMove={swap}
        swap
        describe={(id) => `The right in row ${pairs.findIndex((p) => p.id === id) + 1}`}
        disabled={disabled}
      >
        {(_id, i, drag) => {
          const p = pairs[i]!;
          const row = i + 1;
          return (
            <div key={p.id} className="flex items-center gap-2">
              <input
                value={p.left}
                placeholder="Left (prompt)"
                aria-label={`Left ${row}`}
                disabled={disabled}
                onChange={(e) => update(i, { left: e.target.value })}
                className={INPUT}
              />
              <span aria-hidden className="text-muted-foreground">
                ↔
              </span>
              <div
                ref={drag.setNodeRef}
                style={drag.style}
                className={`flex w-full items-center gap-1 ${drag.isDragging ? "rounded-md bg-card shadow" : ""}`}
              >
                <button
                  type="button"
                  className="cursor-grab rounded p-0.5 text-muted-foreground hover:bg-accent disabled:cursor-default disabled:opacity-40"
                  aria-label={`Drag the right in row ${row}`}
                  disabled={disabled}
                  {...drag.handleProps}
                >
                  <GripVertical className="size-4" aria-hidden />
                </button>
                <input
                  value={p.right}
                  placeholder="Right (match)"
                  aria-label={`Right ${row}`}
                  disabled={disabled}
                  onChange={(e) => update(i, { right: e.target.value })}
                  className={INPUT}
                />
              </div>
              <button
                type="button"
                className={SMALL}
                disabled={disabled || pairs.length < 2}
                aria-pressed={picked === i}
                aria-label={
                  picked === null
                    ? `Swap the right in row ${row}`
                    : picked === i
                      ? `Cancel swapping the right in row ${row}`
                      : `Swap with the right in row ${row}`
                }
                onClick={() => (picked === null ? setPicked(i) : swap(picked, i))}
              >
                {picked === null ? "Swap" : picked === i ? "Cancel" : "Swap with this"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setPicked(null);
                  onChange(pairs.filter((_, x) => x !== i));
                }}
                disabled={disabled || pairs.length <= 2}
                title={pairs.length <= 2 ? "A match item needs at least two pairs" : "Remove pair"}
                className={SMALL}
              >
                Remove
              </button>
            </div>
          );
        }}
      </SortableRows>
      <MoveAnnouncer message={message} />
      <button
        type="button"
        onClick={() => onChange([...pairs, { id: nextPairId(pairs), left: "", right: "" }])}
        disabled={disabled}
        className={SMALL}
      >
        Add pair
      </button>
    </div>
  );
}

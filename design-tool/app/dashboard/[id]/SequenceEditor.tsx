"use client";

import { useState } from "react";
import { GripVertical } from "lucide-react";
import type { SequenceEntry } from "@secure-test/schema";
import { stepMoveAnnouncement } from "@/lib/authoring/keyOrder";
import { moveInList } from "@/lib/authoring/outline";
import { MoveAnnouncer, SortableRows } from "./SortableRows";

// Slice 48: sequence editor for order items. The teacher authors entries
// in the CORRECT order — that order IS the answer key; the preview (and
// later the student client) displays entries deterministically shuffled.
// Minimum two entries (server-enforced); ids generated here, never shown.

interface Props {
  sequence: SequenceEntry[];
  onChange: (sequence: SequenceEntry[]) => void;
  disabled: boolean;
  /**
   * R-7 (Phase 4 slice C), the new editor only: steps also drag by a handle,
   * Move up / Move down are labelled, and every move is announced.
   */
  draggable?: boolean;
}

function nextEntryId(sequence: SequenceEntry[]): string {
  const ids = new Set(sequence.map((e) => e.id));
  let n = sequence.length + 1;
  while (ids.has(`s${n}`)) n += 1;
  return `s${n}`;
}

export function SequenceEditor({ sequence, onChange, disabled, draggable = false }: Props) {
  if (draggable) return <DraggableSteps sequence={sequence} onChange={onChange} disabled={disabled} />;
  const update = (idx: number, label: string) =>
    onChange(sequence.map((e, i) => (i === idx ? { ...e, label } : e)));

  const move = (idx: number, dir: -1 | 1) => {
    const next = sequence.slice();
    const [entry] = next.splice(idx, 1);
    next.splice(idx + dir, 0, entry!);
    onChange(next);
  };

  return (
    <div className="space-y-2">
      <div className="text-sm font-medium">
        Sequence{" "}
        <span className="font-normal text-muted-foreground">
          (author in the correct order — students see the entries shuffled)
        </span>
      </div>
      {sequence.map((e, i) => (
        <div key={e.id} className="flex items-center gap-2">
          <span className="w-5 shrink-0 text-right text-xs text-muted-foreground">
            {i + 1}.
          </span>
          <input
            value={e.label}
            placeholder="Step"
            disabled={disabled}
            onChange={(ev) => update(i, ev.target.value)}
            className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm"
          />
          <button
            onClick={() => move(i, -1)}
            disabled={disabled || i === 0}
            title="Move up"
            className="shrink-0 rounded-md border border-border px-2 py-1 text-xs disabled:opacity-40"
          >
            ↑
          </button>
          <button
            onClick={() => move(i, 1)}
            disabled={disabled || i === sequence.length - 1}
            title="Move down"
            className="shrink-0 rounded-md border border-border px-2 py-1 text-xs disabled:opacity-40"
          >
            ↓
          </button>
          <button
            onClick={() => onChange(sequence.filter((_, x) => x !== i))}
            disabled={disabled || sequence.length <= 2}
            title={sequence.length <= 2 ? "An order item needs at least two entries" : "Remove entry"}
            className="shrink-0 rounded-md border border-border px-2 py-1 text-xs disabled:opacity-40"
          >
            Remove
          </button>
        </div>
      ))}
      <button
        onClick={() =>
          onChange([...sequence, { id: nextEntryId(sequence), label: "" }])
        }
        disabled={disabled}
        className="rounded-md border border-border px-2 py-1 text-xs disabled:opacity-40"
      >
        Add entry
      </button>
    </div>
  );
}

const SMALL = "shrink-0 rounded-md border border-border px-2 py-1 text-xs disabled:opacity-40";

function DraggableSteps({ sequence, onChange, disabled }: Omit<Props, "draggable">) {
  const [message, setMessage] = useState("");
  const update = (idx: number, label: string) =>
    onChange(sequence.map((e, i) => (i === idx ? { ...e, label } : e)));
  // Ids stay with their text, so the key is the new order.
  const move = (from: number, to: number) => {
    if (to < 0 || to >= sequence.length || from === to) return;
    onChange(moveInList(sequence, from, to));
    setMessage(stepMoveAnnouncement(from, to, sequence.length));
  };

  return (
    <div className="space-y-2">
      <div className="text-sm font-medium">
        Sequence{" "}
        <span className="font-normal text-muted-foreground">
          (author in the correct order — students see the entries shuffled. Drag a step, or use its arrows.)
        </span>
      </div>
      <SortableRows
        ids={sequence.map((e) => e.id)}
        onMove={move}
        describe={(id) => `Step ${sequence.findIndex((e) => e.id === id) + 1}`}
        disabled={disabled}
      >
        {(_id, i, drag) => {
          const e = sequence[i]!;
          const n = i + 1;
          return (
            <div
              key={e.id}
              ref={drag.setNodeRef}
              style={drag.style}
              className={`flex items-center gap-2 ${drag.isDragging ? "rounded-md bg-card shadow" : ""}`}
            >
              <button
                type="button"
                className="cursor-grab rounded p-0.5 text-muted-foreground hover:bg-accent disabled:cursor-default disabled:opacity-40"
                aria-label={`Drag step ${n}`}
                disabled={disabled}
                {...drag.handleProps}
              >
                <GripVertical className="size-4" aria-hidden />
              </button>
              <span className="w-5 shrink-0 text-right text-xs text-muted-foreground">{n}.</span>
              <input
                value={e.label}
                placeholder="Step"
                aria-label={`Step ${n}`}
                disabled={disabled}
                onChange={(ev) => update(i, ev.target.value)}
                className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm"
              />
              <button
                type="button"
                onClick={() => move(i, i - 1)}
                disabled={disabled || i === 0}
                aria-label={`Move step ${n} up`}
                title="Move up"
                className={SMALL}
              >
                ↑
              </button>
              <button
                type="button"
                onClick={() => move(i, i + 1)}
                disabled={disabled || i === sequence.length - 1}
                aria-label={`Move step ${n} down`}
                title="Move down"
                className={SMALL}
              >
                ↓
              </button>
              <button
                type="button"
                onClick={() => onChange(sequence.filter((_, x) => x !== i))}
                disabled={disabled || sequence.length <= 2}
                title={sequence.length <= 2 ? "An order item needs at least two entries" : "Remove entry"}
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
        onClick={() => onChange([...sequence, { id: nextEntryId(sequence), label: "" }])}
        disabled={disabled}
        className={SMALL}
      >
        Add entry
      </button>
    </div>
  );
}

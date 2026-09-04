"use client";

import type { SequenceEntry } from "@secure-test/schema";

// Slice 48: sequence editor for order items. The teacher authors entries
// in the CORRECT order — that order IS the answer key; the preview (and
// later the student client) displays entries deterministically shuffled.
// Minimum two entries (server-enforced); ids generated here, never shown.

interface Props {
  sequence: SequenceEntry[];
  onChange: (sequence: SequenceEntry[]) => void;
  disabled: boolean;
}

function nextEntryId(sequence: SequenceEntry[]): string {
  const ids = new Set(sequence.map((e) => e.id));
  let n = sequence.length + 1;
  while (ids.has(`s${n}`)) n += 1;
  return `s${n}`;
}

export function SequenceEditor({ sequence, onChange, disabled }: Props) {
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

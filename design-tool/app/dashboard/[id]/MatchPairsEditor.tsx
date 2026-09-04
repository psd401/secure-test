"use client";

import type { MatchPair } from "@secure-test/schema";

// Slice 47: pair-list editor for match items. Pairs are plain strings v1.
// The left/right of one row belong together — that IS the answer key; the
// preview (and later the student client) displays rights out of authored
// order so the layout doesn't give matches away. Minimum two pairs
// (server-enforced); ids are generated here and never shown to teachers.

interface Props {
  pairs: MatchPair[];
  onChange: (pairs: MatchPair[]) => void;
  disabled: boolean;
}

function nextPairId(pairs: MatchPair[]): string {
  const ids = new Set(pairs.map((p) => p.id));
  let n = pairs.length + 1;
  while (ids.has(`p${n}`)) n += 1;
  return `p${n}`;
}

export function MatchPairsEditor({ pairs, onChange, disabled }: Props) {
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

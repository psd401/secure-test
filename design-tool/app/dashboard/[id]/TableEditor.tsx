"use client";

import type { TableCellKeys, TableColumn, TableRow } from "@secure-test/schema";
import { MathPreview } from "./MathPreview";

// E3 slice 2 (docs/e3-table-item-design.md): the grid editor for a table
// item. Column headings and row labels are lists like match pairs; the key
// grid below them holds the expected text per cell — leave a cell blank to
// accept anything there (an unkeyed cell is never counted, D-2). Ids are
// generated here and never shown to teachers. Labels take KaTeX and the
// **bold** / _italic_ markers like a stem; the preview under each list
// shows how they read.

interface Props {
  columns: TableColumn[];
  rows: TableRow[];
  corner: string | null;
  cellKeys: TableCellKeys | null;
  onChange: (patch: {
    columns?: TableColumn[];
    rows?: TableRow[];
    corner?: string | null;
    cell_keys?: TableCellKeys | null;
  }) => void;
  disabled: boolean;
}

export const MAX_TABLE_COLUMNS = 8;
export const MAX_TABLE_ROWS = 30;

function nextId(prefix: string, taken: { id: string }[]): string {
  const ids = new Set(taken.map((t) => t.id));
  let n = taken.length + 1;
  while (ids.has(`${prefix}${n}`)) n += 1;
  return `${prefix}${n}`;
}

/** Drop keys that name a row or column that no longer exists, and empty rows. */
function pruneKeys(
  keys: TableCellKeys | null,
  columns: TableColumn[],
  rows: TableRow[],
): TableCellKeys | null {
  if (!keys) return null;
  const colIds = new Set(columns.map((c) => c.id));
  const rowIds = new Set(rows.map((r) => r.id));
  const out: TableCellKeys = {};
  for (const [rowId, cells] of Object.entries(keys)) {
    if (!rowIds.has(rowId)) continue;
    const kept: Record<string, string> = {};
    for (const [colId, text] of Object.entries(cells)) {
      if (colIds.has(colId) && text.length > 0) kept[colId] = text;
    }
    if (Object.keys(kept).length > 0) out[rowId] = kept;
  }
  return Object.keys(out).length > 0 ? out : null;
}

const INPUT = "w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm";
const SMALL_BUTTON = "shrink-0 rounded-md border border-border px-2 py-1 text-xs disabled:opacity-40";

export function TableEditor({ columns, rows, corner, cellKeys, onChange, disabled }: Props) {
  const showLabels = rows.some((r) => r.label.trim().length > 0);
  const keyedCells = cellKeys
    ? Object.values(cellKeys).reduce((n, cells) => n + Object.keys(cells).length, 0)
    : 0;

  function setColumns(next: TableColumn[]) {
    onChange({ columns: next, cell_keys: pruneKeys(cellKeys, next, rows) });
  }
  function setRows(next: TableRow[]) {
    onChange({ rows: next, cell_keys: pruneKeys(cellKeys, columns, next) });
  }
  function setKey(rowId: string, colId: string, text: string) {
    const next: TableCellKeys = { ...(cellKeys ?? {}) };
    next[rowId] = { ...(next[rowId] ?? {}) };
    if (text.length > 0) next[rowId]![colId] = text;
    else delete next[rowId]![colId];
    onChange({ cell_keys: pruneKeys(next, columns, rows) });
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <div className="text-sm font-medium">
          Column headings{" "}
          <span className="font-normal text-muted-foreground">
            (the header row; up to {MAX_TABLE_COLUMNS})
          </span>
        </div>
        {columns.map((c, i) => (
          <div key={c.id}>
            <div className="flex items-center gap-2">
              <input
                value={c.label}
                placeholder={`Column ${i + 1}`}
                disabled={disabled}
                aria-label={`Column ${i + 1} heading`}
                onChange={(e) =>
                  setColumns(columns.map((x, k) => (k === i ? { ...x, label: e.target.value } : x)))
                }
                className={INPUT}
              />
              <button
                type="button"
                onClick={() => setColumns(columns.filter((_, k) => k !== i))}
                disabled={disabled || columns.length <= 1}
                title={columns.length <= 1 ? "A table needs at least one column" : "Remove column"}
                className={SMALL_BUTTON}
              >
                Remove
              </button>
            </div>
            <MathPreview text={c.label} />
          </div>
        ))}
        <button
          type="button"
          onClick={() => setColumns([...columns, { id: nextId("c", columns), label: "" }])}
          disabled={disabled || columns.length >= MAX_TABLE_COLUMNS}
          className={SMALL_BUTTON}
        >
          Add column
        </button>
      </div>

      <div className="space-y-2">
        <div className="text-sm font-medium">
          Row labels{" "}
          <span className="font-normal text-muted-foreground">
            (the first column; leave every label blank for a table of empty rows; up to {MAX_TABLE_ROWS})
          </span>
        </div>
        {rows.map((r, i) => (
          <div key={r.id}>
            <div className="flex items-center gap-2">
              <input
                value={r.label}
                placeholder={`Row ${i + 1} (optional)`}
                disabled={disabled}
                aria-label={`Row ${i + 1} label`}
                onChange={(e) =>
                  setRows(rows.map((x, k) => (k === i ? { ...x, label: e.target.value } : x)))
                }
                className={INPUT}
              />
              <button
                type="button"
                onClick={() => setRows(rows.filter((_, k) => k !== i))}
                disabled={disabled || rows.length <= 1}
                title={rows.length <= 1 ? "A table needs at least one row" : "Remove row"}
                className={SMALL_BUTTON}
              >
                Remove
              </button>
            </div>
            <MathPreview text={r.label} />
          </div>
        ))}
        <button
          type="button"
          onClick={() => setRows([...rows, { id: nextId("r", rows), label: "" }])}
          disabled={disabled || rows.length >= MAX_TABLE_ROWS}
          className={SMALL_BUTTON}
        >
          Add row
        </button>
      </div>

      {showLabels ? (
        <label className="block">
          <span className="block text-sm font-medium">
            Corner caption{" "}
            <span className="font-normal text-muted-foreground">
              (optional — heads the row-label column, e.g. &ldquo;Chamber position&rdquo;)
            </span>
          </span>
          <input
            value={corner ?? ""}
            disabled={disabled}
            onChange={(e) => onChange({ corner: e.target.value.length > 0 ? e.target.value : null })}
            className={`mt-1 ${INPUT}`}
          />
        </label>
      ) : null}

      <div>
        <div className="text-sm font-medium">
          Expected answers{" "}
          <span className="font-normal text-muted-foreground">
            (optional — leave a cell blank to accept anything there; {keyedCells === 0
              ? "no cells are checked yet, so this table is hand-scored until you fill some in"
              : `${keyedCells} cell${keyedCells === 1 ? "" : "s"} checked, one point each`})
          </span>
        </div>
        <div className="mt-2 overflow-x-auto">
          <table className="min-w-max border-collapse text-sm">
            <thead>
              <tr>
                {showLabels ? (
                  <th className="border border-border bg-muted px-2 py-1 text-left font-medium">
                    {corner ?? ""}
                  </th>
                ) : null}
                {columns.map((c, ci) => (
                  <th key={c.id} className="border border-border bg-muted px-2 py-1 text-left font-medium">
                    {c.label || <span className="text-muted-foreground">Column {ci + 1}</span>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={r.id}>
                  {showLabels ? (
                    <th className="border border-border bg-muted px-2 py-1 text-left font-medium">
                      {r.label}
                    </th>
                  ) : null}
                  {columns.map((c, ci) => (
                    <td key={c.id} className="border border-border p-1">
                      <input
                        value={cellKeys?.[r.id]?.[c.id] ?? ""}
                        disabled={disabled}
                        aria-label={`Expected answer, row ${ri + 1}, column ${ci + 1}`}
                        placeholder="any"
                        onChange={(e) => setKey(r.id, c.id, e.target.value)}
                        className="w-28 rounded border border-transparent bg-transparent px-2 py-1 text-sm focus:border-border"
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          A number matches any way of writing it (1.5 = 1.50); text matches ignoring case
          and spacing, and a formula matches its plain form (H_2O = H2O).
        </p>
      </div>
    </div>
  );
}

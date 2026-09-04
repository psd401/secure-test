"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { Rubric, TableCellKeys, TableColumn, TableRow } from "@secure-test/schema";
import { tableCellMatches } from "@/lib/scoring/auto";

// Slice 39: client panel for the review queue. Two groups fall out of the
// API's `proposed` field: AI proposals awaiting approve/override, and
// responses needing a first manual score. Rubric items are scored by
// clicking one level per criterion (auto-summed); non-rubric items take
// bare points. Everything posts to the slice-39 action routes and
// refetches.

interface QueueEntry {
  response_id: string;
  attempt_id: string;
  /** E12 slice 4: what this student saw as the stimulus, when it was their own earlier answer. */
  outline?: { origin: "source" | "inline" | "missing"; words: number } | null;
  student: { name: string; ssid: string };
  item: {
    id: string;
    position: number;
    type: string;
    stem: string;
    stem_html: string;
    scoring_method: string;
    rubric: Rubric | null;
    /** E3 slice 2: the denominator the manual score route accepts (rubric max, a table's cells, else 1). */
    max_points: number;
    /** E3 slice 2: the grid + keys for a table item; null for every other type. */
    table: {
      columns: TableColumn[];
      rows: TableRow[];
      corner: string | null;
      cell_keys: TableCellKeys | null;
    } | null;
  };
  response: {
    type: string;
    text?: string;
    choice_id?: string;
    choice_ids?: string[];
    matches?: Record<string, string>;
    ordered_ids?: string[];
    region_ids?: string[];
    cells?: Record<string, Record<string, string>>;
    /** Slice 65: a drawing/upload answer — a reference, never the bytes. */
    upload_id?: string;
  };
  proposed: {
    score_id: string;
    points: number;
    max_points: number;
    rationale: {
      overall_rationale?: string;
      confidence?: number;
      criterion_scores?: Array<{
        criterion_id: string;
        level_id: string;
        points: number;
        rationale: string;
      }>;
    } | null;
    scorer: string;
  } | null;
}

interface Props {
  assessmentId: string;
  assessmentName: string;
}

function rubricMax(rubric: Rubric): number {
  return rubric.criteria.reduce(
    (sum, c) => sum + Math.max(...c.levels.map((l) => l.points)),
    0,
  );
}

function responseText(entry: QueueEntry): string {
  const r = entry.response;
  if (typeof r.text === "string") return r.text;
  if (r.choice_id) return `Selected: ${r.choice_id}`;
  if (r.choice_ids) return `Selected: ${r.choice_ids.join(", ")}`;
  // Slice 47: match — pair-id mappings, readable if not pretty.
  if (r.matches) {
    return Object.entries(r.matches)
      .map(([left, right]) => `${left} → ${right}`)
      .join(", ");
  }
  // Slice 48: order — the student's arrangement, first to last.
  if (r.ordered_ids) return `Order: ${r.ordered_ids.join(" → ")}`;
  // Slice 49: hotspot — the marked region id(s).
  if (r.region_ids) return `Marked regions: ${r.region_ids.join(", ")}`;
  // E3: a table renders as a grid (tableGrid); this is the fallback text.
  if (r.cells) {
    return Object.entries(r.cells)
      .map(([row, cols]) => `${row}: ${Object.entries(cols).map(([c, v]) => `${c}=${v}`).join(", ")}`)
      .join("; ");
  }
  return JSON.stringify(r);
}

// E3 slice 2: the student's cells laid out as the grid they filled, with
// the expected text and a ✓ / ✗ under each keyed cell (same rule the auto
// scorer applies, so the hand-scorer sees what "auto" would have said) and
// a running "n of m keyed cells match" line. Teacher-only surface.
function tableGrid(entry: QueueEntry) {
  const table = entry.item.table;
  if (!table) return null;
  const cells = entry.response.cells ?? {};
  const keys = table.cell_keys ?? {};
  const showLabels = table.rows.some((r) => r.label.trim().length > 0);
  let keyed = 0;
  let matched = 0;
  for (const [rowId, cols] of Object.entries(keys)) {
    for (const [colId, key] of Object.entries(cols)) {
      keyed++;
      if (tableCellMatches(cells[rowId]?.[colId] ?? "", key)) matched++;
    }
  }
  const th = "border border-border bg-muted px-2 py-1 text-left text-xs font-medium";
  return (
    <div className="mt-2 overflow-x-auto">
      <table className="min-w-max border-collapse text-sm">
        <thead>
          <tr>
            {showLabels ? <th className={th}>{table.corner ?? ""}</th> : null}
            {table.columns.map((c) => (
              <th key={c.id} className={th}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((r) => (
            <tr key={r.id}>
              {showLabels ? <th className={th}>{r.label}</th> : null}
              {table.columns.map((c) => {
                const answer = cells[r.id]?.[c.id];
                const key = keys[r.id]?.[c.id];
                const ok = key !== undefined ? tableCellMatches(answer ?? "", key) : null;
                return (
                  <td key={c.id} className="border border-border px-2 py-1 align-top">
                    <div>{answer !== undefined && answer !== "" ? answer : <span className="text-muted-foreground">—</span>}</div>
                    {key !== undefined ? (
                      <div className={`text-xs ${ok ? "text-green-700" : "text-destructive"}`}>
                        {ok ? "✓" : "✗"} expected {key}
                      </div>
                    ) : null}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {keyed > 0 ? (
        <p className="mt-1 text-xs text-muted-foreground">
          {matched} of {keyed} keyed cell{keyed === 1 ? "" : "s"} match the expected answers.
        </p>
      ) : null}
    </div>
  );
}

export function ScoringQueue({ assessmentId, assessmentName }: Props) {
  const [entries, setEntries] = useState<QueueEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Per-response rubric level picks: response_id -> criterion_id -> level_id
  const [picks, setPicks] = useState<Record<string, Record<string, string>>>({});
  // Per-response bare points for non-rubric items.
  const [rawPoints, setRawPoints] = useState<Record<string, string>>({});

  const refetch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/assessments/${assessmentId}/review-queue`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { entries: QueueEntry[] };
      setEntries(body.entries);
    } catch (e) {
      setError(`load queue: ${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, [assessmentId]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  async function act(run: () => Promise<Response>) {
    setBusy(true);
    setError(null);
    try {
      const res = await run();
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: string;
          detail?: string;
        } | null;
        throw new Error(body?.detail ?? body?.error ?? `HTTP ${res.status}`);
      }
      await refetch();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function approve(scoreId: string) {
    void act(() => fetch(`/api/scores/${scoreId}/approve`, { method: "POST" }));
  }

  function rerunAi(responseId: string) {
    void act(() =>
      fetch(`/api/responses/${responseId}/rescore-ai`, { method: "POST" }),
    );
  }

  function saveRubricScore(entry: QueueEntry) {
    const rubric = entry.item.rubric;
    if (!rubric) return;
    const selection = picks[entry.response_id] ?? {};
    const criterion_scores = rubric.criteria.map((c) => {
      const levelId = selection[c.id];
      const level = c.levels.find((l) => l.id === levelId);
      if (!level) throw new Error("incomplete selection");
      return {
        criterion_id: c.id,
        level_id: level.id,
        points: level.points,
        rationale: "",
      };
    });
    const points = criterion_scores.reduce((s, c) => s + c.points, 0);
    void act(() =>
      fetch(`/api/responses/${entry.response_id}/score`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          points,
          max_points: rubricMax(rubric),
          criterion_scores,
        }),
      }),
    );
  }

  function saveRawScore(entry: QueueEntry) {
    // Review fix (2026-08-14): a typed-then-cleared field is "" and
    // Number("") === 0 — which would submit an IRREVERSIBLE final 0 (there
    // is no un-finalize route). An empty field is "no value", never 0.
    const raw = (rawPoints[entry.response_id] ?? "").trim();
    if (raw === "") {
      setError("enter a points value before saving");
      return;
    }
    const points = Number(raw);
    // E3 slice 2: the denominator comes from the server (a table is worth its
    // cells; everything else without a rubric is worth 1).
    const max = entry.item.max_points;
    if (!Number.isFinite(points) || points < 0 || points > max) {
      setError(`points must be between 0 and ${max} for this item`);
      return;
    }
    void act(() =>
      fetch(`/api/responses/${entry.response_id}/score`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ points, max_points: max }),
      }),
    );
  }

  const proposals = entries.filter((e) => e.proposed);
  const needsManual = entries.filter((e) => !e.proposed);

  function rubricPicker(entry: QueueEntry) {
    const rubric = entry.item.rubric;
    if (!rubric) return null;
    const selection = picks[entry.response_id] ?? {};
    const complete = rubric.criteria.every((c) => selection[c.id]);
    const total = rubric.criteria.reduce((sum, c) => {
      const level = c.levels.find((l) => l.id === selection[c.id]);
      return sum + (level?.points ?? 0);
    }, 0);
    return (
      <div className="mt-2 space-y-2">
        {rubric.criteria.map((c) => (
          <div key={c.id}>
            <span className="text-xs font-medium">{c.name}</span>
            <div className="mt-1 flex flex-wrap gap-1">
              {c.levels.map((l) => (
                <button
                  key={l.id}
                  disabled={busy}
                  onClick={() =>
                    setPicks((prev) => ({
                      ...prev,
                      [entry.response_id]: {
                        ...(prev[entry.response_id] ?? {}),
                        [c.id]: l.id,
                      },
                    }))
                  }
                  className={`rounded border px-2 py-1 text-xs ${
                    selection[c.id] === l.id
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border hover:bg-accent"
                  }`}
                  title={l.descriptor ?? ""}
                >
                  {l.label} ({l.points})
                </button>
              ))}
            </div>
          </div>
        ))}
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground">
            Total: {total} / {rubricMax(rubric)}
          </span>
          <button
            disabled={busy || !complete}
            onClick={() => saveRubricScore(entry)}
            className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground disabled:opacity-40"
          >
            Save final score
          </button>
        </div>
      </div>
    );
  }

  function entryCard(entry: QueueEntry) {
    return (
      <li
        key={entry.response_id}
        className="rounded-lg border border-border p-4"
      >
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <span className="text-sm font-medium">
            Q{entry.item.position + 1} · {entry.student.name || entry.student.ssid}
          </span>
          <span className="text-xs text-muted-foreground">
            {entry.item.scoring_method}
          </span>
        </div>
        {/* stem_html is server-rendered by renderItemContent: text is
            HTML-escaped, math is KaTeX, image refs resolve owner-scoped
            or come back as inline-red placeholders — no injection vector. */}
        <p
          className="mt-1 line-clamp-2 text-xs text-muted-foreground"
          dangerouslySetInnerHTML={{ __html: entry.item.stem_html }}
        />
        {entry.outline ? (
          <p className="mt-1 text-xs text-muted-foreground">
            Outline:{" "}
            {entry.outline.origin === "source"
              ? `used (${entry.outline.words} words)`
              : entry.outline.origin === "inline"
                ? `written inline (${entry.outline.words} words)`
                : "missing"}
          </p>
        ) : null}
        {entry.response.type === "drawing_upload" ? (
          // F-1 (docs/reporting-design.md R0.2): the bytes live behind an
          // owner-scoped route, never inline in the queue payload.
          <img
            src={`/api/responses/${entry.response_id}/upload`}
            alt="Student drawing"
            className="mt-2 max-h-48 max-w-full rounded border border-border object-contain"
          />
        ) : entry.item.table ? (
          tableGrid(entry)
        ) : (
          <blockquote className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap rounded bg-muted p-2 text-sm">
            {responseText(entry)}
          </blockquote>
        )}

        {entry.proposed ? (
          <div className="mt-3 rounded border border-border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm">
                AI proposes <strong>{entry.proposed.points}</strong> /{" "}
                {entry.proposed.max_points}
                {entry.proposed.rationale?.confidence != null
                  ? ` · confidence ${entry.proposed.rationale.confidence}`
                  : ""}
              </span>
              <div className="flex gap-2">
                <button
                  disabled={busy}
                  onClick={() => approve(entry.proposed!.score_id)}
                  className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground disabled:opacity-40"
                >
                  Approve
                </button>
                <button
                  disabled={busy}
                  onClick={() => rerunAi(entry.response_id)}
                  className="rounded-md border border-border px-3 py-1 text-xs disabled:opacity-40"
                >
                  Re-run AI
                </button>
              </div>
            </div>
            {entry.proposed.rationale?.overall_rationale ? (
              <p className="mt-2 text-xs text-muted-foreground">
                {entry.proposed.rationale.overall_rationale}
              </p>
            ) : null}
            <details className="mt-2">
              <summary className="cursor-pointer text-xs underline">
                Override with my own score
              </summary>
              {entry.item.rubric ? (
                rubricPicker(entry)
              ) : (
                <p className="mt-1 text-xs">No rubric on this item.</p>
              )}
            </details>
          </div>
        ) : entry.item.rubric ? (
          rubricPicker(entry)
        ) : (
          <div className="mt-2 flex items-center gap-2">
            <label className="text-xs">
              Points (of {entry.item.max_points}):{" "}
              <input
                type="number"
                min={0}
                max={entry.item.max_points}
                step={entry.item.max_points > 1 ? 1 : 0.5}
                value={rawPoints[entry.response_id] ?? ""}
                onChange={(e) =>
                  setRawPoints((prev) => ({
                    ...prev,
                    [entry.response_id]: e.target.value,
                  }))
                }
                className="w-20 rounded-md border border-border bg-transparent px-2 py-1 text-xs"
              />
            </label>
            <button
              disabled={
                busy || (rawPoints[entry.response_id] ?? "").trim() === ""
              }
              onClick={() => saveRawScore(entry)}
              className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground disabled:opacity-40"
            >
              Save final score
            </button>
          </div>
        )}
      </li>
    );
  }

  return (
    <div className="space-y-8">
      <div>
        <Link
          href={`/dashboard/${assessmentId}`}
          className="text-sm text-muted-foreground underline"
        >
          ← Back to editor
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">
          Scoring queue — {assessmentName}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Responses awaiting a human. Auto-scored items never appear here;
          approving or saving writes the one final score per response
          (earlier AI proposals are kept as audit trail).
        </p>
      </div>

      {error ? (
        <p className="rounded border border-destructive/40 p-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nothing to review — every response is scored or auto-scorable.
        </p>
      ) : (
        <>
          {proposals.length > 0 ? (
            <section>
              <h2 className="text-lg font-semibold">
                AI proposals to review ({proposals.length})
              </h2>
              <ul className="mt-3 space-y-3">{proposals.map(entryCard)}</ul>
            </section>
          ) : null}
          {needsManual.length > 0 ? (
            <section>
              <h2 className="text-lg font-semibold">
                Needs manual scoring ({needsManual.length})
              </h2>
              <ul className="mt-3 space-y-3">{needsManual.map(entryCard)}</ul>
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}

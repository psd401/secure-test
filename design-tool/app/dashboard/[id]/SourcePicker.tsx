"use client";

import { useEffect, useState } from "react";

// E12 slice 4 (docs/e12-per-student-stimulus-design.md): pick the question
// in another of the owner's assessments whose saved answer each student
// sees as this stimulus. Two selects — assessment, then an essay / short-
// text question in it — and Use. The server re-checks ownership and type
// on PATCH; this component only narrows the choice to what can pass.

export interface SourceSummary {
  item_id: string;
  stem: string;
  assessment_id: string;
  assessment_name: string;
  assessment_status: string;
}

interface AssessmentRow {
  id: string;
  name: string;
  status: string;
}

interface ItemRow {
  id: string;
  type: string;
  stem: string;
  position: number;
}

const SOURCE_TYPES = new Set(["essay", "short_text"]);

interface Props {
  /** This assessment — excluded from the list; a source lives elsewhere. */
  assessmentId: string;
  disabled?: boolean;
  onPicked: (source: SourceSummary) => Promise<void> | void;
  onCancel: () => void;
}

export function SourcePicker({ assessmentId, disabled, onPicked, onCancel }: Props) {
  const [assessments, setAssessments] = useState<AssessmentRow[] | null>(null);
  const [assessmentId2, setAssessmentId2] = useState("");
  const [items, setItems] = useState<ItemRow[] | null>(null);
  const [itemId, setItemId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/assessments");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { assessments?: AssessmentRow[] } | AssessmentRow[];
        const list = (Array.isArray(body) ? body : (body.assessments ?? [])).filter((a) => a.id !== assessmentId);
        if (!cancelled) setAssessments(list);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [assessmentId]);

  useEffect(() => {
    setItems(null);
    setItemId("");
    if (!assessmentId2) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/assessments/${assessmentId2}/items`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { items: ItemRow[] };
        const usable = body.items.filter((i) => SOURCE_TYPES.has(i.type)).sort((a, b) => a.position - b.position);
        if (!cancelled) setItems(usable);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [assessmentId2]);

  async function use() {
    const a = assessments?.find((x) => x.id === assessmentId2);
    const it = items?.find((x) => x.id === itemId);
    if (!a || !it) return;
    setBusy(true);
    setError(null);
    try {
      await onPicked({
        item_id: it.id,
        stem: it.stem,
        assessment_id: a.id,
        assessment_name: a.name,
        assessment_status: a.status,
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const selectCls = "rounded-md border border-border bg-background px-2 py-1 text-xs";
  return (
    <div className="mt-2 rounded border border-border p-2 text-xs">
      <p className="mb-1 font-medium">Start with each student&apos;s own earlier answer</p>
      {error ? <p className="mb-1 text-destructive">{error}</p> : null}
      <div className="flex flex-wrap items-center gap-2">
        <select
          className={selectCls}
          value={assessmentId2}
          disabled={disabled || busy || assessments === null}
          onChange={(e) => setAssessmentId2(e.target.value)}
          aria-label="Source assessment"
        >
          <option value="">{assessments === null ? "Loading…" : "Choose an assessment"}</option>
          {(assessments ?? []).map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
              {a.status === "published" ? "" : " (draft)"}
            </option>
          ))}
        </select>
        <select
          className={selectCls}
          value={itemId}
          disabled={disabled || busy || !assessmentId2 || items === null}
          onChange={(e) => setItemId(e.target.value)}
          aria-label="Source question"
        >
          <option value="">
            {!assessmentId2 ? "Then a question" : items === null ? "Loading…" : items.length === 0 ? "No essay or short-answer question there" : "Choose a question"}
          </option>
          {(items ?? []).map((i) => (
            <option key={i.id} value={i.id}>
              Q{i.position + 1} · {i.stem.slice(0, 80)}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="rounded border border-border px-2 py-1 disabled:opacity-40"
          disabled={disabled || busy || !itemId}
          onClick={() => void use()}
        >
          {busy ? "Saving…" : "Use this answer"}
        </button>
        <button type="button" className="underline" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
      <p className="mt-1 text-muted-foreground">
        Each student sees their own saved answer to that question here, under the text above. A student with no answer yet writes it in place, above the questions.
      </p>
    </div>
  );
}

"use client";

import { useState } from "react";

// Slice 41: CSV item import with a preview-before-commit step, mirroring
// the TIDE importer's review pattern. Paste or upload a CSV, Preview shows
// the per-row valid/invalid report (no writes), then Commit appends the
// valid rows to the draft assessment.

interface RowReport {
  line: number;
  type: string;
  stem: string;
  valid: boolean;
  errors: string[];
}

interface PreviewState {
  valid_count: number;
  invalid_count: number;
  rows: RowReport[];
}

const TEMPLATE_HEADER =
  "type,stem,choices,correct,scoring_method,max_word_count,placeholder,rubric_json";

interface Props {
  assessmentId: string;
  disabled: boolean;
  onImported: () => void;
}

export function ImportItemsPanel({ assessmentId, disabled, onImported }: Props) {
  const [open, setOpen] = useState(false);
  const [csv, setCsv] = useState("");
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [committedMsg, setCommittedMsg] = useState<string | null>(null);

  const url = `/api/assessments/${assessmentId}/items/import`;

  async function post(commit: boolean) {
    setBusy(true);
    setError(null);
    setCommittedMsg(null);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ csv, commit }),
      });
      const body = (await res.json()) as {
        ok: boolean;
        error?: string;
        detail?: string;
        inserted?: number;
        valid_count?: number;
        invalid_count?: number;
        rows?: RowReport[];
      };
      if (!res.ok || !body.ok) {
        throw new Error(body.detail ?? body.error ?? `HTTP ${res.status}`);
      }
      setPreview({
        valid_count: body.valid_count ?? 0,
        invalid_count: body.invalid_count ?? 0,
        rows: body.rows ?? [],
      });
      if (commit) {
        setCommittedMsg(`Imported ${body.inserted ?? 0} item(s).`);
        onImported();
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function onFile(file: File) {
    setCsv(await file.text());
    setPreview(null);
  }

  return (
    <div className="rounded-lg border border-border">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-4 py-2 text-sm font-medium"
      >
        <span>Import items from CSV</span>
        <span aria-hidden>{open ? "−" : "+"}</span>
      </button>
      {open ? (
        <div className="space-y-3 border-t border-border p-4">
          <p className="text-xs text-muted-foreground">
            One row per question. Header row required. Columns:
          </p>
          <code className="block overflow-x-auto rounded bg-muted p-2 text-xs">
            {TEMPLATE_HEADER}
          </code>
          <p className="text-xs text-muted-foreground">
            MC <em>choices</em>: <code>id:text</code> pairs joined by{" "}
            <code>|</code> (e.g. <code>a:Paris|b:London</code>). MC{" "}
            <em>correct</em>: choice id(s), <code>|</code>-joined for
            multi-select. Short-text <em>correct</em>: the answer. Essay:
            optional <code>rubric_json</code>.
          </p>
          <input
            type="file"
            accept=".csv,text/csv"
            disabled={disabled || busy}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void onFile(f);
            }}
            className="block text-xs"
          />
          <textarea
            value={csv}
            onChange={(e) => {
              setCsv(e.target.value);
              setPreview(null);
            }}
            rows={5}
            placeholder={TEMPLATE_HEADER + "\nshort_text,What is 2+2?,,4,,,,"}
            disabled={disabled || busy}
            className="w-full rounded-md border border-border bg-transparent px-3 py-2 font-mono text-xs"
          />
          <div className="flex items-center gap-2">
            <button
              onClick={() => post(false)}
              disabled={disabled || busy || csv.trim() === ""}
              className="rounded-md border border-border px-3 py-1.5 text-sm disabled:opacity-40"
            >
              Preview
            </button>
            <button
              onClick={() => post(true)}
              disabled={
                disabled || busy || !preview || preview.valid_count === 0
              }
              className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-40"
            >
              {preview
                ? `Commit ${preview.valid_count} valid row(s)`
                : "Commit"}
            </button>
          </div>

          {error ? (
            <p className="rounded border border-destructive/40 p-2 text-xs text-destructive">
              {error}
            </p>
          ) : null}
          {committedMsg ? (
            <p className="text-xs text-success-foreground">
              {committedMsg}
            </p>
          ) : null}

          {preview ? (
            <div className="overflow-x-auto">
              <p className="mb-1 text-xs text-muted-foreground">
                {preview.valid_count} valid · {preview.invalid_count} invalid
              </p>
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left">
                    <th className="pr-2">Line</th>
                    <th className="pr-2">Type</th>
                    <th className="pr-2">Stem</th>
                    <th className="pr-2">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map((r) => (
                    <tr key={r.line} className="align-top">
                      <td className="pr-2">{r.line}</td>
                      <td className="pr-2">{r.type}</td>
                      <td className="max-w-xs truncate pr-2">{r.stem}</td>
                      <td className="pr-2">
                        {r.valid ? (
                          <span className="text-success-foreground">
                            ✓
                          </span>
                        ) : (
                          <span className="text-destructive">
                            {r.errors.join("; ")}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

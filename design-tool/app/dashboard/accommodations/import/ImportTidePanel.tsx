"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { useState } from "react";
import type { ImportTideResult } from "@/lib/api/students";
import { ApiError, tideImportErrorCopy } from "@/lib/ui/errorCopy";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

async function readError(res: Response): Promise<ApiError> {
  let code = `http_${res.status}`;
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === "string") code = body.error;
  } catch {
    // not JSON
  }
  return new ApiError(code, res.status);
}

function Stat({ n, label }: { n: number; label: string }) {
  return (
    <li className="flex items-baseline gap-2">
      <span className="font-heading text-xl font-bold tabular-nums">{n}</span>
      <span className="text-muted-foreground">{label}</span>
    </li>
  );
}

export function ImportTidePanel({ returnTo }: { returnTo: string | null }) {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportTideResult | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) {
      setError("missing_file");
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/accommodations/import", { method: "POST", body: form });
      if (!res.ok) throw await readError(res);
      setResult((await res.json()) as ImportTideResult);
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.code : "network");
    } finally {
      setBusy(false);
    }
  }

  const copy = error ? tideImportErrorCopy(error) : null;
  const unrecognised = result ? result.rows_removal_suppressed + result.students_sweep_skipped : 0;
  const backHref = returnTo ?? "/dashboard/accommodations";
  const backLabel = returnTo ? "Back to the assessment" : "Back to Students";

  return (
    <div className="space-y-6">
      <form onSubmit={submit} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="tide-file">TIDE Student Settings export (.xlsx)</Label>
          <Input
            id="tide-file"
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        </div>
        <div className="flex items-center gap-3">
          <Button type="submit" disabled={busy || !file}>
            {busy ? "Importing…" : "Import"}
          </Button>
          <Button asChild variant="ghost">
            <Link href={backHref}>{backLabel}</Link>
          </Button>
        </div>
      </form>

      {copy ? (
        <Alert variant="destructive">
          <AlertTitle>{copy.message}</AlertTitle>
          {copy.showCode ? (
            <AlertDescription>
              <code className="text-xs">{error}</code>
            </AlertDescription>
          ) : null}
        </Alert>
      ) : null}

      {result ? (
        <Card>
          <CardContent className="space-y-4 text-sm">
            <div className="font-medium">Import complete</div>
            <ul className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
              <Stat n={result.students_added} label="new students" />
              <Stat n={result.students_updated} label="students updated" />
              <Stat n={result.rows_inserted} label="settings added" />
              <Stat n={result.rows_overwritten} label="settings taken from TIDE" />
              <Stat n={result.rows_preserved_with_diff} label="settings you had changed were kept" />
              <Stat n={result.rows_soft_removed} label="settings TIDE no longer lists were turned off" />
              <Stat n={result.rows_dropped} label="rows skipped (tool not recognised)" />
            </ul>

            {/* D12: a row TIDE sent but we couldn't map used to silently revoke
                the student's matching accommodation. It no longer does — but
                the teacher should know those rows were not updated either. */}
            {unrecognised > 0 ? (
              <Alert variant="warning">
                <AlertTitle>
                  TIDE sent {unrecognised} setting{unrecognised === 1 ? "" : "s"} this tool doesn&apos;t recognise yet.
                </AlertTitle>
                <AlertDescription>
                  Nothing was removed — the matching settings were left as they were, but they were not
                  updated either. Let Research &amp; Assessment know so the catalog can be extended.
                </AlertDescription>
              </Alert>
            ) : null}

            {result.diffs.length > 0 ? (
              <Alert variant="warning">
                <AlertTitle>
                  {result.diffs.length} change{result.diffs.length === 1 ? "" : "s"} to review
                </AlertTitle>
                <AlertDescription>
                  <p>TIDE now says something different from a setting you had changed. Your value stays in effect until you decide.</p>
                  <Button asChild size="sm" className="mt-2">
                    <Link href="/dashboard/accommodations/import/review">Review changes</Link>
                  </Button>
                </AlertDescription>
              </Alert>
            ) : null}

            <Button asChild variant="outline" size="sm">
              <Link href={backHref}>{backLabel}</Link>
            </Button>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

"use client";

import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import type { BundleAsset } from "@secure-test/schema";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { FilePicker } from "@/components/app/FilePicker";
import { Label } from "@/components/ui/label";
import { SubmitButton } from "@/components/app/SubmitButton";
import type { ImportPreview } from "@/lib/api/importPreview";
import { ITEM_TYPE_LABEL } from "@/lib/items/typeLabel";
import { importErrorCopy } from "@/lib/ui/errorCopy";
import { picturesFromFile, previewErrorCode } from "@/lib/preview/importFile";
import { InteractivePreview } from "../[id]/InteractivePreview";
import { rowToView, type ItemSetView } from "../[id]/editorModel";
import { useImportAction } from "./useImportAction";

const CALCULATOR_LABEL: Record<ImportPreview["calculator_mode"], string> = {
  none: "No calculator",
  four_function: "Four-function calculator",
  scientific: "Scientific calculator",
  graphing: "Graphing calculator",
};

type State =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; code: string }
  | { kind: "ready"; preview: ImportPreview; pictures: Record<string, BundleAsset> };

/**
 * Editor redesign Phase 7 slice C (R-9, D-6), behind the R-12 flag: choosing
 * the file shows what the import WILL create — the name, counts by type,
 * settings, warnings, and the questions in the student's own renderer
 * (Phase 5's sandboxed preview) — and nothing is written until Create. Create
 * posts the same file to the import route through the same action as the
 * flag-off form (useImportAction), so the import itself is unchanged.
 */
export function ImportPreviewFlow() {
  const action = useImportAction();
  const [state, setState] = useState<State>({ kind: "idle" });
  const request = useRef(0);

  async function onFile(file: File | null) {
    const n = ++request.current;
    if (!file) {
      setState({ kind: "idle" });
      return;
    }
    setState({ kind: "loading" });
    try {
      const body = new FormData();
      body.set("file", file);
      const res = await fetch("/api/assessments/import/preview", { method: "POST", body });
      const json = (await res.json().catch(() => null)) as { ok?: boolean; preview?: ImportPreview } | null;
      if (n !== request.current) return;
      if (!res.ok || !json?.ok || !json.preview) {
        setState({ kind: "error", code: previewErrorCode(json) });
        return;
      }
      let pictures: Record<string, BundleAsset> = {};
      try {
        pictures = picturesFromFile(JSON.parse(await file.text()));
      } catch {
        // The server parsed it; a browser that cannot just shows no pictures.
      }
      if (n !== request.current) return;
      setState({ kind: "ready", preview: json.preview, pictures });
    } catch {
      if (n === request.current) setState({ kind: "error", code: "read_failed" });
    }
  }

  const preview = state.kind === "ready" ? state.preview : null;
  const views = useMemo(() => (preview ? preview.items.map(rowToView) : []), [preview]);
  const sets = useMemo<ItemSetView[]>(() => preview?.sets ?? [], [preview]);
  const assessment = useMemo(
    () =>
      preview
        ? {
            id: "import-preview",
            name: preview.name,
            calculator_mode: preview.calculator_mode,
            calculator_preset: preview.calculator_preset,
            allow_highlighting: preview.allow_highlighting,
            student_layout: preview.student_layout,
          }
        : null,
    [preview],
  );
  const canCreate = preview !== null && preview.error === null;
  const errorCopy = state.kind === "error" ? importErrorCopy(state.code) : preview?.error ? importErrorCopy(preview.error) : null;
  const errorCode = state.kind === "error" ? state.code : (preview?.error ?? null);

  return (
    <div className="mt-8 grid gap-8 xl:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
      <div className="space-y-6">
        <form action={action} className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="file">Assessment file (.json)</Label>
            <FilePicker
              id="file"
              name="file"
              accept="application/json,.json"
              label="Choose the .json file…"
              required
              onFile={(f) => void onFile(f)}
            />
            <p className="text-xs text-muted-foreground">
              You&apos;ll see what the file contains before anything is created.
            </p>
          </div>

          {state.kind === "loading" ? (
            <p className="flex items-center text-sm text-muted-foreground" role="status">
              <Loader2 className="mr-2 size-4 animate-spin" aria-hidden />
              Reading the file…
            </p>
          ) : null}

          {errorCopy ? (
            <Alert variant="destructive">
              <AlertTitle>{errorCopy.message}</AlertTitle>
              {errorCopy.showCode && errorCode ? (
                <AlertDescription>
                  <code className="text-xs break-all">{errorCode}</code>
                </AlertDescription>
              ) : null}
            </Alert>
          ) : null}

          {preview ? (
            <section aria-labelledby="import-summary" className="space-y-4 rounded-md border bg-card p-4 text-sm">
              <h2 id="import-summary" className="text-base font-semibold">
                What will be created
              </h2>
              <p>
                A new draft assessment, <span className="font-medium">{preview.name}</span>, with{" "}
                {preview.item_count === 1 ? "1 question" : `${preview.item_count} questions`}.
              </p>
              {preview.type_counts.length > 0 ? (
                <table className="w-full text-left">
                  <caption className="sr-only">Questions by type</caption>
                  <thead className="text-xs text-muted-foreground">
                    <tr>
                      <th scope="col" className="py-1 font-normal">
                        Type
                      </th>
                      <th scope="col" className="py-1 text-right font-normal">
                        Questions
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.type_counts.map((t) => (
                      <tr key={t.type} className="border-t">
                        <td className="py-1">{ITEM_TYPE_LABEL[t.type]}</td>
                        <td className="py-1 text-right tabular-nums">{t.count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : null}
              <ul className="space-y-0.5 text-muted-foreground">
                {preview.set_count > 0 ? (
                  <li>{preview.set_count === 1 ? "1 passage or stimulus" : `${preview.set_count} passages or stimuli`}</li>
                ) : null}
                <li>{preview.picture_count === 1 ? "1 picture" : `${preview.picture_count} pictures`}</li>
                <li>{preview.student_layout === "paged" ? "One question per page" : "All questions on one page"}</li>
                <li>{CALCULATOR_LABEL[preview.calculator_mode]}</li>
                <li>
                  {preview.accommodation_count === 1
                    ? "1 accommodation allowed"
                    : `${preview.accommodation_count} accommodations allowed`}
                </li>
              </ul>
              {preview.warnings.length > 0 ? (
                <Alert variant="warning">
                  <AlertTitle>Check before you create it</AlertTitle>
                  <AlertDescription>
                    <ul className="list-disc space-y-1 pl-4">
                      {preview.warnings.map((w) => (
                        <li key={w.code}>{w.message}</li>
                      ))}
                    </ul>
                  </AlertDescription>
                </Alert>
              ) : null}
            </section>
          ) : null}

          <div className="flex items-center gap-3">
            <SubmitButton pendingLabel="Creating…" {...(canCreate ? {} : { disabled: true })}>
              Create assessment
            </SubmitButton>
            <Button asChild variant="ghost">
              <Link href="/dashboard">Cancel</Link>
            </Button>
          </div>
        </form>
      </div>

      {preview && assessment && views.length > 0 ? (
        <section aria-labelledby="import-student-view" className="space-y-2">
          <h2 id="import-student-view" className="text-base font-semibold">
            As students will see it
          </h2>
          <InteractivePreview
            assessment={assessment}
            items={views}
            itemSets={sets}
            pictures={state.kind === "ready" ? state.pictures : undefined}
            frameClassName="h-[75vh]"
          />
        </section>
      ) : null}
    </div>
  );
}

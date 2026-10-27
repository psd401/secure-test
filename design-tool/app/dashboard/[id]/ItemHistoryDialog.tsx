"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatDateTime } from "@/lib/ui/format";
import type { ItemRow } from "./AssessmentEditor";

/** One earlier version, as GET …/items/[itemId]/history returns it. */
export interface ItemVersion {
  id: string;
  saved_at: string;
  captured_at: string;
  item: ItemRow;
  /** The version's question as it looks (server-rendered, escaped: renderItemContent). */
  stem_html: string;
}

type Load =
  | { kind: "loading" }
  | { kind: "loaded"; versions: ItemVersion[] }
  | { kind: "failed" };

/** Pure: a one-line reminder of what a version said, markers left in. */
export function versionExcerpt(stem: string, max = 120): string {
  const flat = stem.replace(/\s+/g, " ").trim();
  if (flat.length === 0) return "(no question text)";
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * R-5 (docs/editor-redesign-design.md), behind the R-12 flag: a question's
 * earlier versions, newest first, each with Restore. Restore goes back through
 * the editor's own save (`onRestore`, the same PATCH as autosave), and the
 * server keeps the version it replaces, so a restore can be undone from here.
 */
export function ItemHistoryDialog({
  open,
  onOpenChange,
  assessmentId,
  itemId,
  questionNumber,
  locked,
  onRestore,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  assessmentId: string;
  itemId: string;
  questionNumber: number;
  /** Published: a restore would hit the publish lock, so it is offered after Unpublish. */
  locked: boolean;
  onRestore: (version: ItemVersion) => Promise<boolean>;
}) {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [restoring, setRestoring] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!open) return;
    let live = true;
    setLoad({ kind: "loading" });
    setFailed(false);
    fetch(`/api/assessments/${encodeURIComponent(assessmentId)}/items/${encodeURIComponent(itemId)}/history`)
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as { versions: ItemVersion[] };
        if (live) setLoad({ kind: "loaded", versions: body.versions });
      })
      .catch(() => {
        if (live) setLoad({ kind: "failed" });
      });
    return () => {
      live = false;
    };
  }, [open, assessmentId, itemId]);

  async function restore(v: ItemVersion) {
    setRestoring(v.id);
    setFailed(false);
    const ok = await onRestore(v);
    setRestoring(null);
    if (ok) onOpenChange(false);
    else setFailed(true);
  }

  return (
    <Dialog open={open} onOpenChange={(o) => (restoring ? null : onOpenChange(o))}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Question {questionNumber} history</DialogTitle>
          <DialogDescription>
            Earlier versions of this question, newest first. Restoring one keeps the current
            version here too.
          </DialogDescription>
        </DialogHeader>
        {load.kind === "loading" ? (
          <p role="status" className="text-sm text-muted-foreground">Loading…</p>
        ) : load.kind === "failed" ? (
          <p role="alert" className="text-sm text-destructive">
            The history didn&apos;t load. Close this and try again.
          </p>
        ) : load.versions.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No earlier versions yet. A version is kept every few minutes while you edit.
          </p>
        ) : (
          <ol className="max-h-[60vh] space-y-2 overflow-y-auto text-sm">
            {load.versions.map((v) => (
              <li key={v.id} className="flex items-start justify-between gap-3 rounded-md border p-2">
                <div className="min-w-0">
                  <div className="font-medium">{formatDateTime(v.saved_at)}</div>
                  {v.item.stem.trim() ? (
                    // stem_html is the history route's server render: text
                    // HTML-escaped, math KaTeX, pictures as <img> (as MathPreview).
                    <div
                      className="line-clamp-3 whitespace-pre-line break-words text-muted-foreground"
                      dangerouslySetInnerHTML={{ __html: v.stem_html }}
                    />
                  ) : (
                    <div className="text-muted-foreground">{versionExcerpt(v.item.stem)}</div>
                  )}
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={locked || restoring !== null}
                  onClick={() => void restore(v)}
                  aria-label={`Restore the version from ${formatDateTime(v.saved_at)}`}
                >
                  {restoring === v.id ? "Restoring…" : "Restore"}
                </Button>
              </li>
            ))}
          </ol>
        )}
        {locked ? (
          <p className="text-sm text-muted-foreground">Unpublish to restore an earlier version.</p>
        ) : null}
        {failed ? (
          <p role="alert" className="text-sm text-destructive">
            That version didn&apos;t restore. The question shows why.
          </p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

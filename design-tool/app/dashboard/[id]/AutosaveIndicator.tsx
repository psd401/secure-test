"use client";

import { CheckCircle2, CircleAlert, Loader2 } from "lucide-react";
import type { AutosaveSummary } from "@/lib/authoring/itemAutosave";

/**
 * R-5 (docs/editor-redesign-design.md), behind the R-12 flag: the new
 * editor's one save indicator, in place of each card's Save question button.
 * role=status so a screen reader hears the change without the focus moving.
 */
export function AutosaveIndicator({
  summary,
  questionNumber,
  onJump,
  onRetry,
}: {
  summary: AutosaveSummary;
  questionNumber: (itemId: string) => number;
  onJump: (itemId: string) => void;
  onRetry: () => void;
}) {
  return (
    <div role="status" aria-live="polite" className="flex flex-wrap items-center gap-2 text-sm">
      {summary.kind === "saved" ? (
        <>
          <CheckCircle2 className="size-4 text-success-foreground" aria-hidden />
          <span className="text-muted-foreground">All changes saved</span>
        </>
      ) : summary.kind === "saving" ? (
        <>
          <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden />
          <span className="text-muted-foreground">Saving…</span>
        </>
      ) : (
        <>
          <CircleAlert className="size-4 text-destructive" aria-hidden />
          <span className="text-destructive">
            {summary.kind === "error"
              ? "Some changes didn't save:"
              : "Published — unpublish to save changes to"}
          </span>
          {summary.itemIds.map((id) => (
            <button key={id} type="button" className="text-destructive underline" onClick={() => onJump(id)}>
              Question {questionNumber(id)}
            </button>
          ))}
          {summary.kind === "error" ? (
            <button type="button" className="underline" onClick={onRetry}>
              Try again
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}

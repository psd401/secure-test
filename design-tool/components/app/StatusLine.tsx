"use client";

import { CheckCircle2, CircleAlert, Loader2 } from "lucide-react";
import { formatTime } from "@/lib/ui/format";
import { cn } from "@/lib/utils";

export type SaveState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved"; at: Date }
  | { kind: "failed"; message: string }
  // Batch 3 slice 3: a confirmation whose text isn't "Saved <time>" — the
  // feedback dialog's "Thanks — sent." reuses this line rather than adding a
  // toast system.
  | { kind: "success"; message: string };

/**
 * UX pass 1 (docs/ux-pass-1-proposal.md §2.3 "SUCCESS"): the line beside a
 * Save button. role=status so a screen reader hears "Saved 10:04" without
 * the focus moving (WCAG 4.1.3); nothing here is a toast.
 */
export function StatusLine({ state, className }: { state: SaveState; className?: string }) {
  return (
    <span
      role="status"
      aria-live="polite"
      className={cn("inline-flex items-center gap-1.5 text-sm", className)}
    >
      {state.kind === "saving" ? (
        <>
          <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden />
          <span className="text-muted-foreground">Saving…</span>
        </>
      ) : state.kind === "saved" ? (
        <>
          <CheckCircle2 className="size-4 text-success-foreground" aria-hidden />
          <span className="text-muted-foreground">Saved {formatTime(state.at)}</span>
        </>
      ) : state.kind === "failed" ? (
        <>
          <CircleAlert className="size-4 text-destructive" aria-hidden />
          <span className="text-destructive">{state.message}</span>
        </>
      ) : state.kind === "success" ? (
        <>
          <CheckCircle2 className="size-4 text-success-foreground" aria-hidden />
          <span className="text-muted-foreground">{state.message}</span>
        </>
      ) : null}
    </span>
  );
}

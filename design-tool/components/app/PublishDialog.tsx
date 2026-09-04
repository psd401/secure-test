"use client";

import { CheckCircle2, CircleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export interface ReadinessCheck {
  label: string;
  ok: boolean;
}

/**
 * UX pass 1, slice 4 (A-09, A-10): publishing is a named action with a
 * checklist, not a status dropdown plus "Save metadata". The checks are
 * advisory — the server still accepts a publish with gaps (a separate
 * proposal, open question 3.5) — so Publish stays enabled with a warning.
 */
export function PublishDialog({
  open,
  onOpenChange,
  mode,
  checks,
  busy,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: "publish" | "unpublish";
  checks: ReadinessCheck[];
  busy: boolean;
  onConfirm: () => void;
}) {
  const gaps = checks.filter((c) => !c.ok).length;
  return (
    <Dialog open={open} onOpenChange={(o) => (!busy ? onOpenChange(o) : null)}>
      <DialogContent>
        {mode === "publish" ? (
          <>
            <DialogHeader>
              <DialogTitle>Publish this assessment?</DialogTitle>
              <DialogDescription>
                Publishing locks the questions and settings so a running test can&apos;t change.
                You can unpublish to edit again.
              </DialogDescription>
            </DialogHeader>
            <ul className="space-y-2 text-sm">
              {checks.map((c) => (
                <li key={c.label} className="flex items-start gap-2">
                  {c.ok ? (
                    <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success-foreground" aria-hidden />
                  ) : (
                    <CircleAlert className="mt-0.5 size-4 shrink-0 text-warning-foreground" aria-hidden />
                  )}
                  <span className={c.ok ? "" : "text-warning-foreground"}>{c.label}</span>
                </li>
              ))}
            </ul>
            {gaps > 0 ? (
              <p className="text-sm text-muted-foreground">
                You can still publish, but students will see the gaps.
              </p>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
                Cancel
              </Button>
              <Button type="button" onClick={onConfirm} disabled={busy}>
                {busy ? "Publishing…" : "Publish"}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Unpublish to edit?</DialogTitle>
              <DialogDescription>
                Students can&apos;t start it while it&apos;s a draft. Anyone already in a test
                session keeps going. Publish again when you&apos;re done.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
                Cancel
              </Button>
              <Button type="button" onClick={onConfirm} disabled={busy}>
                {busy ? "Unpublishing…" : "Unpublish"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

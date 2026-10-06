"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

/**
 * The dialog body (docs/answer-history-design.md, slice 2). Pure and exported
 * because Radix's Dialog content sits behind a Portal unmounted while closed,
 * so a static-markup test cannot reach it through the component tree.
 */
export function restoreVersionCopy(handedIn: boolean): string {
  const now =
    "The current answer is kept in this list, so you can switch back.";
  return handedIn
    ? `${now} This answer's score is set aside and it waits for you to score it. ` +
        "To let the student keep working, use Pass back."
    : `${now} The student sees the restored answer when they next open the test.`;
}

/** Plain words for the route's refusals. */
export function restoreErrorCopy(code: string): string {
  switch (code) {
    case "session_open":
      return "End the test session first, then restore.";
    case "not_found":
      return "This version is no longer available. Reload the page.";
    default:
      return "Could not restore this version. Try again.";
  }
}

/**
 * "Restore this version" beside one earlier version of a text answer. On
 * success the page reloads (same reason as the sibling *AndReload controls:
 * the page and its headless test render need a full reload, not the router).
 */
export function RestoreVersionControl({
  revisionId,
  savedLabel,
  handedIn,
  disabledReason,
}: {
  revisionId: string;
  /** "8:37 AM" — names the version in the dialog title. */
  savedLabel: string;
  handedIn: boolean;
  disabledReason?: string;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirmRestore() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/response-revisions/${revisionId}/restore`, {
        method: "POST",
      });
      if (!res.ok) {
        let code = res.status === 404 ? "not_found" : `http_${res.status}`;
        try {
          const body = (await res.json()) as { error?: unknown };
          if (typeof body.error === "string") code = body.error;
        } catch {
          // A body that is not JSON keeps the status-derived code.
        }
        setError(restoreErrorCopy(code));
        return;
      }
      setOpen(false);
      window.location.reload();
    } catch {
      setError(restoreErrorCopy("network"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="xs"
        disabled={disabledReason !== undefined}
        title={disabledReason}
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
      >
        Restore this version
      </Button>
      <Dialog
        open={open}
        onOpenChange={(o) => {
          if (!o && !busy) setOpen(false);
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Restore the version saved {savedLabel}?</DialogTitle>
            <DialogDescription>{restoreVersionCopy(handedIn)}</DialogDescription>
          </DialogHeader>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
            <Button type="button" disabled={busy} onClick={confirmRestore}>
              {busy ? "Restoring…" : "Restore"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

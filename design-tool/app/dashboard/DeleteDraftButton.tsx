"use client";

import { useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { plural } from "@/lib/ui/format";

/**
 * D-1 / D-4 (docs/archive-and-delete-design.md): the Assessments-list row
 * action for the same DELETE the editor's Settings tab calls. A server
 * component can't hold the confirm-dialog state, so this is the client leaf
 * — same disabled-and-noted posture as the editor: Published or with
 * attempts, the button never fires the request at all.
 */
export function DeleteDraftButton({
  id,
  name,
  questionCount,
  attemptCount,
  status,
}: {
  id: string;
  name: string;
  questionCount: number;
  attemptCount: number;
  status: string;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isPublished = status === "published";
  const disabled = isPublished || attemptCount > 0;
  const title = isPublished
    ? "Unpublish to delete."
    : attemptCount > 0
      ? `${plural(attemptCount, "attempt")} — archive instead.`
      : undefined;

  async function confirmDelete() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/assessments/${id}`, { method: "DELETE" });
      if (res.status === 204) {
        // Full navigation rather than the app router, like
        // DeleteAttemptAndReturn: the list is rendered headlessly by
        // test/reporting-views.test.tsx where no router is mounted.
        window.location.reload();
        return;
      }
      const body = (await res.json().catch(() => ({}))) as {
        error?: unknown;
        attempts?: unknown;
      };
      if (res.status === 409 && body.error === "has_attempts") {
        const n = typeof body.attempts === "number" ? body.attempts : 0;
        setError(`${plural(n, "attempt")} — archive instead.`);
      } else {
        setError("Something went wrong. Try again.");
      }
    } catch {
      setError("Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled}
        title={title}
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
      >
        Delete
      </Button>
      <AlertDialog
        open={open}
        onOpenChange={(next) => {
          if (!next && !busy) setOpen(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {name}?</AlertDialogTitle>
            <AlertDialogDescription>
              {plural(questionCount, "question")} will be removed. This can&apos;t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error ? (
            <Alert variant="destructive">
              <AlertTitle>{error}</AlertTitle>
            </Alert>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void confirmDelete();
              }}
              disabled={busy}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              {busy ? "Deleting…" : "Delete draft"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

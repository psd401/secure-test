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
import { Button } from "@/components/ui/button";
import {
  RELEASE_CONFIRM_BODY,
  RELEASE_CONFIRM_TITLE,
  releaseErrorMessage,
  releasedLine,
} from "@/lib/feedback/settingsUi";

/**
 * "Release answers" (docs/instant-feedback-design.md, D-4): the button + its
 * confirm, or — once released — the quiet "Answers released <date>" line that
 * replaces it (no un-release). One component for the Settings tab and the
 * results page. The parent decides whether it belongs on screen
 * (`canReleaseAnswers` / `showsReleasedLine`); this only runs the POST.
 */
export function ReleaseAnswersControl({
  assessmentId,
  releasedAt,
  onReleased,
}: {
  assessmentId: string;
  /** ISO instant, or null when not yet released. */
  releasedAt: string | null;
  /** Called after a successful release (the editor refreshes; the results page reloads). */
  onReleased?: (releasedAt: string) => void;
}) {
  const [stamp, setStamp] = useState<string | null>(releasedAt);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function release() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/assessments/${assessmentId}/release-answers`, {
        method: "POST",
      });
      if (!res.ok) {
        let code = `http_${res.status}`;
        try {
          const body = (await res.json()) as { error?: unknown };
          if (typeof body.error === "string") code = body.error;
        } catch {
          // not JSON
        }
        setError(releaseErrorMessage(code));
        return;
      }
      const body = (await res.json()) as { assessment?: { answers_released_at?: string | null } };
      const at = body.assessment?.answers_released_at ?? new Date().toISOString();
      setStamp(at);
      setOpen(false);
      onReleased?.(at);
    } catch {
      setError(releaseErrorMessage("network"));
    } finally {
      setBusy(false);
    }
  }

  if (stamp !== null) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        {releasedLine(stamp)}
      </p>
    );
  }

  return (
    <>
      <Button type="button" variant="outline" onClick={() => { setError(null); setOpen(true); }}>
        Release answers
      </Button>
      <AlertDialog
        open={open}
        onOpenChange={(o) => {
          if (!o && !busy) setOpen(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{RELEASE_CONFIRM_TITLE}</AlertDialogTitle>
            <AlertDialogDescription>{RELEASE_CONFIRM_BODY}</AlertDialogDescription>
          </AlertDialogHeader>
          {error ? (
            <p role="alert" className="text-sm text-danger-foreground">
              {error}
            </p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={(e) => {
                e.preventDefault();
                void release();
              }}
            >
              {busy ? "Releasing…" : "Release answers"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

/**
 * D-2 / D-3 (docs/archive-and-delete-design.md): archive / unarchive one
 * assessment. Archiving is reversible so there is no confirm dialog here,
 * unlike DeleteDraftButton — just PATCH /api/assessments/[id] {archived}.
 * Full navigation on success, not the app router: this list is rendered
 * headlessly by test/reporting-views.test.tsx where no router is mounted.
 */
export function ArchiveAssessmentButton({ id, archived }: { id: string; archived: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/assessments/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ archived: !archived }),
      });
      if (res.ok) {
        window.location.reload();
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { error?: unknown };
      if (res.status === 409 && body.error === "session_open") {
        setError("Close its open test session first.");
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
    <span className="inline-flex flex-col items-end gap-1">
      <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void toggle()}>
        {archived ? (busy ? "Unarchiving…" : "Unarchive") : busy ? "Archiving…" : "Archive"}
      </Button>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </span>
  );
}

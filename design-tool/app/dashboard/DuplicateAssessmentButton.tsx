"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

/**
 * Duplicate one assessment (2026-09-16, James's decisions): POST
 * /api/assessments/[id]/duplicate, then straight into the new copy's editor.
 *
 * Non-destructive — it only reads the source — so there is no confirm dialog,
 * the same reasoning as ArchiveAssessmentButton. Allowed on Draft, Published
 * and archived sources; the route decides, this button never gates.
 *
 * Full navigation on success, not the app router: the list and the editor are
 * rendered headlessly by test/reporting-views.test.tsx where no router is
 * mounted (see the note on ArchiveAssessmentButton).
 */
export function DuplicateAssessmentButton({
  id,
  size = "sm",
  align = "end",
}: {
  id: string;
  size?: "sm" | "default";
  align?: "start" | "end";
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function duplicate() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/assessments/${id}/duplicate`, { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as { assessment_id?: unknown };
      if (res.ok && typeof body.assessment_id === "string") {
        window.location.assign(`/dashboard/${body.assessment_id}`);
        return;
      }
      setError("Couldn't duplicate this assessment. Try again.");
    } catch {
      setError("Couldn't duplicate this assessment. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    // D-1 (2026-09-16): in a list row (align "end") the error is taken out of
    // the flow — absolutely positioned under the button, no wrap — so it never
    // widens the actions cell and squeezes the name column (A-1's shape). In
    // the Settings tab (align "start") it stays in the flow under the button.
    <span
      className={`inline-flex flex-col gap-1 ${
        align === "end" ? "relative items-end" : "items-start"
      }`}
    >
      <Button
        type="button"
        variant="outline"
        size={size}
        disabled={busy}
        onClick={() => void duplicate()}
      >
        {busy ? "Duplicating…" : "Duplicate"}
      </Button>
      {error ? (
        <p
          role="alert"
          className={`text-xs text-destructive ${
            align === "end" ? "absolute right-0 top-full z-10 mt-1 whitespace-nowrap" : ""
          }`}
        >
          {error}
        </p>
      ) : null}
    </span>
  );
}

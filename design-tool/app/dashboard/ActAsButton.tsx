"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

/**
 * Access slice 5 (docs/access-model-design.md, D-8): start an act-as from the
 * "All teachers" list.
 *
 * Full navigation on success, not the app router: the list is rendered
 * headlessly by test/reporting-views.test.tsx where no router is mounted (the
 * same posture as DuplicateAssessmentButton) — and a reload is the honest
 * thing to do anyway, since the session cookie the response set changes who
 * every subsequent request is.
 *
 * The one refusal worth its own sentence is `no_account_rows`: the target is a
 * real colleague whose `sub` we have never seen, because there is no staff
 * directory to look one up in (lib/api/impersonation.ts).
 */
export function ActAsButton({ email }: { email: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function actAs() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/impersonate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (res.ok) {
        window.location.assign("/dashboard");
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { error?: unknown };
      setError(
        body.error === "no_account_rows"
          ? "This teacher has no assessments or sittings yet, so there is nothing to act on."
          : "Couldn't act as this teacher. Try again.",
      );
    } catch {
      setError("Couldn't act as this teacher. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    // Same shape as DuplicateAssessmentButton's list-row error (D-1,
    // 2026-09-16): out of the flow so a sentence never widens the actions
    // cell and squeezes the name column.
    <span className="relative inline-flex flex-col items-end gap-1">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={busy}
        onClick={() => void actAs()}
      >
        {busy ? "Switching…" : "Act as"}
      </Button>
      {error ? (
        <p
          role="alert"
          className="absolute right-0 top-full z-10 mt-1 max-w-xs text-xs text-destructive"
        >
          {error}
        </p>
      ) : null}
    </span>
  );
}

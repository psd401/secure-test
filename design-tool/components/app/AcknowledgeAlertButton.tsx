"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

/**
 * Safeguarding alerts slice 2: Acknowledge one alert — POST, then reload. A
 * full reload rather than the app router, like `DeleteAttemptAndReturn`: the
 * per-student page is server-rendered and must re-read the DB, and it is also
 * rendered headlessly by the tests, where no router is mounted.
 *
 * No confirm dialog: acknowledging is reversible in effect (the record stays,
 * the alert still shows as acknowledged) and a dialog in front of a welfare
 * concern is friction in the wrong place.
 */
export function AcknowledgeAlertButton({ alertId }: { alertId: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function acknowledge() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/safeguarding-alerts/${alertId}/acknowledge`, {
        method: "POST",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      window.location.reload();
    } catch {
      setError("Could not record that. Try again.");
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" variant="outline" disabled={busy} onClick={() => void acknowledge()}>
        Acknowledge
      </Button>
      {error ? <span className="text-xs text-destructive">{error}</span> : null}
    </div>
  );
}

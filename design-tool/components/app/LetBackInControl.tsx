"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ApiError, letBackInErrorCopy } from "@/lib/ui/errorCopy";

/**
 * "Let back in" (docs/working-time-clock-design.md, D2, slice 3): approves one
 * student's return to a working-time test they left. One press, no dialog —
 * the approval only lets them rejoin (within 10 minutes, once); it changes no
 * answer and no time. The caller shows it on a row that "Asks to continue"
 * and decides what happens after (`onApproved`, usually a reload).
 */
export function LetBackInControl({
  attemptId,
  onApproved,
  size = "sm",
}: {
  attemptId: string;
  onApproved: () => void;
  size?: "xs" | "sm" | "default";
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function approve() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/attempts/${attemptId}/let-back-in`, { method: "POST" });
      if (!res.ok) {
        let code = `http_${res.status}`;
        try {
          const body = (await res.json()) as { error?: unknown };
          if (typeof body.error === "string") code = body.error;
        } catch {
          // not JSON
        }
        throw new ApiError(code, res.status);
      }
      onApproved();
    } catch (err) {
      setError(letBackInErrorCopy(err instanceof ApiError ? err.code : "network").message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex flex-col items-end gap-1">
      <Button type="button" size={size} onClick={() => void approve()} disabled={busy}>
        {busy ? "Letting in…" : "Let back in"}
      </Button>
      {error ? (
        <span role="alert" className="text-xs text-danger-foreground">
          {error}
        </span>
      ) : null}
    </span>
  );
}

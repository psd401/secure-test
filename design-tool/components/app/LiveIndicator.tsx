"use client";

import { Button } from "@/components/ui/button";
import { formatTime } from "@/lib/ui/format";

/**
 * UX pass 1 (docs/ux-pass-1-proposal.md §2.3 "LOADING"): the one line under
 * a polled view. Polling failures are reported HERE — beside the data that
 * is now stale — never by blanking the list or by the form's error channel.
 */
export function LiveIndicator({
  intervalMs,
  updatedAgo,
  failedAt,
  onRetry,
  live,
}: {
  intervalMs: number;
  /** "3s ago" — already formatted by the caller's clock. */
  updatedAgo: string;
  /** When the last poll failed; null while polling is healthy. */
  failedAt: Date | null;
  onRetry: () => void;
  /** False once the session is closed or ended: no dot, no cadence. */
  live: boolean;
}) {
  if (failedAt) {
    return (
      <span role="status" aria-live="polite" className="inline-flex flex-wrap items-center gap-2 text-sm text-warning-foreground">
        Last update failed at {formatTime(failedAt)} — retrying every {Math.round(intervalMs / 1000)} s.
        <Button type="button" variant="outline" size="xs" onClick={onRetry}>
          Retry now
        </Button>
      </span>
    );
  }
  if (!live) return null;
  return (
    <span role="status" aria-live="polite" className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <span className="inline-block size-2 rounded-full bg-success-foreground" aria-hidden />
      Live · every {Math.round(intervalMs / 1000)} s · updated {updatedAgo}
    </span>
  );
}

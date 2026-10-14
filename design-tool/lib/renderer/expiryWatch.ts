import { log, truncate } from "@/lib/log";
import { currentRenderer } from "./current";

// Renderer expiry watch (docs/server-delivered-renderer-design.md slice 4f):
// resolves the current renderer hourly so `renderer_expiring` /
// expired-at-ERROR (current.ts) reach the alarm even when no student is
// asking for a bundle — the summer gap is the case that matters. Only where
// the deployment delivers renderers (RENDERER_DELIVERY=on).

export const EXPIRY_WATCH_INTERVAL_MS = 60 * 60_000;

let started = false;

/** Once per process (instrumentation.ts `register`); the timers are unref'd. */
export function startRendererExpiryWatch(): void {
  if (started || process.env.RENDERER_DELIVERY !== "on") return;
  started = true;
  const tick = async () => {
    try {
      await currentRenderer();
    } catch (err) {
      log.error("renderer_expiry_watch_failed", {
        message: truncate(err instanceof Error ? err.message : String(err)),
      });
    }
  };
  setTimeout(() => void tick(), 2 * 60_000).unref();
  setInterval(() => void tick(), EXPIRY_WATCH_INTERVAL_MS).unref();
}

import { and, isNull, isNotNull, lt } from "drizzle-orm";
import { peek_requests } from "@/db/schema";
import type { getDb } from "@/db/client";

type Db = ReturnType<typeof getDb>;

// On-demand peek constants (docs/on-demand-peek-design.md, decisions
// 2026-08-28). All three windows are server-enforced; the client's 5 s poll
// cadence is what makes PENDING_TTL_MS generous rather than tight.

/** 6.5: minimum interval between requests per attempt. */
export const PEEK_RATE_LIMIT_MS = 10_000;

/**
 * A request the client has not picked up within this window is dead — the
 * student's app is offline or wedged, and a render surprising the student
 * minutes later would break the notified-at-request-time contract.
 */
export const PEEK_PENDING_TTL_MS = 30_000;

/** 6.4: an unread image older than this is swept. */
export const PEEK_IMAGE_TTL_MS = 60_000;

/**
 * Upload cap. The design's render is ~100-250 KB of JPEG (~350 KB as
 * base64); 2 MB of base64 is comfortably above any legitimate frame and
 * comfortably below anything worth abusing.
 */
export const PEEK_MAX_IMAGE_BASE64_LENGTH = 2_000_000;

/**
 * The TTL half of delete-on-read: null out unread images past
 * PEEK_IMAGE_TTL_MS. Lazy — run from the peek routes rather than a cron, so
 * it holds on any number of Fargate instances with no scheduler. The rows
 * stay: they are the audit record.
 */
export async function sweepExpiredPeekImages(db: Db): Promise<void> {
  await db
    .update(peek_requests)
    .set({ image_base64: null })
    .where(
      and(
        isNull(peek_requests.viewed_at),
        isNotNull(peek_requests.image_base64),
        lt(peek_requests.delivered_at, new Date(Date.now() - PEEK_IMAGE_TTL_MS)),
      ),
    );
}

import { NextResponse } from "next/server";
import type { AttemptRow } from "@/db/schema";

/**
 * Corrections mode's write guard (docs/bulk-pass-back-and-corrections-design.md,
 * slice 3, D-8 / D-27): a student may not change an answer the reopened test
 * locked for full credit. Refused only when a delivery actually CARRIED the
 * locks (`locks_delivered`, written by the delivery route) — a client or
 * renderer too old to draw them was never told, so it is never refused.
 * Called by the student write routes after the deadline check, with the same
 * 409 shape; a staff answer restore does not pass through here.
 */
export function refuseIfLocked(
  attempt: Pick<AttemptRow, "corrections">,
  itemId: string,
): NextResponse | null {
  const c = attempt.corrections;
  if (!c?.lock_correct || !c.locks_delivered) return null;
  if (!(c.locked_item_ids ?? []).includes(itemId)) return null;
  return NextResponse.json({ ok: false, error: "item_locked" }, { status: 409 });
}

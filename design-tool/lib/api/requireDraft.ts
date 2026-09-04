import { NextResponse } from "next/server";
import type { AssessmentRow, ItemRow } from "@/db/schema";
import { itemConfigForWrite, type UpdateItemBody } from "@/lib/api/items";

// Publish-lock guard (slice 19; MVP spec line 100 — "Publishing locks
// the assessment for editing"). Returns null when the assessment is in
// draft (mutations allowed) and a 409 NextResponse when it's published.
//
// The unlock path is a PATCH on the assessment itself setting
// `status: "draft"`. That route validates the body BEFORE this guard
// fires so the unlock is reachable; everything else routes through here
// and bounces while published.

/** Status-only form, for callers that carry the parent's status but not its row. */
export function requireDraftStatus(status: string): NextResponse | null {
  if (status === "draft") return null;
  return NextResponse.json(
    {
      ok: false,
      error: "assessment_published_editing_locked",
      hint: "Set status: 'draft' on the parent assessment to re-enable edits.",
    },
    { status: 409 },
  );
}

export function requireDraft(assessment: AssessmentRow): NextResponse | null {
  return requireDraftStatus(assessment.status);
}

// Key-order-independent serialization for the jsonb shapes an item carries.
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

/**
 * Does this item PATCH change nothing but the answer key?
 *
 * 2026-09-01: keyless items may be published (the PDF importer proposes
 * them, the readiness checklist flags them) and the teacher fills the key
 * in later — so the publish lock admits a PATCH whose only deltas are
 * correct_choice_ids / correct_answer / hotspot correct_region_ids / table
 * cell_keys (E3). Stem, choices, and every other config field must be
 * byte-identical to what is stored, so nothing student-facing can change
 * through this door. Auto
 * scoring picks the key up on its next run for still-unscored responses;
 * responses that already have a final score are not re-scored (the score
 * route's standing idempotency rule).
 */
export function isAnswerKeyOnlyPatch(body: UpdateItemBody, item: ItemRow): boolean {
  if (body.type !== item.type) return false;
  if (body.stem !== item.stem) return false;
  if (stable(body.choices) !== stable(item.choices ?? [])) return false;
  const {
    correct_region_ids: _next,
    cell_keys: _nextCells,
    ...nextRest
  } = itemConfigForWrite(body, item.config ?? undefined) as Record<string, unknown>;
  const {
    correct_region_ids: _cur,
    cell_keys: _curCells,
    ...curRest
  } = (item.config ?? {}) as Record<string, unknown>;
  return stable(nextRest) === stable(curRest);
}

/** Loose structural equality for the scalar / string[] shapes a patch carries. */
function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    return a.length === b.length && a.every((v, i) => v === b[i]);
  }
  // A patch sending description:"" against a NULL column is not a change in
  // any sense the teacher would recognize; treat null/undefined as equal.
  if (a == null && b == null) return true;
  return a === b;
}

/**
 * Is this PATCH the publish→draft unlock, and nothing else?
 *
 * The original check was `Object.keys(body).length === 1 && key === "status"`,
 * which made the unlock unreachable from the editor: `saveMetadata` always
 * sends all six metadata fields, so following the lock banner's own
 * instruction ("Send { status: 'draft' } first") 409'd every time, while
 * `isLocked` tracked the local select and visually re-enabled the inputs
 * (phase-1-2 review, C9).
 *
 * Keying on *changed* fields instead of *present* fields fixes that without
 * widening the lock: a full-metadata PATCH unlocks only when every field other
 * than status is byte-identical to what is already stored, so a teacher cannot
 * smuggle an edit through in the same request that unlocks.
 */
export function isUnlockOnlyPatch(
  body: Record<string, unknown>,
  current: AssessmentRow,
): boolean {
  if (body.status !== "draft") return false;
  const currentRecord = current as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(body)) {
    if (key === "status") continue;
    if (value === undefined) continue;
    if (!sameValue(value, currentRecord[key])) return false;
  }
  return true;
}

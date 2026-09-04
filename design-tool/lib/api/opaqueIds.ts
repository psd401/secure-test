import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Slice 64: per-attempt opaque ids for match and order items.
 *
 * Slice 51 split match `pairs` into independent `lefts`/`rights` arrays and
 * shuffled the rights, which removed the POSITIONAL giveaway. It did not remove
 * the identifier one: both arrays carried the authoring pair id, so a student
 * reading the bundle file could pair left `p1` with right `p1` and have the
 * answer key without solving anything. Order had the same problem from the
 * other direction — entry ids like e1, e2, e3 are assigned in authored
 * sequence, so their natural ordering IS the answer.
 *
 * That could not be fixed at the time: hiding the real ids means translating
 * the student's answer back on the way in, which needs a per-attempt anchor,
 * and attempts did not exist until slice 61. They do now.
 *
 * DERIVED, not stored. `HMAC(secret, attempt : item : realId)` truncated — so a
 * re-fetch of the bundle yields the same ids (a student mid-test who reconnects
 * must not find their options renamed), there is no map table to keep in step
 * with edits, and two students in the same sitting get different ids for the
 * same option, so comparing screens reveals nothing.
 *
 * Reversal is by recomputation over the item's own candidates rather than by
 * inverting the hash, which is why truncation is safe: the server always knows
 * the small set of real ids an answer could refer to.
 *
 * `scope` is what makes match work at all. A pair's left and right derive from
 * the SAME authoring id, so without a discriminator both sides of a pair get
 * the same opaque id and the bundle re-pairs itself for anyone who looks — the
 * exact leak this exists to close. Match passes "L" and "R"; order passes "".
 */
const ID_BYTES = 12;

export const MATCH_LEFT = "L";
export const MATCH_RIGHT = "R";

let warnedAboutFallback = false;

function secret(): Buffer {
  const dedicated = process.env.DESIGN_TOOL_DELIVERY_SECRET;
  if (dedicated) return Buffer.from(dedicated, "utf8");

  // Falls back to the session secret, the same shape DESIGN_TOOL_PKCE_SECRET
  // uses. A missing dedicated secret must not silently disable the sealing.
  //
  // Slice 73: it warns now. The security review noted that a documented
  // recommendation nobody is reminded of is a recommendation that mostly does
  // not happen — the fallback works, so there is nothing to notice. There is no
  // practical cross-protocol attack here (the HMAC inputs are structurally
  // different from a session JWT's), but one key doing two jobs means rotating
  // it for one reason silently renames every in-flight assessment's options.
  const shared = process.env.DESIGN_TOOL_SESSION_SECRET;
  if (!shared) {
    throw new Error(
      "DESIGN_TOOL_DELIVERY_SECRET or DESIGN_TOOL_SESSION_SECRET must be set to seal delivery ids",
    );
  }
  if (!warnedAboutFallback) {
    warnedAboutFallback = true;
    console.warn(
      "auth: DESIGN_TOOL_DELIVERY_SECRET is not set, so delivery ids are sealed " +
        "with DESIGN_TOOL_SESSION_SECRET. Set a distinct value: rotating the " +
        "session secret otherwise renames the match/order options of every " +
        "in-progress attempt.",
    );
  }
  return Buffer.from(shared, "utf8");
}

/** Test seam — the warn-once flag is process-global otherwise. */
export function __resetDeliverySecretWarning(): void {
  warnedAboutFallback = false;
}

export function opaqueId(
  attemptId: string,
  itemId: string,
  realId: string,
  scope = "",
): string {
  return createHmac("sha256", secret())
    .update(`${attemptId}:${itemId}:${scope}:${realId}`)
    .digest("hex")
    .slice(0, ID_BYTES * 2);
}

/**
 * Maps an opaque id back to the real one, or null if it matches none of the
 * item's candidates.
 *
 * Constant-time comparison so a student cannot learn a valid id a character at
 * a time by timing the failures. The candidate set is small and server-known,
 * so the loop itself leaks nothing beyond its length.
 */
export function resolveOpaqueId(
  attemptId: string,
  itemId: string,
  candidates: readonly string[],
  submitted: string,
  scope = "",
): string | null {
  const target = Buffer.from(submitted, "utf8");
  let match: string | null = null;
  for (const candidate of candidates) {
    const expected = Buffer.from(opaqueId(attemptId, itemId, candidate, scope), "utf8");
    if (expected.length !== target.length) continue;
    if (timingSafeEqual(expected, target)) match = candidate;
  }
  return match;
}

/** Convenience for translating a whole list, failing if any entry is unknown. */
export function resolveOpaqueIds(
  attemptId: string,
  itemId: string,
  candidates: readonly string[],
  submitted: readonly string[],
  scope = "",
): string[] | null {
  const out: string[] = [];
  for (const value of submitted) {
    const real = resolveOpaqueId(attemptId, itemId, candidates, value, scope);
    if (real === null) return null;
    out.push(real);
  }
  return out;
}

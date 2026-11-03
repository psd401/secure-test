// FB slice 6 (docs/fill-in-blank-design.md, D-4): the oldest SecureTest
// client that can render each item type. A client decodes a bundle as a
// whole, and an item type it does not know fails the WHOLE decode — the
// student sees "This test could not be opened" for a test with one new
// question. So the delivery route refuses such a bundle up front, before the
// client calls begin() (nothing locks), and v1.6.0+ tells the student to
// update in Self Service. A type absent from this map works on every client.
// A type only a served renderer can draw (v2.0, docs/server-delivered-
// renderer-design.md) is added here as "2.0.0"; v2.0 itself needs no entry.
export const MIN_CLIENT_VERSION_FOR_TYPE: Readonly<Record<string, string>> = {
  fill_blank: "1.6.0",
  // Graphing calculator D-9: only the served renderer draws the board.
  graph: "2.0.0",
};

/** "1.5.0" → [1, 5, 0]; anything unparseable → null. */
export function parseClientVersion(value: string | null | undefined): number[] | null {
  const m = /^\s*(\d+)\.(\d+)(?:\.(\d+))?/.exec(value ?? "");
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null;
}

/**
 * Passage highlighting (docs/passage-highlighting-design.md, "The rollout
 * gate", decision H-1 — James, 2026-10-14): the oldest client that draws the
 * highlighting tool (a v2.0 served renderer). Below it the delivery bundle
 * simply carries no `allow_highlighting` field; such a client is NEVER
 * refused for it — highlighting is an aid, not part of answering. To refuse
 * instead, the decision would move to a 409 like MIN_CLIENT_VERSION_FOR_TYPE.
 */
export const MIN_CLIENT_VERSION_FOR_HIGHLIGHTING = "2.0.0";

/**
 * Graphing calculator (docs/graphing-calculator-design.md D-7): features of
 * a bundle, beyond its item types, that only a newer client can honour.
 * Unlike highlighting, a calculator is part of what the test measures, so a
 * client that can't draw it is REFUSED (the same 409 as an item type),
 * never silently given a test without it.
 */
export const MIN_CLIENT_VERSION_FOR_FEATURE: Readonly<Record<string, string>> = {
  calculator: "2.0.0",
  // A stimulus graph is part of the question; an older client couldn't draw it.
  graph_stimulus: "2.0.0",
};

function atLeast(have: number[], need: number[]): boolean {
  for (let i = 0; i < 3; i++) {
    if (have[i]! !== need[i]!) return have[i]! > need[i]!;
  }
  return true;
}

/**
 * The newest minimum version among `types` that the client (its
 * `X-SecureTest-Version`, null when absent — every client before v1.5.0)
 * does not meet, or null when the client can render them all. A client that
 * sends no version, or one that cannot be read, is treated as too old.
 */
export function requiredClientUpgrade(
  clientVersion: string | null,
  types: Iterable<string>,
  /** Bundle features with a minimum (MIN_CLIENT_VERSION_FOR_FEATURE). */
  features: Iterable<string> = [],
): string | null {
  const have = parseClientVersion(clientVersion);
  let needed: string | null = null;
  const minimums = [
    ...[...new Set(types)].map((t) => MIN_CLIENT_VERSION_FOR_TYPE[t]),
    ...[...new Set(features)].map((f) => MIN_CLIENT_VERSION_FOR_FEATURE[f]),
  ];
  for (const min of minimums) {
    if (!min) continue;
    if (have && atLeast(have, parseClientVersion(min)!)) continue;
    if (!needed || atLeast(parseClientVersion(min)!, parseClientVersion(needed)!)) needed = min;
  }
  return needed;
}

/**
 * Does this client (its `X-SecureTest-Version`, null when absent) draw the
 * passage-highlighting tool? A missing or unreadable version reads as too old.
 */
export function clientSupportsHighlighting(clientVersion: string | null): boolean {
  const have = parseClientVersion(clientVersion);
  return have !== null && atLeast(have, parseClientVersion(MIN_CLIENT_VERSION_FOR_HIGHLIGHTING)!);
}

/**
 * Corrections mode (docs/bulk-pass-back-and-corrections-design.md, slice 3,
 * D-27): the oldest SERVED RENDERER version that draws marks and locks.
 *
 * Slice 3d: a renderer's version is the committer time of the `main` commit
 * it was built from (`packages/renderer/scripts/build.ts`), and `main` is
 * linear. 1793647928 (2026-11-02 11:32:08 PT) is the committer time of
 * `bbd1b58f`, the squash merge of PR #169 that brought the page half (3c) to
 * `main` — so every renderer built at or after it draws corrections, and
 * every renderer built before it is below this floor. A time taken from a
 * branch commit would NOT be safe: a renderer signed from `main` before the
 * merge could carry a later time without the page half.
 */
export const MIN_RENDERER_VERSION_FOR_CORRECTIONS: number | null = 1793647928;

let correctionsRendererFloor: number | null = MIN_RENDERER_VERSION_FOR_CORRECTIONS;

/** The floor the delivery route uses now (tests save it before changing it). */
export function getCorrectionsRendererFloor(): number | null {
  return correctionsRendererFloor;
}

/** Test seam (like `setRendererResolver`): the floor the delivery route
 * uses; returns the previous one so a test can restore it. */
export function setCorrectionsRendererFloor(next: number | null): number | null {
  const previous = correctionsRendererFloor;
  correctionsRendererFloor = next;
  return previous;
}

/**
 * Whether a delivery may carry corrections: a 2.0+ client (the served
 * renderer's floor) AND a named renderer at least
 * `MIN_RENDERER_VERSION_FOR_CORRECTIONS`. Like highlighting, a client that
 * fails this is never refused — it gets no marks and no locks (D-27).
 */
export function correctionsDeliverable(
  clientVersion: string | null,
  renderer: { version: number } | null | undefined,
  minRendererVersion: number | null = correctionsRendererFloor,
): boolean {
  if (minRendererVersion === null || !renderer) return false;
  return clientSupportsHighlighting(clientVersion) && renderer.version >= minRendererVersion;
}

/**
 * Revision feedback (docs/competency-assessment-design.md, D-16, slice 7):
 * the oldest SERVED RENDERER version that draws the "Scorer feedback" panel.
 * 1793687410 (2026-11-02 22:30:10 PT) is the committer time of `4f44cc09`,
 * the squash merge of PR #178 that brought the panel to `main` — so every
 * renderer built at or after it draws the panel, and every renderer built
 * before it is below this floor. Set the same way as
 * `MIN_RENDERER_VERSION_FOR_CORRECTIONS` (slice 3d), never from a branch
 * commit's time. Below it no bundle carries the field and no client is
 * refused.
 */
export const MIN_RENDERER_VERSION_FOR_REVISION_FEEDBACK: number | null = 1793687410;

let revisionFeedbackRendererFloor: number | null = MIN_RENDERER_VERSION_FOR_REVISION_FEEDBACK;

/** Test seam, as `setCorrectionsRendererFloor`; returns the previous floor. */
export function setRevisionFeedbackRendererFloor(next: number | null): number | null {
  const previous = revisionFeedbackRendererFloor;
  revisionFeedbackRendererFloor = next;
  return previous;
}

/**
 * Whether a delivery may carry `revision_feedback`: the same two gates as
 * corrections — a 2.0+ client and a named renderer at or above the floor.
 * Below them nothing is added and nothing is refused.
 */
export function revisionFeedbackDeliverable(
  clientVersion: string | null,
  renderer: { version: number } | null | undefined,
  minRendererVersion: number | null = revisionFeedbackRendererFloor,
): boolean {
  return correctionsDeliverable(clientVersion, renderer, minRendererVersion);
}

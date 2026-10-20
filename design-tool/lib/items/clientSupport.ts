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

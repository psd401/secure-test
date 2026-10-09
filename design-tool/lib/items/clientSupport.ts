// FB slice 6 (docs/fill-in-blank-design.md, D-4): the oldest SecureTest
// client that can render each item type. A client decodes a bundle as a
// whole, and an item type it does not know fails the WHOLE decode — the
// student sees "This test could not be opened" for a test with one new
// question. So the delivery route refuses such a bundle up front, before the
// client calls begin() (nothing locks), and v1.6.0+ tells the student to
// update in Self Service. A type absent from this map works on every client.
export const MIN_CLIENT_VERSION_FOR_TYPE: Readonly<Record<string, string>> = {
  fill_blank: "1.6.0",
};

/** "1.5.0" → [1, 5, 0]; anything unparseable → null. */
export function parseClientVersion(value: string | null | undefined): number[] | null {
  const m = /^\s*(\d+)\.(\d+)(?:\.(\d+))?/.exec(value ?? "");
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null;
}

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
): string | null {
  const have = parseClientVersion(clientVersion);
  let needed: string | null = null;
  for (const type of new Set(types)) {
    const min = MIN_CLIENT_VERSION_FOR_TYPE[type];
    if (!min) continue;
    if (have && atLeast(have, parseClientVersion(min)!)) continue;
    if (!needed || atLeast(parseClientVersion(min)!, parseClientVersion(needed)!)) needed = min;
  }
  return needed;
}

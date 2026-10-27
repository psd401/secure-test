import type { MatchPair } from "@secure-test/schema";

// R-7 (docs/editor-redesign-design.md, Phase 4 slice C): editing the answer
// key of matching and ordering questions by drag or by a click path, behind
// the R-12 flag. Pure, so the moves and what the live region says are tested
// headlessly (test/authoring-key-order.test.ts).
//
// Ordering: the authored order IS the key (SequenceEditor), so moving a step
// is `moveInList` from outline.ts.
// Matching: the key is which right belongs to which left (one row = one
// pair). Re-pairing swaps two rows' rights; the lefts, their order and the
// pair ids stay put, so no other pair changes.

/** Pairs with the rights of rows `a` and `b` swapped. Out-of-range or equal rows: unchanged. */
export function swapMatchRights(pairs: readonly MatchPair[], a: number, b: number): MatchPair[] {
  const out = pairs.map((p) => ({ ...p }));
  if (a === b || !out[a] || !out[b]) return out;
  const right = out[a]!.right;
  out[a]!.right = out[b]!.right;
  out[b]!.right = right;
  return out;
}

/** A short, plain version of a pair's text for an announcement. */
export function keyExcerpt(text: string, fallback: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return fallback;
  return flat.length > 40 ? `${flat.slice(0, 39)}…` : flat;
}

/** What the live region says after rows `a` and `b` swap rights (`pairs` is the list AFTER the swap). */
export function matchSwapAnnouncement(pairs: readonly MatchPair[], a: number, b: number): string {
  if (a === b || !pairs[a] || !pairs[b]) return "Nothing was swapped.";
  const line = (i: number) =>
    `${keyExcerpt(pairs[i]!.left, `Left ${i + 1}`)} now matches ${keyExcerpt(pairs[i]!.right, `an empty right`)}`;
  return `${line(a)}. ${line(b)}.`;
}

/** What the live region says after an ordering step moves. */
export function stepMoveAnnouncement(from: number, to: number, count: number): string {
  if (from === to) return `Step ${from + 1} did not move.`;
  return `Step ${from + 1} moved. It is now step ${to + 1} of ${count}.`;
}

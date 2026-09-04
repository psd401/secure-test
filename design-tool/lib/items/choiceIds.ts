// Picks the next sequential alphabetic id for a new MC choice, given the
// existing choices. Standard ergonomic for K-12 assessments: a, b, c, …
// The first 26 are single letters; past z it falls through to aa, ab, ….
// In practice no realistic assessment hits >26 choices, but the fallback
// keeps the function total instead of throwing or recycling.
//
// If the existing choices use ids that aren't sequential letters (e.g.
// the teacher manually edited them to "red"/"blue"/"green"), the function
// still returns the next unused single letter — it doesn't require the
// existing set to be alphabetic.

export interface ChoiceLike {
  id: string;
}

export function nextChoiceId(existing: readonly ChoiceLike[]): string {
  const used = new Set(existing.map((c) => c.id));

  // Single letters first (a..z).
  for (let i = 0; i < 26; i++) {
    const letter = String.fromCharCode(97 + i);
    if (!used.has(letter)) return letter;
  }
  // Two-letter combinations (aa..zz). 676 entries — far past any real
  // assessment, but cheap to handle and keeps the function total.
  for (let i = 0; i < 26 * 26; i++) {
    const first = String.fromCharCode(97 + Math.floor(i / 26));
    const second = String.fromCharCode(97 + (i % 26));
    const id = first + second;
    if (!used.has(id)) return id;
  }
  // Past 702 choices, fall back to a random suffix so the function
  // remains total. Practically unreachable.
  return `c${Math.random().toString(36).slice(2, 6)}`;
}

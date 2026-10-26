// Random markup for the round-trip and cross-renderer property tests (also
// imported by design-tool/test/markup-golden.test.ts).

// A seeded PRNG so a failure reproduces; the alphabet is weighted toward the
// characters that are syntax.
export function prng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PIECES = [
  "$", "$", "$$", "\\$", "\\", "*", "**", "**", "_", "_", " ", " ", "\n",
  "a", "b", "x", "5", "7", "^", "\\times", "(", ")", "[[b1]]", "[[b2]]", "[[", "]]",
  "![p](asset:11111111-1111-1111-1111-111111111111)", "![", "](asset:", "“", ".",
];

export function randomMarkup(rand: () => number, maxPieces = 14): string {
  const n = 1 + Math.floor(rand() * maxPieces);
  let s = "";
  for (let i = 0; i < n; i++) s += PIECES[Math.floor(rand() * PIECES.length)];
  return s;
}

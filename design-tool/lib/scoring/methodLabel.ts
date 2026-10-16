// Hybrid scoring transparency, slice 1 (docs/hybrid-scoring-transparency-design.md,
// D-1): one place that names how a score came to be, so an AI score Hybrid
// finalized on its own is never shown as one a teacher approved.
//
// Every path that turns an AI proposal into a teacher's decision writes
// `reviewed_by_sub` (approve, manual score, change score — since migration
// 0009), so a null on an `ai` row means no one reviewed it: the scorer
// finalized it (Hybrid at confidence >= 0.85) or it is still a proposal.

export interface MethodLabelScore {
  method: string;
  reviewed_by_sub: string | null;
}

/** True for an AI score no teacher reviewed. */
export function isAiUnreviewed(score: MethodLabelScore): boolean {
  return score.method === "ai" && score.reviewed_by_sub === null;
}

/**
 * The per-student page's word for a score's method. An approved AI score says
 * "by you" only when the viewer approved it (decision 4.1, 2026-10-16: a
 * co-teacher's approval reads "AI, approved" rather than naming anyone).
 */
export function finalMethodWord(score: MethodLabelScore, viewerSub: string): string {
  switch (score.method) {
    case "auto":
      return "auto-scored";
    case "human":
      return "scored by you";
    case "ai":
      if (score.reviewed_by_sub === null) return "AI, not reviewed";
      return score.reviewed_by_sub === viewerSub ? "AI, approved by you" : "AI, approved";
    default:
      return score.method;
  }
}

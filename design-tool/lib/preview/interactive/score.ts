// "Finish and hand in" in the interactive preview (editor redesign Phase 5
// slice B, ADR 0019 §5): the editor page scores the answers given in the
// frame against the key the EDITOR already holds, with the same pure
// function the server scores a real attempt with (`scoreResponse`,
// lib/scoring/auto.ts). Nothing is written, and neither the key nor the
// result goes into the frame — the result is shown in the editor page.
import type { ItemResponse } from "@secure-test/schema";
import type { ItemRow } from "@/db/schema";
import { scoreResponse } from "@/lib/scoring/auto";
import { defaultScoringMethod, type ItemView } from "@/app/dashboard/[id]/editorModel";
import { viewToRow, type PreviewSealer } from "./bundle";

/**
 * A frame answer with match / order ids translated back to the real ones,
 * or null when an id is not one this sealer minted for this item (a stale or
 * forged answer — treated as unanswered).
 */
export function unsealResponse(item: ItemView, response: ItemResponse, sealer: PreviewSealer): ItemResponse | null {
  if (response.type !== item.type) return null;
  if (response.type === "match") {
    const matches: Record<string, string> = {};
    for (const [left, right] of Object.entries(response.matches)) {
      const l = sealer.unseal(item.id, left, "left");
      const r = sealer.unseal(item.id, right, "right");
      if (l === null || r === null) return null;
      matches[l] = r;
    }
    return { type: "match", matches };
  }
  if (response.type === "order") {
    const ordered: string[] = [];
    for (const id of response.ordered_ids) {
      const real = sealer.unseal(item.id, id, "order");
      if (real === null) return null;
      ordered.push(real);
    }
    return { type: "order", ordered_ids: ordered };
  }
  return response;
}

/**
 * The emptiest answer of each auto-scored type: what `scoreResponse` needs to
 * report an unanswered question's max points. Built by hand (not parsed) — the
 * response schema refuses empty answers, the scorer does not.
 */
function emptyResponse(type: ItemView["type"]): ItemResponse | null {
  switch (type) {
    case "multiple_choice_single":
      return { type, choice_id: "" };
    case "multiple_choice_multi":
      return { type, choice_ids: [] };
    case "short_text":
      return { type, text: "" };
    case "match":
      return { type, matches: {} };
    case "order":
      return { type, ordered_ids: [] };
    case "hotspot":
      return { type, region_ids: [] };
    case "table":
      return { type, cells: {} };
    case "fill_blank":
      return { type, answers: {} };
    case "graph":
      return { type, objects: [] } as ItemResponse;
    default:
      return null;
  }
}

export type PreviewOutcome =
  | "correct"
  | "partly"
  | "wrong"
  | "unanswered"
  /** Scored by a person (or AI) after the test: essay, drawing, method ≠ auto. */
  | "by_hand"
  /** Auto-scored type with no answer key yet. */
  | "no_key";

export interface PreviewScoreRow {
  itemId: string;
  /** 1-based, as the editor numbers questions. */
  number: number;
  outcome: PreviewOutcome;
  points: number | null;
  max: number | null;
}

export interface PreviewScore {
  rows: PreviewScoreRow[];
  /** Over the machine-scored questions with a key. */
  points: number;
  max: number;
}

export function scorePreview(
  items: readonly ItemView[],
  answers: Readonly<Record<string, ItemResponse>>,
  sealer: PreviewSealer,
): PreviewScore {
  let points = 0;
  let max = 0;
  const rows = items.map((item, index): PreviewScoreRow => {
    const base = { itemId: item.id, number: index + 1 };
    const method = item.scoring_method ?? defaultScoringMethod(item);
    if (method !== "auto") return { ...base, outcome: "by_hand", points: null, max: null };
    const row = viewToRow(item) as ItemRow;
    const empty = emptyResponse(item.type);
    const keyed = empty ? scoreResponse(row, empty) : null;
    if (!keyed) return { ...base, outcome: "no_key", points: null, max: null };
    max += keyed.max_points;
    const given = answers[item.id];
    const answer = given ? unsealResponse(item, given, sealer) : null;
    if (!answer) return { ...base, outcome: "unanswered", points: 0, max: keyed.max_points };
    const scored = scoreResponse(row, answer);
    if (!scored) return { ...base, outcome: "unanswered", points: 0, max: keyed.max_points };
    points += scored.points;
    const outcome =
      scored.points >= scored.max_points ? "correct" : scored.points > 0 ? "partly" : "wrong";
    return { ...base, outcome, points: scored.points, max: scored.max_points };
  });
  return { rows, points, max };
}

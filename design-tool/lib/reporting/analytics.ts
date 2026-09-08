// R1 (docs/reporting-design.md): item analytics — how the class did on each
// question, as a footer under the results matrix.
//
// Pure aggregation over rows the CALLER fetched, deliberately: the join it
// needs (`responses` left-joined to its one final `scores` row, scoped to the
// submitted attempts of one assessment) already exists in
// lib/scoring/results.ts, and a second copy of that query inside a helper is
// a second place for the tenant scoping to be got wrong. Rows in, numbers
// out — unit-testable with no database.
//
// Two rules that match the rest of the results path:
//   - PROPOSED AI scores are never counted. A caller passes `points: null`
//     for a response with no final row, and it lands in `unscored_count`.
//   - "answered" means a `responses` row exists. The client creates one when
//     the student answers and DELETES it on "Clear answer", so existence is
//     the same signal the delivery bundle's `answered_item_ids` carries.

export interface AnalyticsItem {
  id: string;
  position: number;
  type: string;
  /** The item's constant maximum — the same denominator `buildResults` sums. */
  max_points: number;
  choices?: Array<{ id: string; text: string }>;
  correct_choice_ids?: string[];
}

export interface AnalyticsResponseRow {
  item_id: string;
  /** The response's jsonb, for the multiple-choice distribution. */
  response: Record<string, unknown> | null;
  /** FINAL points, or null when nothing final has been written yet. */
  points: number | null;
}

export interface ChoiceTally {
  id: string;
  text: string;
  count: number;
  is_key: boolean;
}

export interface ItemAnalytics {
  item_id: string;
  position: number;
  type: string;
  max_points: number;
  /** Responses that exist for this item, over the submitted attempts given. */
  answered_count: number;
  /** answered_count / submitted_count as a whole percentage; null when N = 0. */
  answered_percent: number | null;
  /** Responses carrying a final score — the denominator of `mean_points`. */
  scored_count: number;
  /** Responses answered but not yet scored (a proposal is not a score). */
  unscored_count: number;
  /** Mean FINAL points over `scored_count`, or null when nothing is scored. */
  mean_points: number | null;
  /** mean_points / max_points as a whole percentage (the p-value); null as above. */
  p_value: number | null;
  /** Per-choice counts with the key marked; null for non-multiple-choice items. */
  choices: ChoiceTally[] | null;
}

function selectedChoiceIds(response: Record<string, unknown> | null): string[] {
  if (!response) return [];
  if (typeof response.choice_id === "string") return [response.choice_id];
  if (Array.isArray(response.choice_ids)) {
    return response.choice_ids.filter((v): v is string => typeof v === "string");
  }
  return [];
}

const MC_TYPES = new Set(["multiple_choice_single", "multiple_choice_multi"]);

/**
 * @param submittedCount how many submitted attempts the rows came from — the
 *   denominator for "% answered". Passed in rather than inferred, because an
 *   attempt that answered nothing contributes no rows at all and would
 *   otherwise vanish from the denominator.
 */
export function buildItemAnalytics(
  items: AnalyticsItem[],
  rows: AnalyticsResponseRow[],
  submittedCount: number,
): ItemAnalytics[] {
  const byItem = new Map<string, AnalyticsResponseRow[]>();
  for (const row of rows) {
    const list = byItem.get(row.item_id);
    if (list) list.push(row);
    else byItem.set(row.item_id, [row]);
  }

  return items.map((item) => {
    const itemRows = byItem.get(item.id) ?? [];
    const scored = itemRows.filter((r) => r.points !== null);
    const sum = scored.reduce((s, r) => s + (r.points ?? 0), 0);
    const mean = scored.length > 0 ? sum / scored.length : null;

    let choices: ChoiceTally[] | null = null;
    if (MC_TYPES.has(item.type) && item.choices && item.choices.length > 0) {
      const key = new Set(item.correct_choice_ids ?? []);
      const counts = new Map<string, number>();
      for (const row of itemRows) {
        for (const id of selectedChoiceIds(row.response)) {
          counts.set(id, (counts.get(id) ?? 0) + 1);
        }
      }
      choices = item.choices.map((c) => ({
        id: c.id,
        text: c.text,
        count: counts.get(c.id) ?? 0,
        is_key: key.has(c.id),
      }));
    }

    return {
      item_id: item.id,
      position: item.position,
      type: item.type,
      max_points: item.max_points,
      answered_count: itemRows.length,
      answered_percent:
        submittedCount > 0 ? Math.round((100 * itemRows.length) / submittedCount) : null,
      scored_count: scored.length,
      unscored_count: itemRows.length - scored.length,
      mean_points: mean,
      p_value:
        mean !== null && item.max_points > 0
          ? Math.round((100 * mean) / item.max_points)
          : null,
      choices,
    };
  });
}

/** "1.4" / "2" — a mean, short enough for a table cell. */
export function formatMean(mean: number | null): string {
  if (mean === null) return "—";
  return Number.isInteger(mean) ? String(mean) : mean.toFixed(1);
}

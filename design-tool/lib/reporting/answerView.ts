// R1 (docs/reporting-design.md): one student's answer, described in the words
// the item itself uses.
//
// The review queue renders raw ids ("Selected: c2", "Order: e3 → e1") because
// it is a triage list. A per-student report is read instead of the paper, so
// the same response is resolved against the item: choice TEXT, the pair a
// student actually made, the order they put the entries in — with a ✓ / ✗
// where the item carries a key.
//
// Pure: item + response in, a description out. The page decides how to draw
// it; the print view (R2) can draw the same description differently.

import type { MatchPair, SequenceEntry } from "@secure-test/schema";

export interface AnswerViewItem {
  type: string;
  choices?: Array<{ id: string; text: string }>;
  correct_choice_ids?: string[];
  correct_answer?: string | null;
  config: {
    pairs?: MatchPair[];
    sequence?: SequenceEntry[];
    correct_region_ids?: string[];
  };
}

/** A line of the answer, with correctness when — and only when — a key exists. */
export interface AnswerLine {
  text: string;
  correct: boolean | null;
}

export type AnswerView =
  /** Free text: essay, short text. Rendered in a block that keeps newlines. */
  | { kind: "text"; text: string; expected: string | null }
  /** One line per selection / pair / entry / region. */
  | { kind: "lines"; lines: AnswerLine[] }
  /** The bytes live behind the owner-scoped upload route; the page renders it. */
  | { kind: "drawing" }
  /** The page draws the grid from the item's columns/rows (queue's tableGrid). */
  | { kind: "table" }
  /** No response row: the student never answered this item. */
  | { kind: "none" };

function labelFor(choices: Array<{ id: string; text: string }> | undefined, id: string): string {
  const choice = choices?.find((c) => c.id === id);
  return choice ? choice.text : id;
}

export function describeAnswer(
  item: AnswerViewItem,
  response: Record<string, unknown> | null | undefined,
): AnswerView {
  if (!response) return { kind: "none" };

  switch (response.type) {
    case "essay":
    case "short_text":
      return {
        kind: "text",
        text: typeof response.text === "string" ? response.text : "",
        // A short_text key is the teacher's expected answer; an essay has none.
        expected: typeof item.correct_answer === "string" ? item.correct_answer : null,
      };

    case "multiple_choice_single":
    case "multiple_choice_multi": {
      const key = item.correct_choice_ids ?? [];
      const hasKey = key.length > 0;
      const ids =
        typeof response.choice_id === "string"
          ? [response.choice_id]
          : Array.isArray(response.choice_ids)
            ? response.choice_ids.filter((v): v is string => typeof v === "string")
            : [];
      return {
        kind: "lines",
        lines: ids.map((id) => ({
          text: labelFor(item.choices, id),
          correct: hasKey ? key.includes(id) : null,
        })),
      };
    }

    case "match": {
      const pairs = item.config.pairs ?? [];
      const matches = (response.matches ?? {}) as Record<string, unknown>;
      // A response maps a pair id (its LEFT) to the pair id whose RIGHT the
      // student put beside it; matching a pair to itself is correct.
      return {
        kind: "lines",
        lines: Object.entries(matches).map(([leftId, rightId]) => {
          const left = pairs.find((p) => p.id === leftId);
          const right = pairs.find((p) => p.id === rightId);
          return {
            text: `${left?.left ?? leftId} → ${right?.right ?? String(rightId)}`,
            correct: pairs.length > 0 ? leftId === rightId : null,
          };
        }),
      };
    }

    case "order": {
      const sequence = item.config.sequence ?? [];
      const ordered = Array.isArray(response.ordered_ids)
        ? response.ordered_ids.filter((v): v is string => typeof v === "string")
        : [];
      return {
        kind: "lines",
        lines: ordered.map((id, index) => ({
          text: `${index + 1}. ${sequence.find((e) => e.id === id)?.label ?? id}`,
          // The authored sequence IS the key: position n must hold entry n.
          correct: sequence.length > 0 ? sequence[index]?.id === id : null,
        })),
      };
    }

    case "hotspot": {
      const key = item.config.correct_region_ids ?? [];
      const ids = Array.isArray(response.region_ids)
        ? response.region_ids.filter((v): v is string => typeof v === "string")
        : [];
      return {
        kind: "lines",
        lines: ids.map((id) => ({
          text: `Region ${id}`,
          correct: key.length > 0 ? key.includes(id) : null,
        })),
      };
    }

    case "drawing_upload":
      return { kind: "drawing" };

    case "table":
      return { kind: "table" };

    default:
      // A response type this build does not know (an older row, a newer
      // client): show that something was saved rather than nothing at all.
      return { kind: "lines", lines: [{ text: "Answer saved", correct: null }] };
  }
}

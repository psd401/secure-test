import type { ItemType } from "@/db/schema";
import { FILL_BLANK_SEED_STEM } from "@/lib/items/fillBlankEditor";

/**
 * R-6 (docs/editor-redesign-design.md, Phase 4 slice B): the "+" / "/"
 * insertion menu leads with six common types and keeps the rest under
 * "More types". Typed as `ItemType` so a misspelt name fails typecheck, and
 * test/authoring-outline.test.ts checks the two lists cover every type once.
 *
 * The six are a judgement (the four types the CSV template covers, plus the
 * two most-used structured types), not a measured ranking; reorder freely.
 */
export const INSERT_MENU_COMMON: readonly ItemType[] = [
  "multiple_choice_single",
  "multiple_choice_multi",
  "short_text",
  "essay",
  "fill_blank",
  "match",
];

export const INSERT_MENU_MORE: readonly ItemType[] = ["order", "table", "hotspot", "drawing_upload", "graph"];

/** Type-to-filter in the menu: every type whose label (or type name) contains the query. */
export function filterInsertTypes(
  query: string,
  label: (t: ItemType) => string,
): ItemType[] {
  const q = query.trim().toLowerCase();
  const all = [...INSERT_MENU_COMMON, ...INSERT_MENU_MORE];
  if (!q) return all;
  return all.filter((t) => label(t).toLowerCase().includes(q) || t.replace(/_/g, " ").includes(q));
}

/**
 * UX3-1: a new question in the new editor starts EMPTY — no "New question",
 * no "Choice A" — and the fields show placeholders instead. These are the
 * only values it starts with beyond the editor's empty per-type defaults,
 * because the item write boundary (lib/api/items.ts) requires them:
 * matching needs two complete pairs, ordering two named steps, a table named
 * headings, and fill-in-the-blank a stem carrying its first blank's marker.
 * Readiness flags each as placeholder content, as it does today.
 */
export function newItemSeed(type: ItemType): Record<string, unknown> {
  switch (type) {
    case "match":
      return {
        pairs: [
          { id: "p1", left: "Left A", right: "Right A" },
          { id: "p2", left: "Left B", right: "Right B" },
        ],
      };
    case "order":
      return {
        sequence: [
          { id: "s1", label: "First step" },
          { id: "s2", label: "Second step" },
        ],
      };
    case "table":
      return {
        columns: [
          { id: "c1", label: "Column A" },
          { id: "c2", label: "Column B" },
        ],
        rows: [
          { id: "r1", label: "Row 1" },
          { id: "r2", label: "Row 2" },
        ],
      };
    case "fill_blank":
      return { stem: FILL_BLANK_SEED_STEM };
    default:
      return {};
  }
}

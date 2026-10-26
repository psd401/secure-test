import type { ItemType } from "@/db/schema";

/**
 * Phase 3 slice B (R-4, docs/editor-redesign-design.md): the item types whose
 * stem (and choices) use the new WYSIWYG field when the R-12 flag is on.
 * Phase 4 slice C extended it to every item type: the stem is the field
 * (fill-in-the-blank adds "Insert blank" to it); each type's own panel below
 * the stem (pairs, steps, table, hotspots, graph, rubric, blanks) is the
 * existing sub-editor, reused unchanged inside the new card.
 *
 * Typed as `ItemType` so a misspelt type name fails `bun run typecheck`
 * rather than silently leaving that type on the old field.
 */
export const RICH_TEXT_TYPES: ReadonlySet<ItemType> = new Set<ItemType>([
  "multiple_choice_single",
  "multiple_choice_multi",
  "short_text",
  "essay",
  "match",
  "order",
  "hotspot",
  "drawing_upload",
  "table",
  "fill_blank",
  "graph",
]);

export function usesRichTextField(type: string): boolean {
  return (RICH_TEXT_TYPES as ReadonlySet<string>).has(type);
}

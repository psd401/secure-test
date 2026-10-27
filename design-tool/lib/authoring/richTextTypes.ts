import type { ItemType } from "@/db/schema";

/**
 * Phase 3 slice B (R-4, docs/editor-redesign-design.md): the item types whose
 * stem (and choices) use the new WYSIWYG field when the R-12 flag is on.
 * Every other type keeps the textarea.
 *
 * Typed as `ItemType` so a misspelt type name fails `bun run typecheck`
 * rather than silently leaving that type on the old field.
 */
export const RICH_TEXT_TYPES: ReadonlySet<ItemType> = new Set<ItemType>([
  "multiple_choice_single",
  "multiple_choice_multi",
  "short_text",
]);

export function usesRichTextField(type: string): boolean {
  return (RICH_TEXT_TYPES as ReadonlySet<string>).has(type);
}

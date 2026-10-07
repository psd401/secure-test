import type { ItemType } from "@/db/schema";

/** The editor's teacher-facing name for each item type (its type select,
 *  question cards and the PDF import's proposal cards). */
export const ITEM_TYPE_LABEL: Record<ItemType, string> = {
  multiple_choice_single: "Multiple choice",
  multiple_choice_multi: "Multiple select",
  short_text: "Short answer",
  essay: "Essay",
  match: "Matching",
  order: "Ordering",
  hotspot: "Click the image",
  drawing_upload: "Drawing",
  table: "Table",
  // FB D-10: the teacher-facing name.
  fill_blank: "Fill in the blank",
};

/** Label for a type string that may not be a known type (model output). */
export function itemTypeName(type: string): string {
  return (ITEM_TYPE_LABEL as Record<string, string>)[type] ?? type.replace(/_/g, " ");
}

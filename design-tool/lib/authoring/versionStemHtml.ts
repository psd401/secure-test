import { FILL_BLANK_MARKER_RE } from "@secure-test/schema";
import type { ItemSnapshotContent } from "@/db/schema";
import { renderAroundBlanks } from "@/lib/items/renderAroundBlanks";
import { renderItemContent, type ResolvedAsset } from "@/lib/items/renderItemContent";

/**
 * R-5, History view: a version's question text as the teacher wrote it to
 * look (bold, italic, math, pictures), not its markup. The same server
 * renderer as the editor's live preview (renderItemContent escapes its own
 * text). A fill-in-the-blank stem shows each of its blanks as a numbered gap,
 * as the static preview does; a marker naming no blank stays literal text.
 */
export function versionStemHtml(
  content: Pick<ItemSnapshotContent, "type" | "stem" | "config">,
  resolved: Map<string, ResolvedAsset>,
): string {
  const stem = content.stem ?? "";
  if (content.type !== "fill_blank") return renderItemContent(stem, resolved);
  const ids = new Set((content.config?.blanks ?? []).map((b) => b.id));
  const seen = new Set<string>();
  const texts: string[] = [];
  const slots: string[] = [];
  let last = 0;
  for (const m of stem.matchAll(FILL_BLANK_MARKER_RE)) {
    const id = m[1]!;
    if (!ids.has(id) || seen.has(id)) continue;
    seen.add(id);
    texts.push(stem.slice(last, m.index));
    last = m.index! + m[0].length;
    slots.push(`<span aria-label="Blank ${seen.size}">[${seen.size}] ____</span>`);
  }
  texts.push(stem.slice(last));
  return renderAroundBlanks(texts, slots, resolved);
}

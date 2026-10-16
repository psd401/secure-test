// G-1 (docs/coteacher-gaps-2026-10-design.md, D-1): images reach teaching staff
// through the ASSESSMENT, not through the per-teacher asset shelf.
// `/api/assets/[id]` needs `own` on the asset, so a co-teacher (any grant
// level) got a broken image wherever the owner's picture appeared. Readers
// that render an assessment's content for staff resolve `asset:<uuid>` refs
// under the assessment's OWNER (the preview's and the student bundle's rule)
// and point `<img>` at `/api/assessments/<id>/assets/<assetId>`, which opens at
// `view` on the assessment for the assets that assessment references.
//
// "Referenced" is the preview's set (decision 2.3, 2026-10-16): stems, choices,
// set introductions and sources, and the hotspot / drawing images in an item's
// config.

import { and, eq, inArray } from "drizzle-orm";
import type { getDb } from "@/db/client";
import { assets, item_sets, items } from "@/db/schema";
import {
  assetIdsFromItemConfig,
  extractAssetRefsFromMany,
} from "@/lib/items/extractAssetRefs";
import type { ResolvedAsset } from "@/lib/items/renderItemContent";
import { assessmentAssetUrl } from "@/lib/assets/assessmentAssetUrl";

type Db = ReturnType<typeof getDb>;

export { assessmentAssetUrl };

interface RefItem {
  stem: string;
  choices: unknown;
  config: { image_asset_id?: string | null; prompt_asset_id?: string | null } | null;
}

interface RefSet {
  stimulus_text: string;
  sources: readonly { text: string }[] | null;
}

/** Every asset id the preview's set of fields references, lower-cased. */
export function assetRefsInContent(
  itemRows: readonly RefItem[],
  sets: readonly RefSet[],
): string[] {
  const texts: string[] = [];
  for (const s of sets) {
    texts.push(s.stimulus_text);
    for (const src of s.sources ?? []) texts.push(src.text);
  }
  for (const item of itemRows) {
    texts.push(item.stem);
    const choices = Array.isArray(item.choices)
      ? (item.choices as { text?: unknown }[])
      : [];
    for (const c of choices) if (typeof c.text === "string") texts.push(c.text);
  }
  return [
    ...new Set([
      ...extractAssetRefsFromMany(texts),
      ...itemRows.flatMap((r) => assetIdsFromItemConfig(r.config)),
    ]),
  ];
}

/** The asset ids an assessment references, read from its items and sets. */
export async function referencedAssetIds(
  db: Db,
  assessmentId: string,
): Promise<Set<string>> {
  const itemRows = await db
    .select({ stem: items.stem, choices: items.choices, config: items.config })
    .from(items)
    .where(eq(items.assessment_id, assessmentId));
  const setRows = await db
    .select({ stimulus_text: item_sets.stimulus_text, sources: item_sets.sources })
    .from(item_sets)
    .where(eq(item_sets.assessment_id, assessmentId));
  return new Set(assetRefsInContent(itemRows, setRows));
}

/**
 * Resolve refs under the assessment's owner and give each the scoped URL.
 * Refs to assets the owner does not hold fall out of the map and render as the
 * `[image not found]` placeholder, as before.
 */
export async function resolveAssessmentAssets(
  db: Db,
  assessment: { id: string; owner_sub: string },
  refIds: readonly string[],
): Promise<Map<string, ResolvedAsset>> {
  const resolved = new Map<string, ResolvedAsset>();
  if (refIds.length === 0) return resolved;
  const rows = await db
    .select({ id: assets.id, content_type: assets.content_type })
    .from(assets)
    .where(and(eq(assets.owner_sub, assessment.owner_sub), inArray(assets.id, [...refIds])));
  for (const r of rows) {
    resolved.set(r.id.toLowerCase(), {
      id: r.id,
      content_type: r.content_type,
      url: assessmentAssetUrl(assessment.id, r.id),
    });
  }
  return resolved;
}

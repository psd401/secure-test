import { and, eq, inArray } from "drizzle-orm";
import type { BundleAsset } from "@secure-test/schema";
import { assets, type ItemRow } from "@/db/schema";
import type { getDb } from "@/db/client";
import {
  assetIdsFromItemConfig,
  extractAssetRefsFromMany,
} from "@/lib/items/extractAssetRefs";
import { getStorageProviderById } from "@/lib/storage/provider";

type Db = ReturnType<typeof getDb>;

/**
 * Slice 51: extracted from the export route so the teacher export bundle and
 * the student delivery bundle resolve `asset:<uuid>` refs identically. Both
 * audiences need the same bytes; only the answer keys differ between them.
 *
 * Ownership scoping is a parameter rather than a session read because the two
 * callers derive the owner differently: /export scopes to the requesting
 * teacher's sub, /delivery has no session and scopes to the assessment row's
 * owner_sub. Refs to assets the owner doesn't hold simply don't get bundled
 * and remain as raw `asset:<uuid>` text in the stem (offline consumers render
 * a missing-image placeholder).
 */
export type BundledAssets = {
  // Undefined when the items carry no resolvable refs at all, so bundles
  // without images stay byte-stable and omit the key entirely.
  assets: Record<string, BundleAsset> | undefined;
  count: number;
};

export async function collectBundleAssets(
  db: Db,
  ownerSub: string,
  itemRows: readonly ItemRow[],
  /** E5 slice 1: stimulus texts carry the same `asset:` refs as stems. */
  extraTexts: readonly string[] = [],
): Promise<BundledAssets> {
  const textsToScan: string[] = [...extraTexts];
  for (const row of itemRows) {
    textsToScan.push(row.stem);
    const choices = Array.isArray(row.choices)
      ? (row.choices as { id: string; text: string }[])
      : [];
    for (const c of choices) textsToScan.push(c.text);
  }
  // Hotspot images + drawing reference images ride the same bundling as stem
  // refs. assetIdsFromItemConfig drops non-uuid refs so the uuid-column query
  // below can't 22P02 on a forged/imported value.
  const refIds = [
    ...new Set([
      ...extractAssetRefsFromMany(textsToScan),
      ...itemRows.flatMap((row) => assetIdsFromItemConfig(row.config)),
    ]),
  ];
  if (refIds.length === 0) return { assets: undefined, count: 0 };

  const ownedAssetRows = await db
    .select()
    .from(assets)
    .where(and(eq(assets.owner_sub, ownerSub), inArray(assets.id, refIds)));
  if (ownedAssetRows.length === 0) return { assets: undefined, count: 0 };

  // Defined (possibly empty) from here on: matching the pre-extraction
  // behaviour, a bundle whose every asset read failed still emits `assets: {}`
  // rather than dropping the key, so the x-bundled-asset-count discrepancy is
  // visible rather than looking like an image-free bundle.
  const out: Record<string, BundleAsset> = {};
  let count = 0;
  for (const a of ownedAssetRows) {
    try {
      // Route by each asset's persisted provider so a mixed local-fs / s3
      // window reads correctly during an S3 migration (ADR 0008).
      const provider = getStorageProviderById(a.storage_provider);
      const bytes = await provider.get(a.storage_key);
      // Buffer.from(...).toString("base64") is correct here; the bytes came
      // from a trusted storage provider, not a Web ReadableStream.
      out[a.id.toLowerCase()] = {
        content_type: a.content_type,
        base64: Buffer.from(bytes).toString("base64"),
      };
      count += 1;
    } catch (err) {
      // Storage miss: skip the asset rather than failing the whole bundle.
      console.warn(
        `bundleAssets: storage miss for asset ${a.id}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return { assets: out, count };
}

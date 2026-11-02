// U-25 slice 4 (docs/google-docs-whole-test-design.md §Images): the pictures
// a whole-test Doc embeds. Our image URLs need a staff sign-in, so Google
// cannot fetch them; each picture goes into the uploaded HTML as a `data:`
// URI. Drive's multipart upload takes at most 5 MB, so pictures are added in
// document order until the HTML would pass DOC_HTML_BUDGET, and the rest are
// marked PICTURE_TOO_LARGE (a line of text in the Doc).

import { and, eq, inArray } from "drizzle-orm";
import type { getDb } from "@/db/client";
import { assets } from "@/db/schema";
import { loadUploadForItemIds } from "@/lib/api/responseUploads";
import { getStorageProviderById } from "@/lib/storage/provider";
import { PICTURE_TOO_LARGE } from "@/lib/googleDocs/content";

type Db = ReturnType<typeof getDb>;

/** Under Drive's 5 MB multipart limit, with room for the multipart framing. */
export const DOC_HTML_BUDGET = 4.5 * 1024 * 1024;

/** What Docs' HTML import is known to show; anything else stays text. */
const EMBEDDABLE = new Set(["image/png", "image/jpeg", "image/gif"]);

export function dataUri(contentType: string, bytes: Uint8Array): string {
  return `data:${contentType};base64,${Buffer.from(bytes).toString("base64")}`;
}

/**
 * Pure: which pictures fit. `keys` in document order; `uris` the readable
 * ones. A picture that does not fit is marked too large and later ones are
 * still tried (a small picture after a big one may fit). An unreadable key
 * is left out of the map, so it reads "[Picture]".
 */
export function fitPictures(
  baseLength: number,
  keys: readonly string[],
  uris: ReadonlyMap<string, string>,
  budget: number = DOC_HTML_BUDGET,
): Map<string, string> {
  const out = new Map<string, string>();
  let used = baseLength;
  for (const key of keys) {
    const uri = uris.get(key);
    if (!uri) continue;
    if (used + uri.length > budget) {
      out.set(key, PICTURE_TOO_LARGE);
      continue;
    }
    used += uri.length;
    out.set(key, uri);
  }
  return out;
}

/**
 * Reads pictures as `data:` URIs, once each per send. An asset is the
 * assessment owner's (the asset layer's scope, as on every reader); an
 * upload is a drawing, found through the response it belongs to. A picture
 * that cannot be read, or is not an embeddable type, comes back null.
 */
export function createPictureLoader(
  db: Db,
  assessment: { owner_sub: string },
  responsesById: ReadonlyMap<string, { attempt_id: string; item_id: string }>,
) {
  const cache = new Map<string, Promise<string | null>>();

  async function readAsset(id: string): Promise<string | null> {
    const [row] = await db
      .select()
      .from(assets)
      .where(and(eq(assets.owner_sub, assessment.owner_sub), inArray(assets.id, [id])))
      .limit(1);
    if (!row || !EMBEDDABLE.has(row.content_type)) return null;
    const bytes = await getStorageProviderById(row.storage_provider).get(row.storage_key);
    return dataUri(row.content_type, bytes);
  }

  async function readUpload(responseId: string, uploadId: string): Promise<string | null> {
    const resp = responsesById.get(responseId);
    if (!resp) return null;
    const upload = await loadUploadForItemIds(db, resp.attempt_id, resp.item_id, uploadId);
    if (!upload || upload.status !== "complete" || !EMBEDDABLE.has(upload.content_type)) return null;
    const bytes = await getStorageProviderById(upload.storage_provider).get(upload.storage_key);
    return dataUri(upload.content_type, bytes);
  }

  /** `key` is a `pictureKey`; uploads also need their upload id. */
  return function load(key: string, uploadId?: string): Promise<string | null> {
    let p = cache.get(key);
    if (!p) {
      const [kind, id] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
      p = (kind === "asset" ? readAsset(id) : uploadId ? readUpload(id, uploadId) : Promise.resolve(null)).catch(
        () => null,
      );
      cache.set(key, p);
    }
    return p;
  };
}

import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { response_uploads, type AttemptRow, type ItemRow } from "@/db/schema";
import type { getDb } from "@/db/client";
import { getStorageProvider, getStorageProviderById } from "@/lib/storage/provider";
import type { PresignedUpload } from "@/lib/storage/types";

type Db = ReturnType<typeof getDb>;

/**
 * Slice 65: student file uploads for drawing_upload items.
 *
 * The upload is REGISTERED before the file exists, and the response references
 * the registry row. A client-chosen key would let one student point their
 * answer at another student's file; a server-minted row is bound to exactly one
 * (attempt, item) and can be checked on the way back in.
 */
export const UPLOAD_MAX_BYTES = 20 * 1024 * 1024;
export const UPLOAD_URL_TTL_SECONDS = 15 * 60;

/**
 * What a student may hand in for a drawing item: a photo of paper work, or a
 * scan. Enumerated rather than accepting any image/* because the content type
 * is signed into the S3 URL and then served back to a teacher — an allowlist is
 * the point at which "image" stops meaning "any bytes the client labelled".
 */
export const ALLOWED_UPLOAD_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/heic",
  "application/pdf",
]);

export function isAllowedUploadType(contentType: string): boolean {
  return ALLOWED_UPLOAD_TYPES.has(contentType.trim().toLowerCase());
}

export class UploadTooLargeError extends Error {
  constructor(readonly declaredBytes: number) {
    super(`declared upload of ${declaredBytes} bytes exceeds ${UPLOAD_MAX_BYTES}`);
    this.name = "UploadTooLargeError";
  }
}

/**
 * The size limit is enforced HERE, before a URL exists, because it cannot be
 * enforced afterwards: a presigned PUT can bind an exact Content-Length but not
 * a maximum, and once the URL is handed out the upload never passes through
 * this app again. So the client declares a size, this refuses an oversized
 * declaration, and the signature then holds the client to what it declared.
 */
export async function registerUpload(
  db: Db,
  attempt: AttemptRow,
  item: ItemRow,
  contentType: string,
  contentLength: number,
): Promise<{ uploadId: string; upload: PresignedUpload }> {
  if (!Number.isInteger(contentLength) || contentLength <= 0) {
    throw new UploadTooLargeError(contentLength);
  }
  if (contentLength > UPLOAD_MAX_BYTES) {
    throw new UploadTooLargeError(contentLength);
  }

  const provider = getStorageProvider();
  const storageKey = `responses/${attempt.id}/${item.id}/${randomUUID()}`;

  const [row] = await db
    .insert(response_uploads)
    .values({
      attempt_id: attempt.id,
      item_id: item.id,
      storage_provider: provider.id,
      storage_key: storageKey,
      content_type: contentType,
      status: "pending",
    })
    .returning();
  if (!row) throw new Error("failed to register upload");

  if (provider.presignPut) {
    const upload = await provider.presignPut({
      storage_key: storageKey,
      content_type: contentType,
      content_length: contentLength,
      expires_in_seconds: UPLOAD_URL_TTL_SECONDS,
    });
    return { uploadId: row.id, upload };
  }

  // No presign for this backend (local-fs in development). Route the bytes back
  // through an authenticated app route instead of leaving the feature broken
  // outside production — dev must be able to exercise the same flow.
  return {
    uploadId: row.id,
    upload: {
      url: `/api/attempts/${attempt.id}/responses/${item.id}/upload?upload_id=${row.id}`,
      headers: {
        "content-type": contentType,
        "content-length": String(contentLength),
      },
      direct: false,
      expires_at: new Date(Date.now() + UPLOAD_URL_TTL_SECONDS * 1000).toISOString(),
    },
  };
}

/**
 * A registry row that belongs to this exact (attempt, item). Scoping the lookup
 * rather than fetching by id alone is what stops a student referencing an
 * upload slot minted for somebody else's attempt.
 */
export async function loadUploadForItem(
  db: Db,
  attempt: AttemptRow,
  item: ItemRow,
  uploadId: string,
) {
  return loadUploadForItemIds(db, attempt.id, item.id, uploadId);
}

/**
 * The same lookup by ids, for callers that hold an attempt id rather than the
 * row (P-1: the delivery bundle reads back the drawing a saved response names,
 * and never loads the attempt itself). Kept as one query rather than two so the
 * (attempt, item) scoping — the thing that stops a student's answer pointing at
 * somebody else's file — cannot drift between the two entry points.
 */
export async function loadUploadForItemIds(
  db: Db,
  attemptId: string,
  itemId: string,
  uploadId: string,
) {
  const [row] = await db
    .select()
    .from(response_uploads)
    .where(
      and(
        eq(response_uploads.id, uploadId),
        eq(response_uploads.attempt_id, attemptId),
        eq(response_uploads.item_id, itemId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Slice 73: delete the upload slots for this (attempt, item) other than the one
 * being kept, and their bytes with them.
 *
 * Without this, a student who redraws three times leaves three files in storage
 * forever, two of them referenced by nothing. That is not an access-control
 * problem — the bytes were always their own — but it is student work
 * accumulating with no retention policy, which is squarely docs/plan.md risk #4
 * (FERPA scope with minors). Nobody would have gone looking for it, because
 * nothing in the product ever lists it.
 *
 * Storage deletion is best-effort and the row goes regardless. A storage miss
 * would otherwise leave the registry pointing at bytes that may or may not
 * exist, which is a worse state than an orphaned object: at least an orphan is
 * findable by a lifecycle rule.
 */
export async function pruneSupersededUploads(
  db: Db,
  attemptId: string,
  itemId: string,
  keepUploadId: string | null,
): Promise<number> {
  const doomed = await db
    .select()
    .from(response_uploads)
    .where(
      and(
        eq(response_uploads.attempt_id, attemptId),
        eq(response_uploads.item_id, itemId),
      ),
    );

  let removed = 0;
  for (const row of doomed) {
    if (keepUploadId !== null && row.id === keepUploadId) continue;
    try {
      await getStorageProviderById(row.storage_provider).delete(row.storage_key);
    } catch (err) {
      console.warn(
        `uploads: could not delete ${row.storage_key}:`,
        err instanceof Error ? err.message : err,
      );
    }
    await db.delete(response_uploads).where(eq(response_uploads.id, row.id));
    removed += 1;
  }
  return removed;
}

/**
 * Finding 10.10 (2026-08-29): on the presigned path the bytes go straight to
 * the backend and nothing in this app sees them land, so a slot registered
 * for a direct upload stays `pending` forever and every response naming it is
 * refused `upload_incomplete` — the drawing is in S3 and the answer is lost.
 * The proxied `…/upload` route marks its own slot complete; this settles the
 * other kind by asking the provider whether the object is there. Returns the
 * row as it now stands. A provider without `head` cannot settle anything and
 * the row comes back unchanged, which is the pre-existing behaviour.
 */
export async function settlePendingUpload(
  db: Db,
  upload: typeof response_uploads.$inferSelect,
): Promise<typeof response_uploads.$inferSelect> {
  if (upload.status !== "pending") return upload;
  const provider = getStorageProviderById(upload.storage_provider);
  if (!provider.head) return upload;
  const stored = await provider.head(upload.storage_key);
  if (!stored || stored.size <= 0) return upload;
  await markUploadComplete(db, upload.id);
  return { ...upload, status: "complete" };
}

export async function markUploadComplete(db: Db, uploadId: string) {
  await db
    .update(response_uploads)
    .set({ status: "complete", updated_at: new Date() })
    .where(eq(response_uploads.id, uploadId));
}

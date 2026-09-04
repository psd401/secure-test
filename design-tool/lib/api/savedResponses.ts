import { eq } from "drizzle-orm";
import {
  ItemResponseSchema,
  type BundleAsset,
  type DeliverySavedResponses,
  type DeliverySavedUploads,
} from "@secure-test/schema";
import { responses, type ItemRow } from "@/db/schema";
import type { getDb } from "@/db/client";
import { sealResponseIds } from "@/lib/api/studentAttempt";
import { loadUploadForItemIds } from "@/lib/api/responseUploads";
import { getStorageProviderById } from "@/lib/storage/provider";

type Db = ReturnType<typeof getDb>;

/**
 * P-1 (docs/resume-prefill-design.md): what this attempt has already answered,
 * and the answers themselves, for the delivery bundle.
 *
 * The 2026-09-03 sitting is why this exists: the page strip's answered marks
 * were right and the fields under them were empty, so the student read a green
 * check over an empty box as a lost answer and typed it again.
 *
 * D-4: the marks, the values and the drawing bytes all come out of ONE query in
 * one pass, so a mark can never arrive without its value or a value without its
 * mark. `answered_item_ids` keeps exactly the shape and order it had before
 * this — item order, this assessment's items only (an E12 outline written in
 * place is keyed by another assessment's question and is not a question here).
 */
export type SavedAnswers = {
  answeredItemIds: string[];
  savedResponses: DeliverySavedResponses;
  savedUploads: DeliverySavedUploads;
};

/**
 * D-5: the inline cap for a drawing's bytes. A client-drawn PNG at 800x600 is
 * tens of kilobytes; anything past this is a photo or a scan, and the bundle is
 * not the place to carry it. Over the cap the answer is still listed — the
 * field says saved, without the picture.
 */
export const SAVED_UPLOAD_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Narrower than the upload allowlist (which also takes image/heic and
 * application/pdf): these are the two a canvas can draw straight back from a
 * data URL. The rest are listed without bytes rather than shipped as something
 * the page cannot render.
 */
const INLINE_UPLOAD_TYPES = new Set(["image/png", "image/jpeg"]);

export async function collectSavedAnswers(
  db: Db,
  attemptId: string,
  itemRows: readonly ItemRow[],
): Promise<SavedAnswers> {
  const rows = await db
    .select({ item_id: responses.item_id, response: responses.response })
    .from(responses)
    .where(eq(responses.attempt_id, attemptId));
  const byItem = new Map(rows.map((r) => [r.item_id, r.response]));

  const answeredItemIds: string[] = [];
  const savedResponses: DeliverySavedResponses = {};
  const savedUploads: DeliverySavedUploads = {};

  for (const item of itemRows) {
    const stored = byItem.get(item.id);
    if (stored === undefined) continue;
    // A row exists, so the question is answered — that is true even when the
    // value below turns out to be unusable, and the mark must not disagree
    // with the database because the value did.
    answeredItemIds.push(item.id);

    // The column is jsonb and enforces nothing. Everything the ingest route
    // writes was parsed by this schema on the way in, but a legacy or seeded
    // row that no longer fits must cost one prefilled field, not the whole
    // bundle — a student who cannot open the test is far worse off than one
    // who retypes an answer.
    const parsed = ItemResponseSchema.safeParse(stored);
    if (!parsed.success) {
      console.warn(
        `savedResponses: stored response for item ${item.id} does not parse; not prefilled`,
      );
      continue;
    }

    // Match and order are stored with the authoring ids and shown with the
    // per-attempt sealed ones; without this the values name nothing the page
    // has on screen. Null = nothing survived the item's current options.
    const sealed = sealResponseIds(attemptId, item, parsed.data);
    if (sealed === null) continue;
    savedResponses[item.id] = sealed;

    if (sealed.type === "drawing_upload") {
      const asset = await readSavedUpload(db, attemptId, item.id, sealed.upload_id);
      if (asset) savedUploads[sealed.upload_id] = asset;
    }
  }

  return { answeredItemIds, savedResponses, savedUploads };
}

/**
 * The bytes behind one drawing answer, or null.
 *
 * Null on every ordinary miss — no row, a slot that never received bytes, a
 * type the canvas cannot draw, an object past the cap — and null on a storage
 * or lookup failure too, which is logged rather than thrown: a bundle must not
 * fail because one picture is unreadable (the `bundleAssets` posture).
 *
 * Read-only by design. The ingest route settles a pending slot before it will
 * accept the response, so a slot still pending here is one nothing can vouch
 * for; settling it from a GET would be a write on a read path.
 */
async function readSavedUpload(
  db: Db,
  attemptId: string,
  itemId: string,
  uploadId: string,
): Promise<BundleAsset | null> {
  try {
    // Scoped to this (attempt, item) exactly as the ingest route scopes it, so
    // a response naming somebody else's slot reads back nothing.
    const row = await loadUploadForItemIds(db, attemptId, itemId, uploadId);
    if (!row || row.status !== "complete") return null;

    const contentType = row.content_type.trim().toLowerCase();
    if (!INLINE_UPLOAD_TYPES.has(contentType)) return null;

    const provider = getStorageProviderById(row.storage_provider);
    // Ask the size before pulling the bytes where the backend can answer, so an
    // oversized object is not read into memory only to be dropped.
    if (provider.head) {
      const stored = await provider.head(row.storage_key);
      if (!stored || stored.size > SAVED_UPLOAD_MAX_BYTES) return null;
    }
    const bytes = await provider.get(row.storage_key);
    if (bytes.byteLength > SAVED_UPLOAD_MAX_BYTES) return null;

    return {
      content_type: contentType,
      base64: Buffer.from(bytes).toString("base64"),
    };
  } catch (err) {
    console.warn(
      `savedResponses: could not read upload ${uploadId}:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

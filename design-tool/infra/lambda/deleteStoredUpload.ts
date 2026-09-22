// Practice-sitting sweep (docs/practice-sitting-design.md, D-7 "known gap"):
// deletes the stored bytes behind a `StoredUploadRef` that
// `sweepPracticeSittings` (design-tool/lib/retention/sweep.ts) orphaned when
// it deleted a swept practice attempt's rows.
//
// Deliberately NO `@/lib/storage` import — that module's `s3Provider`
// statically imports `@aws-sdk/s3-request-presigner` for the client-upload
// flow, and this Lambda's bundle keeps every `@aws-sdk/*` package external
// with no guarantee the Node 22 runtime ships that package (it ships
// `@aws-sdk/client-s3`, which is all a plain DeleteObject needs). The
// storage-provider id below is duplicated from
// design-tool/lib/storage/s3Provider.ts's `id: "s3"` for the same reason
// design-tool/lib/api/deleteAttempt.ts avoids the import.
import { DeleteObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import type { StoredUploadRef } from "@/lib/api/deleteAttempt";

const S3_STORAGE_PROVIDER_ID = "s3";

// The one shape response-upload keys are ever written in
// (design-tool/lib/api/responseUploads.ts: `responses/${attempt.id}/${item.id}/${uuid}`).
const UPLOAD_KEY_PREFIX = "responses/";

/** The subset of S3Client this needs, so a test can hand in a fake — mirrors
 * the `S3Like` seam in design-tool/lib/roster/syncHandler.ts. */
export interface DeleteS3Like {
  send(command: DeleteObjectCommand): Promise<unknown>;
}

/**
 * Builds the `deleteStored` callback `sweepPracticeSittings` takes: for an
 * S3-backed upload under `responses/`, issues one `DeleteObjectCommand`; for
 * anything else — a local-fs ref (dev never has ASSET_BUCKET set, but
 * defence in depth), or a key outside `responses/` (should never happen; the
 * bucket grant itself only allows that prefix) — it REJECTS without ever
 * calling S3, so the sweep's best-effort catch counts it as not-deleted
 * instead of silently reporting success.
 */
export function createS3UploadDeleter(
  client: DeleteS3Like | S3Client,
  bucket: string,
): (upload: StoredUploadRef) => Promise<void> {
  return async (upload) => {
    if (upload.storage_provider !== S3_STORAGE_PROVIDER_ID) {
      throw new Error(
        `practice sweep: skipping a non-s3 stored upload (storage_provider "${upload.storage_provider}")`,
      );
    }
    if (!upload.storage_key.startsWith(UPLOAD_KEY_PREFIX)) {
      throw new Error(
        `practice sweep: refusing to delete a key outside "${UPLOAD_KEY_PREFIX}": "${upload.storage_key}"`,
      );
    }
    await (client as DeleteS3Like).send(
      new DeleteObjectCommand({ Bucket: bucket, Key: upload.storage_key }),
    );
  };
}

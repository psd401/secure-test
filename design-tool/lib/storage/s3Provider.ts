import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  type GetObjectCommandOutput,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { StorageProvider } from "./types";

// S3-backed asset storage (ADR 0008). Mirrors the Bedrock client conventions
// (lib/ai/bedrockConverse.ts): a cached client, region from S3_REGION ||
// AWS_REGION || us-west-2, and credentials resolved through the standard AWS
// chain (env keys, AWS_PROFILE, SSO, or an IAM role when deployed) — no env
// pre-check, so failures surface at call time and are wrapped by wrapS3Error.
// The bucket comes from S3_BUCKET; optional SSE-KMS via S3_KMS_KEY_ID. Object
// keys are the asset UUID, matching localFsProvider's storage_key. Slice 30
// keeps the existing server-side put(bytes) flow. Slice 65 adds the presigned
// client→S3 PUT (ADR 0008 10.3); CDN reads (10.4) are still deferred.

const DEFAULT_REGION = "us-west-2";

let cachedClient: S3Client | null = null;
function s3Client(): S3Client {
  if (cachedClient) return cachedClient;
  cachedClient = new S3Client({
    region: process.env.S3_REGION || process.env.AWS_REGION || DEFAULT_REGION,
  });
  return cachedClient;
}

function bucket(): string {
  const b = process.env.S3_BUCKET;
  if (!b) {
    throw new Error(
      "S3_BUCKET is not set but the s3 storage provider was selected. Set " +
        "S3_BUCKET (and optionally S3_REGION / S3_KMS_KEY_ID). See " +
        "docs/adr/0008-storage-abstraction-local-fs-first.md.",
    );
  }
  return b;
}

// AWS SDK service errors carry `$metadata.httpStatusCode` and a `name` ending
// in "Exception". Wrap to a storage_s3_error_<status> shape; any other
// throwable (e.g. the missing-bucket error above) is rethrown unchanged.
function wrapS3Error(err: unknown): never {
  const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata
    ?.httpStatusCode;
  const name = (err as { name?: unknown })?.name;
  const message = (err as { message?: unknown })?.message;
  if (status || (typeof name === "string" && name.endsWith("Exception"))) {
    throw new Error(
      `storage_s3_error_${status ?? "unknown"}: ${
        typeof message === "string" ? message : String(name ?? "unknown")
      }`,
    );
  }
  throw err;
}

export const s3Provider: StorageProvider = {
  id: "s3",

  async put({ id, bytes, content_type }) {
    const Bucket = bucket();
    try {
      await s3Client().send(
        new PutObjectCommand({
          Bucket,
          Key: id,
          Body: bytes,
          ContentType: content_type,
          ...(process.env.S3_KMS_KEY_ID
            ? {
                ServerSideEncryption: "aws:kms",
                SSEKMSKeyId: process.env.S3_KMS_KEY_ID,
              }
            : {}),
        }),
      );
    } catch (err) {
      wrapS3Error(err);
    }
    return { storage_key: id };
  },

  async get(storage_key) {
    const Bucket = bucket();
    let res: GetObjectCommandOutput;
    try {
      res = await s3Client().send(
        new GetObjectCommand({ Bucket, Key: storage_key }),
      );
    } catch (err) {
      wrapS3Error(err);
    }
    if (!res.Body) throw new Error("storage_s3_empty_body");
    // AWS SDK v3's Node streaming body exposes transformToByteArray().
    return res.Body.transformToByteArray();
  },

  async delete(storage_key) {
    const Bucket = bucket();
    try {
      await s3Client().send(
        new DeleteObjectCommand({ Bucket, Key: storage_key }),
      );
    } catch (err) {
      wrapS3Error(err);
    }
  },

  /**
   * Finding 10.10: HeadObject on the key. A 404 (NotFound / NoSuchKey) is the
   * answer "not there", not an error; anything else is wrapped like the other
   * calls so a misconfigured bucket or a denied HEAD surfaces as a 5xx rather
   * than as "no upload".
   */
  async head(storage_key) {
    const Bucket = bucket();
    try {
      const res = await s3Client().send(
        new HeadObjectCommand({ Bucket, Key: storage_key }),
      );
      return { size: res.ContentLength ?? 0 };
    } catch (err) {
      const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata
        ?.httpStatusCode;
      const name = (err as { name?: unknown })?.name;
      if (status === 404 || name === "NotFound" || name === "NoSuchKey") return null;
      wrapS3Error(err);
    }
  },

  /**
   * Slice 65 (ADR 0008 10.3): a direct client→S3 PUT.
   *
   * Content-Type and Content-Length are bound INTO the signature, not merely
   * suggested. A client that sends a different content type, or a different
   * number of bytes than it declared, is rejected by S3 itself — which matters
   * because after this URL is handed out the upload never passes through this
   * app again, so anything not signed here is unenforceable.
   *
   * `content_length` is the client's DECLARED size, not a ceiling. S3 has no
   * way to express a ceiling on a presigned PUT: signing the cap instead (as an
   * earlier version did) demands the client send exactly that many bytes, so no
   * real upload can complete. The size limit is applied by the caller before it
   * reaches here — it refuses an oversized declaration — and the signature then
   * holds the client to what it declared.
   */
  async presignPut({ storage_key, content_type, content_length, expires_in_seconds }) {
    const Bucket = bucket();
    try {
      const command = new PutObjectCommand({
        Bucket,
        Key: storage_key,
        ContentType: content_type,
        ContentLength: content_length,
        ...(process.env.S3_KMS_KEY_ID
          ? {
              ServerSideEncryption: "aws:kms" as const,
              SSEKMSKeyId: process.env.S3_KMS_KEY_ID,
            }
          : {}),
      });
      // The cast is a duplicate-package artifact, not a real incompatibility.
      // bun resolves two copies of the @smithy middleware types — one under
      // client-s3, one under s3-request-presigner — and TypeScript sees the
      // private `handlers` field declared separately in each, so it treats two
      // structurally identical S3Client types as unrelated. Both packages
      // request the same @smithy/types range; pinning it does not collapse the
      // copies. At runtime this is the one client instance the rest of this
      // file already uses.
      const url = await getSignedUrl(
        s3Client() as unknown as Parameters<typeof getSignedUrl>[0],
        command as unknown as Parameters<typeof getSignedUrl>[1],
        { expiresIn: expires_in_seconds },
      );
      return {
        url,
        headers: {
          "content-type": content_type,
          "content-length": String(content_length),
        },
        direct: true,
        expires_at: new Date(Date.now() + expires_in_seconds * 1000).toISOString(),
      };
    } catch (err) {
      wrapS3Error(err);
      throw err;
    }
  },
};

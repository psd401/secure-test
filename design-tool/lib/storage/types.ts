// StorageProvider is the contract for asset persistence. The id field
// identifies the implementation in the assets.storage_provider column so
// future migrations / dual-backend reads know which provider owns a
// given key. Putting + getting + deleting are the entire surface today —
// thumbnails, signed URLs, listing, etc. land alongside the S3 provider
// when that's added.

export interface PutAssetInput {
  /** UUID that the caller wants to use as the storage key. */
  id: string;
  /** Raw bytes to persist. */
  bytes: Uint8Array;
  /** MIME type — used for the filename extension by some impls. */
  content_type: string;
}

/**
 * Slice 65: a browser/client-direct upload target for one storage key.
 *
 * `url` is where the client PUTs the bytes; `headers` are the ones it MUST send
 * for the upload to be accepted (a presigned S3 URL binds Content-Type into the
 * signature, so sending a different one fails at S3 rather than silently
 * storing the wrong thing).
 *
 * `direct` says whether `url` goes straight to object storage or back through
 * this app. It exists so a caller can tell the difference without parsing the
 * URL — the local-fs provider has nothing to presign against and routes uploads
 * back through an authenticated app route instead.
 */
export interface PresignedUpload {
  url: string;
  headers: Record<string, string>;
  direct: boolean;
  expires_at: string;
}

export interface PresignPutInput {
  /** Key to write at; the caller allocates it. */
  storage_key: string;
  content_type: string;
  /**
   * The EXACT size the client says it will upload, in bytes.
   *
   * Not a maximum. S3 signs Content-Length as an exact value, so there is no
   * way to express a ceiling in a presigned PUT — an earlier version signed the
   * cap here and, because the client cannot then send anything else, no upload
   * could ever complete.
   *
   * The cap is applied by the CALLER before it asks for a URL: it refuses an
   * oversized declaration outright, then signs the declared size so the client
   * cannot exceed what it declared. Between the two, the limit holds.
   */
  content_length: number;
  expires_in_seconds: number;
}

export interface StorageProvider {
  /** Stable identifier persisted in assets.storage_provider. */
  readonly id: string;
  put(input: PutAssetInput): Promise<{ storage_key: string }>;
  get(storage_key: string): Promise<Uint8Array>;
  delete(storage_key: string): Promise<void>;
  /**
   * Optional: not every backend can hand out a direct-upload URL. A provider
   * that cannot simply omits this, and the caller falls back to an app route.
   */
  presignPut?(input: PresignPutInput): Promise<PresignedUpload>;
  /**
   * Finding 10.10: on the presigned path the bytes never pass through this
   * app, so the only way to learn that a direct upload landed is to ask the
   * backend. Returns the stored size, or null when nothing is there. Optional
   * for the same reason as `presignPut`: a backend without it simply cannot
   * settle a pending slot, and the slot stays pending.
   */
  head?(storage_key: string): Promise<{ size: number } | null>;
}

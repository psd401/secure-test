import { NextResponse } from "next/server";
import type { AssetRow } from "@/db/schema";
import { getStorageProviderById } from "@/lib/storage/provider";

/**
 * The bytes of one stored asset as an inline image response. Shared by the
 * owner's `/api/assets/[id]` and the assessment-scoped
 * `/api/assessments/[id]/assets/[assetId]` (G-1) so both answer identically.
 */
export async function assetResponse(row: AssetRow): Promise<NextResponse> {
  const provider = getStorageProviderById(row.storage_provider);
  let bytes: Uint8Array;
  try {
    bytes = await provider.get(row.storage_key);
  } catch (err) {
    const message = err instanceof Error ? err.message : "storage_get_failed";
    return NextResponse.json(
      { ok: false, error: "storage_get_failed", detail: message },
      { status: 500 },
    );
  }

  // Slice to a plain ArrayBuffer — Bun's strict types reject the union of
  // ArrayBufferLike (which includes SharedArrayBuffer) as a BlobPart.
  const buf = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  return new NextResponse(new Blob([buf], { type: row.content_type }), {
    status: 200,
    headers: {
      "content-type": row.content_type,
      "content-length": String(row.size_bytes),
      // URL contains a uuid that's only known to staff who can open it;
      // per-browser caching is fine, shared caches are not.
      "cache-control": "private, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}

import { createHash } from "node:crypto";

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

// MIME allow-list. Browser inputs only constrain via the `accept`
// attribute (user can bypass), so the server enforces it again.
//
// `image/svg+xml` is deliberately NOT on this list (phase-1-2 review, finding
// B7). SVG is an active document: it can carry <script> and event handlers,
// and /api/assets/[id] serves stored bytes inline on the app origin with the
// row's own content type. An allowed SVG upload is therefore a stored-XSS
// primitive against the app origin. Raster formats only.
const ALLOWED_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

export function isAllowedImageMime(value: string): boolean {
  return ALLOWED_MIME.has(value);
}

/** Read-only view for callers that need to report what is accepted. */
export const ALLOWED_IMAGE_MIME_TYPES: readonly string[] = [...ALLOWED_MIME];

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

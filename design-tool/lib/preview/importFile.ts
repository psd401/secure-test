// Editor redesign Phase 7 slice C (R-9): the JSON-import preview page's two
// pure helpers (app/dashboard/import/ImportPreviewFlow.tsx), here so they
// test without React.
import type { BundleAsset } from "@secure-test/schema";

/** The page's `?error=` code for a refusal from the preview route. */
export function previewErrorCode(body: unknown): string {
  const b = (body ?? {}) as { error?: unknown; detail?: unknown };
  const error = typeof b.error === "string" ? b.error : "preview_failed";
  if (error === "schema_invalid" && Array.isArray(b.detail) && b.detail[0]) {
    const first = b.detail[0] as { path?: unknown[]; message?: unknown };
    return `schema_invalid:${(first.path ?? []).join(".")}:${String(first.message ?? "")}`;
  }
  return error;
}

/**
 * The file's pictures by id, lower-cased like the asset refs the renderer
 * resolves. Read in this page from the file the teacher chose — they are
 * never sent back by the preview route.
 */
export function picturesFromFile(json: unknown): Record<string, BundleAsset> {
  const assets = (json as { assets?: unknown } | null)?.assets;
  if (!assets || typeof assets !== "object") return {};
  const out: Record<string, BundleAsset> = {};
  for (const [id, a] of Object.entries(assets as Record<string, unknown>)) {
    const asset = a as { content_type?: unknown; base64?: unknown };
    if (typeof asset?.content_type === "string" && typeof asset.base64 === "string") {
      out[id.toLowerCase()] = { content_type: asset.content_type, base64: asset.base64 };
    }
  }
  return out;
}

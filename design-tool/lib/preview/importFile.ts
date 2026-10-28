// Editor redesign Phase 7 slice C (R-9): the JSON-import preview page's two
// pure helpers (app/dashboard/import/ImportPreviewFlow.tsx), here so they
// test without React.
import type { BundleAsset } from "@secure-test/schema";

/** The page's `?error=` code for a refusal from the preview or import route. */
export function previewErrorCode(body: unknown, fallback = "preview_failed"): string {
  const b = (body ?? {}) as { error?: unknown; detail?: unknown };
  const error = typeof b.error === "string" ? b.error : fallback;
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

/**
 * Beta report (2026-10-27): where the import page goes once the chosen file
 * has been posted to POST /api/assessments/import — the new draft, the login
 * page, or back here with the refusal's `?error=` code. The page used to
 * import through a server action, and Next caps a server action's body at
 * 1 MB, so a file with a large picture failed with "This page couldn't load"
 * although the route takes 50 MiB (MAX_IMPORT_BODY_BYTES).
 */
export async function importFileDestination(
  form: FormData,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const back = (code: string) => `/dashboard/import?error=${encodeURIComponent(code)}`;
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) return back("no_file_selected");
  let res: Response;
  try {
    res = await fetchImpl("/api/assessments/import", { method: "POST", body: form });
  } catch {
    return back("read_failed");
  }
  if (res.status === 401) return "/login?next=/dashboard/import";
  // A body cap anywhere on the way (the route's own, or one in front of it
  // that answers without the route's JSON) is still "too large".
  if (res.status === 413) return back("file_too_large");
  const json = (await res.json().catch(() => null)) as { assessment?: { id?: unknown } } | null;
  const id = json?.assessment?.id;
  if (res.ok && typeof id === "string") return `/dashboard/${id}`;
  return back(previewErrorCode(json, "import_failed"));
}

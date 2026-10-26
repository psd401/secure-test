import { NextResponse } from "next/server";
import { ItemBundleSchema, type ItemBundle } from "@secure-test/schema";

// Bumped from 1 MB to 50 MB in slice 15 so bundles carrying multiple
// large images (slice-10 cap is 5 MB per image; 10 images ≈ 50 MB
// base64) round-trip without rejection.
export const MAX_IMPORT_BODY_BYTES = 50 * 1024 * 1024;

/**
 * The JSON-import request body as a parsed ItemBundle: a multipart `file`
 * field or a raw JSON body, size-capped, parsed and schema-checked. Moved
 * unchanged out of POST /api/assessments/import (editor redesign Phase 7
 * slice C) so its preview route (`import/preview`) reads a bundle the same
 * way and refuses the same files with the same codes.
 */
export async function readImportBundle(
  req: Request,
): Promise<{ ok: true; bundle: ItemBundle } | { ok: false; response: NextResponse }> {
  const MAX_BODY_BYTES = MAX_IMPORT_BODY_BYTES;
  const fail = (body: Record<string, unknown>, status: number) => ({
    ok: false as const,
    response: NextResponse.json({ ok: false, ...body }, { status }),
  });
  const contentType = req.headers.get("content-type") ?? "";

  let rawJson: string;
  try {
    if (contentType.includes("multipart/form-data")) {
      const form = await req.formData();
      const file = form.get("file");
      if (!(file instanceof File)) {
        return fail({ error: "missing_file" }, 400);
      }
      if (file.size > MAX_BODY_BYTES) {
        return fail({ error: "file_too_large", limit: MAX_BODY_BYTES }, 413);
      }
      rawJson = await file.text();
    } else {
      const ab = await req.arrayBuffer();
      if (ab.byteLength > MAX_BODY_BYTES) {
        return fail({ error: "body_too_large", limit: MAX_BODY_BYTES }, 413);
      }
      rawJson = new TextDecoder().decode(ab);
    }
  } catch {
    return fail({ error: "read_failed" }, 400);
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawJson);
  } catch {
    return fail({ error: "invalid_json" }, 400);
  }

  const bundleResult = ItemBundleSchema.safeParse(parsedJson);
  if (!bundleResult.success) {
    return fail({ error: "schema_invalid", detail: bundleResult.error.issues.slice(0, 5) }, 400);
  }
  return { ok: true, bundle: bundleResult.data };
}

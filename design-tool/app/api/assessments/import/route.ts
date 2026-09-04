import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { ItemBundleSchema } from "@secure-test/schema";
import { getDb } from "@/db/client";
import { assessments } from "@/db/schema";
import { requireStaff } from "@/lib/api/requireSession";
import {
  importBundleForOwner,
  isImportBundleError,
} from "@/lib/api/importBundle";

// Bumped from 1 MB to 50 MB in slice 15 so bundles carrying multiple
// large images (slice-10 cap is 5 MB per image; 10 images ≈ 50 MB
// base64) round-trip without rejection.
const MAX_BODY_BYTES = 50 * 1024 * 1024;

export async function POST(req: Request) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;

  const contentType = req.headers.get("content-type") ?? "";

  let rawJson: string;
  try {
    if (contentType.includes("multipart/form-data")) {
      const form = await req.formData();
      const file = form.get("file");
      if (!(file instanceof File)) {
        return NextResponse.json(
          { ok: false, error: "missing_file" },
          { status: 400 },
        );
      }
      if (file.size > MAX_BODY_BYTES) {
        return NextResponse.json(
          { ok: false, error: "file_too_large", limit: MAX_BODY_BYTES },
          { status: 413 },
        );
      }
      rawJson = await file.text();
    } else {
      const ab = await req.arrayBuffer();
      if (ab.byteLength > MAX_BODY_BYTES) {
        return NextResponse.json(
          { ok: false, error: "body_too_large", limit: MAX_BODY_BYTES },
          { status: 413 },
        );
      }
      rawJson = new TextDecoder().decode(ab);
    }
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: "read_failed" },
      { status: 400 },
    );
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawJson);
  } catch {
    return NextResponse.json(
      { ok: false, error: "invalid_json" },
      { status: 400 },
    );
  }

  const bundleResult = ItemBundleSchema.safeParse(parsedJson);
  if (!bundleResult.success) {
    return NextResponse.json(
      {
        ok: false,
        error: "schema_invalid",
        detail: bundleResult.error.issues.slice(0, 5),
      },
      { status: 400 },
    );
  }

  // `asset_*` codes are storage/DB failures on OUR side → 5xx. These two are
  // the caller handing us an unacceptable bundle, so they stay 4xx despite the
  // shared prefix.
  const CALLER_FAULT_ASSET_ERRORS = new Set([
    "asset_content_type_not_allowed",
    "asset_base64_invalid",
  ]);

  const result = await importBundleForOwner(bundleResult.data, auth.session.sub);
  if (isImportBundleError(result)) {
    const serverFault =
      result.error.startsWith("asset_") &&
      !CALLER_FAULT_ASSET_ERRORS.has(result.error);
    return NextResponse.json(
      { ok: false, ...result },
      { status: serverFault ? 500 : 400 },
    );
  }

  const db = getDb();
  const [row] = await db
    .select()
    .from(assessments)
    .where(eq(assessments.id, result.assessment_id))
    .limit(1);
  return NextResponse.json(
    {
      assessment: row,
      item_count: result.item_count,
      assets_imported: result.assets_imported,
      // E12 slice 1: set source links dropped for this owner.
      sources_dropped: result.sources_dropped,
      assets_reused: result.assets_reused,
      // Slice 21 counters — let callers detect catalog drift / clamp.
      accommodations_imported: result.accommodations_imported,
      accommodations_dropped: result.accommodations_dropped,
      construct_altering_imported: result.construct_altering_imported,
      construct_altering_dropped: result.construct_altering_dropped,
      // Slice 46: version-skew guard — items with a type this server
      // doesn't handle are skipped per-item, never imported as short_text.
      items_skipped_unknown_type: result.items_skipped_unknown_type,
      scoring_methods_dropped: result.scoring_methods_dropped,
    },
    { status: 201 },
  );
}

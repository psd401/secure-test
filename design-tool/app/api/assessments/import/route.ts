import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { assessments } from "@/db/schema";
import { requireStaff } from "@/lib/api/requireSession";
import { readImportBundle } from "@/lib/api/importBody";
import { normalizeEmail } from "@/lib/roster/queries";
import {
  importBundleForOwner,
  isImportBundleError,
} from "@/lib/api/importBundle";

export async function POST(req: Request) {
  const auth = await requireStaff();
  if (!auth.ok) return auth.response;

  const read = await readImportBundle(req);
  if (!read.ok) return read.response;

  // `asset_*` codes are storage/DB failures on OUR side → 5xx. These two are
  // the caller handing us an unacceptable bundle, so they stay 4xx despite the
  // shared prefix.
  const CALLER_FAULT_ASSET_ERRORS = new Set([
    "asset_content_type_not_allowed",
    "asset_base64_invalid",
  ]);

  // Access slice 2: the new row carries the importer's email so a
  // `teacher`-scoped grant resolves for it (migration 0038).
  const result = await importBundleForOwner(
    read.bundle,
    auth.session.sub,
    normalizeEmail(auth.session.email),
  );
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

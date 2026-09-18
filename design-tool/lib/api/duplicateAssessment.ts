import { eq } from "drizzle-orm";
import type { getDb } from "@/db/client";
import { assessments, type AssessmentRow } from "@/db/schema";
import { buildExportBundle } from "@/lib/api/exportBundle";
import { importBundleForOwner, isImportBundleError } from "@/lib/api/importBundle";

// Duplicate an assessment (2026-09-16, James's decisions).
//
// The copy rides the SAME lossless path staff-to-staff sharing uses
// (buildExportBundle → importBundleForOwner), so items, item sets, sources,
// accommodations, student_layout and asset refs are copied and remapped by
// code that is already exercised rather than by a second, divergent copier.
// The difference from `acceptShare` is only the owner: here the source and
// the copy belong to the same teacher, so `uniqueImportName` sees the source's
// own name as taken and the copy lands as "<name> (copy)", "(copy 2)", …
//
// Four settings do NOT ride the bundle — the wire format has no field for
// them, and import forces `description` to "" — so they are applied to the
// new row afterwards. That update is a SEPARATE statement from the import's
// own transaction: `importBundleForOwner` opens and commits its transaction
// internally and exposes no handle. The window it leaves is a copy that exists
// with default settings for a moment; a crash inside it leaves a valid Draft
// copy carrying no description / time limit / allow flags, which is a visible,
// editable row rather than a corrupt one.
//
// Deliberately NOT carried: per-student overrides, attempts, sittings, shares,
// `status` (the copy is always a Draft) and `archived_at` (the copy is always
// live), so duplicating an archived or published assessment is non-destructive
// and hands the teacher something they can edit.

export type DuplicateAssessmentResult =
  | {
      ok: true;
      assessment_id: string;
      name: string;
      item_count: number;
      assets_reused: number;
      assets_imported: number;
      sources_dropped: number;
    }
  | {
      ok: false;
      status: 409 | 404 | 500;
      error: string;
      item_id?: string;
      detail?: string;
    };

/**
 * Copy one assessment into a new Draft owned by `ownerSub`.
 *
 * The caller has already proved it may read `source` — access slice 1 moved
 * every ownership decision into `authorizeAssessment` (D-3), so this function
 * takes the row rather than re-fetching it under an owner predicate.
 */
export async function duplicateAssessment(
  db: ReturnType<typeof getDb>,
  source: AssessmentRow,
  ownerSub: string,
): Promise<DuplicateAssessmentResult> {
  // Hidden rubrics included: this is the teacher's own copy of their own
  // assessment, so dropping them would lose authoring data and re-clamp
  // ai/hybrid scoring on the copy (see the export route's comment).
  const built = await buildExportBundle(db, source, ownerSub, true);
  if (!built.ok) {
    return {
      ok: false,
      status: built.status,
      error: `source_${built.error}`,
      item_id: built.item_id,
      detail: built.detail,
    };
  }

  const imported = await importBundleForOwner(built.bundle, ownerSub);
  if (isImportBundleError(imported)) {
    return { ok: false, status: 500, error: `copy_${imported.error}` };
  }

  const [copy] = await db
    .update(assessments)
    .set({
      description: source.description,
      time_limit_seconds: source.time_limit_seconds,
      allow_clipboard: source.allow_clipboard,
      allow_llm_authoring: source.allow_llm_authoring,
      updated_at: new Date(),
    })
    .where(eq(assessments.id, imported.assessment_id))
    .returning({ id: assessments.id, name: assessments.name });

  return {
    ok: true,
    assessment_id: imported.assessment_id,
    name: copy?.name ?? built.bundle.title,
    item_count: imported.item_count,
    assets_reused: imported.assets_reused,
    assets_imported: imported.assets_imported,
    sources_dropped: imported.sources_dropped,
  };
}

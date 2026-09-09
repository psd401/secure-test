import { randomUUID, createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import type { ItemBundle, ScoringMethod } from "@secure-test/schema";
import { getDb } from "@/db/client";
import {
  assessments,
  assets,
  items,
  ITEM_TYPES,
  type ItemConfig,
  type ItemType, item_sets } from "@/db/schema";
import { isValidAccommodationId } from "@/lib/accommodations/catalog";
import { assertNever } from "@/lib/assertNever";
import { ALLOWED_SCORING_METHODS } from "@/lib/api/items";
import { SOURCE_ITEM_TYPES } from "@/lib/api/itemSets";
import { isAllowedImageMime } from "@/lib/api/uploads";
import { getStorageProvider } from "@/lib/storage/provider";

// Slice 36: the bundle layer is permissive (wire schema carries any
// scoring_method on any type); import is the chokepoint. Keep the method
// only when it's valid for the type AND, for ai/hybrid, a rubric actually
// came with the item — otherwise drop it and let the type default apply.
function clampScoringMethod(
  type: ItemType,
  method: ScoringMethod | undefined,
  hasRubric: boolean,
): ItemConfig {
  if (!method) return {};
  if (!ALLOWED_SCORING_METHODS[type].includes(method)) return {};
  if ((method === "ai" || method === "hybrid") && !hasRubric) return {};
  return { scoring_method: method };
}

const ASSET_REF_RE =
  /(!\[[^\]]*\]\(asset:)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\))/gi;

// Config asset refs (hotspot image, drawing reference) arrive through the
// permissive wire schema (min(1) string). Anything that isn't uuid-shaped
// is DROPPED at import: stored verbatim it would 400 every later editor
// save (the API requires uuid) and 22P02 the preview/export asset query.
const UUID_ONLY_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function importableConfigAssetId(
  ref: string | null | undefined,
  remap: Map<string, string>,
): string | null {
  if (!ref || !UUID_ONLY_RE.test(ref)) return null;
  return remap.get(ref.toLowerCase()) ?? ref.toLowerCase();
}

function rewriteAssetRefs(text: string, remap: Map<string, string>): string {
  if (!text || remap.size === 0) return text;
  return text.replace(ASSET_REF_RE, (whole, head, uuid, tail) => {
    const lower = (uuid as string).toLowerCase();
    const newId = remap.get(lower);
    return newId ? `${head}${newId}${tail}` : whole;
  });
}

export interface ImportBundleResult {
  /** E12 slice 1: set source links dropped because this owner does not own the source assessment. */
  sources_dropped: number;
  assessment_id: string;
  item_count: number;
  assets_imported: number;
  assets_reused: number;
  // Slice 21: counts surface catalog drift to the caller. `dropped` is
  // IDs that didn't validate against the current catalog (older bundles
  // or bundles authored against a different catalog version).
  accommodations_imported: number;
  accommodations_dropped: number;
  construct_altering_imported: number;
  construct_altering_dropped: number;
  // Slice 46: items whose type this server doesn't handle (version skew —
  // e.g. a bundle from a newer schema) are skipped per-item and reported,
  // never silently imported as short_text.
  items_skipped_unknown_type: number;
  // Review fix (2026-08-14): scoring methods the import clamp dropped
  // (invalid for the type, or ai/hybrid without a rubric) — previously
  // silent, so a teacher believed AI scoring was configured when the item
  // had landed on its default.
  scoring_methods_dropped: number;
}

export interface ImportBundleError {
  error: string;
  detail?: unknown;
  uuid?: string;
}

// Re-uploads any bundled assets into the importing user's account,
// builds an (incoming-uuid → new-uuid) remap, then inserts the
// assessment + items with stems / choice texts rewritten to use the
// new uuids. The asset upload runs OUTSIDE the assessment-insert
// transaction so storage writes happen before the DB commit and a
// late failure doesn't strand half-written rows.
/**
 * 2026-09-02 (rows 23–29 hand-run, finding 2): an imported copy used to keep
 * the original's title verbatim, so the list showed two identical rows.
 * The copy now takes the first free name among `title`, `title (copy)`,
 * `title (copy 2)`, … for THIS owner. Pure; the caller passes the owner's
 * current names.
 */
export function uniqueImportName(existing: readonly string[], title: string): string {
  const taken = new Set(existing);
  if (!taken.has(title)) return title;
  const first = `${title} (copy)`;
  if (!taken.has(first)) return first;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${title} (copy ${n})`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${title} (copy ${Date.now()})`;
}

export async function importBundleForOwner(
  bundle: ItemBundle,
  owner_sub: string,
): Promise<ImportBundleResult | ImportBundleError> {
  const db = getDb();
  const remap = new Map<string, string>();
  let importedAssetCount = 0;
  let reusedAssetCount = 0;

  if (bundle.assets) {
    const provider = getStorageProvider();
    for (const [oldUuid, asset] of Object.entries(bundle.assets)) {
      // A bundle is untrusted input — a teacher-to-teacher file, not something
      // this app produced. The upload route enforces the image MIME allowlist;
      // import did not, so a bundle could declare content_type "text/html"
      // and /api/assets/[id] would then serve attacker HTML inline on the app
      // origin, in the importing teacher's session (phase-1-2 review, B3).
      // Reject rather than coerce: a mislabeled asset is a broken bundle, and
      // silently rewriting the type would serve HTML bytes as a fake PNG.
      if (!isAllowedImageMime(asset.content_type)) {
        return {
          error: "asset_content_type_not_allowed",
          uuid: oldUuid,
          detail: asset.content_type,
        };
      }

      let bytes: Buffer;
      try {
        bytes = Buffer.from(asset.base64, "base64");
      } catch {
        return { error: "asset_base64_invalid", uuid: oldUuid };
      }
      const sha = createHash("sha256").update(bytes).digest("hex");

      // Per-owner dedup against the assets table.
      const existing = await db
        .select()
        .from(assets)
        .where(and(eq(assets.owner_sub, owner_sub), eq(assets.sha256, sha)))
        .limit(1);
      if (existing.length > 0) {
        remap.set(oldUuid.toLowerCase(), existing[0]!.id);
        reusedAssetCount += 1;
        continue;
      }

      const newId = randomUUID();
      try {
        await provider.put({
          id: newId,
          bytes: new Uint8Array(bytes),
          content_type: asset.content_type,
        });
      } catch (err) {
        return {
          error: "asset_storage_put_failed",
          uuid: oldUuid,
          detail: err instanceof Error ? err.message : "unknown",
        };
      }
      try {
        await db.insert(assets).values({
          id: newId,
          owner_sub,
          content_type: asset.content_type,
          size_bytes: bytes.byteLength,
          sha256: sha,
          storage_provider: provider.id,
          storage_key: newId,
          original_filename: null,
        });
      } catch (err) {
        // Best-effort cleanup on a race against another concurrent
        // import of the same bytes — the (owner_sub, sha256) unique
        // index would have fired.
        try { await provider.delete(newId); } catch {}
        return {
          error: "asset_db_insert_failed",
          uuid: oldUuid,
          detail: err instanceof Error ? err.message : "unknown",
        };
      }
      remap.set(oldUuid.toLowerCase(), newId);
      importedAssetCount += 1;
    }
  }

  // Slice 21: validate + clamp accommodations before the insert.
  // - Unknown IDs are dropped (caller surfaces the count); we stay
  //   lenient on inbound to keep round-trips resilient across catalog
  //   revisions.
  // - construct_altering ⊆ allowed_accommodations is enforced by clamp,
  //   matching the API-layer invariant.
  const allowedRaw = bundle.allowed_accommodations ?? [];
  const caRaw = bundle.construct_altering ?? [];
  const allowedValid: string[] = [];
  let accommodationsDropped = 0;
  for (const id of allowedRaw) {
    if (isValidAccommodationId(id)) allowedValid.push(id);
    else accommodationsDropped += 1;
  }
  const allowedSet = new Set(allowedValid);
  const caValid: string[] = [];
  let caDropped = 0;
  for (const id of caRaw) {
    // Drop if catalog doesn't recognise it OR if it isn't in the
    // (clamped) allowed_accommodations set.
    if (isValidAccommodationId(id) && allowedSet.has(id)) caValid.push(id);
    else caDropped += 1;
  }

  // Slice 46: skip-and-report items whose type this server doesn't handle
  // (ItemBundleSchema already rejects types the *schema* doesn't know; this
  // guards the skew where the schema package knows a type this server's
  // import branches don't). The switch below is the compile-time backstop.
  // Review fix (2026-08-14): count what the clamp drops so the report can
  // say so (the same payload POSTed directly would 400 with a clear error).
  let scoringMethodsDropped = 0;
  const clampAndCount = (
    type: ItemType,
    method: ScoringMethod | undefined,
    hasRubric: boolean,
  ): ItemConfig => {
    const clamped = clampScoringMethod(type, method, hasRubric);
    if (method && !clamped.scoring_method) scoringMethodsDropped += 1;
    return clamped;
  };

  const importable: typeof bundle.items = [];
  let skippedUnknownType = 0;
  for (const it of bundle.items) {
    if ((ITEM_TYPES as readonly string[]).includes(it.type)) {
      importable.push(it);
    } else {
      skippedUnknownType += 1;
      console.error(
        `importBundle: skipping item with unknown type "${it.type}"`,
      );
    }
  }

  let sourcesDropped = 0;
  const result = await db.transaction(async (tx) => {
    const existing = await tx
      .select({ name: assessments.name })
      .from(assessments)
      .where(eq(assessments.owner_sub, owner_sub));
    const name = uniqueImportName(
      existing.map((r) => r.name),
      bundle.title || "Imported assessment",
    ).slice(0, 200);
    const [row] = await tx
      .insert(assessments)
      .values({
        owner_sub,
        name,
        description: "",
        allowed_accommodations: allowedValid,
        construct_altering: caValid,
        // Client paging: an older bundle has no field and reads as scroll.
        student_layout: bundle.student_layout ?? "scroll",
      })
      .returning();
    // E5 slice 1: the new item ids come back by position (position = index
    // in `importable`), so a bundle set's item_ids can be remapped below.
    const insertedIds = new Map<number, string>();
    if (importable.length > 0) {
      const inserted = await tx.insert(items).values(
        importable.map((it, idx) => {
          const stem = rewriteAssetRefs(it.stem, remap);
          const base = {
            assessment_id: row!.id,
            position: idx,
            stem,
            // Empty by default; the essay branch overrides (slice 32). Set on
            // every row so the multi-row insert has a uniform column shape.
            config: {} as ItemConfig,
          };
          if (it.type === "multiple_choice_single") {
            return {
              ...base,
              type: it.type,
              choices: it.choices.map((c) => ({
                ...c,
                text: rewriteAssetRefs(c.text, remap),
              })),
              correct_choice_ids: it.correct_choice_id ? [it.correct_choice_id] : [],
              correct_answer: null,
              config: clampAndCount(it.type, it.scoring_method, false),
            };
          }
          if (it.type === "multiple_choice_multi") {
            return {
              ...base,
              type: it.type,
              choices: it.choices.map((c) => ({
                ...c,
                text: rewriteAssetRefs(c.text, remap),
              })),
              correct_choice_ids: it.correct_choice_ids,
              correct_answer: null,
              config: clampAndCount(it.type, it.scoring_method, false),
            };
          }
          if (it.type === "essay") {
            return {
              ...base,
              type: it.type,
              choices: [],
              correct_choice_ids: [],
              correct_answer: null,
              config: {
                ...(it.max_word_count != null
                  ? { max_word_count: it.max_word_count }
                  : {}),
                ...(it.placeholder ? { placeholder: it.placeholder } : {}),
                ...(it.rubric ? { rubric: it.rubric } : {}),
                ...clampAndCount(it.type, it.scoring_method, it.rubric != null),
              },
            };
          }
          if (it.type === "short_text") {
            return {
              ...base,
              type: it.type,
              choices: [],
              correct_choice_ids: [],
              correct_answer: it.correct_answer ?? null,
              config: clampAndCount(it.type, it.scoring_method, false),
            };
          }
          if (it.type === "match") {
            // Slice 47: pairs are plain strings v1 — no asset-ref rewrite.
            return {
              ...base,
              type: it.type,
              choices: [],
              correct_choice_ids: [],
              correct_answer: null,
              config: {
                pairs: it.pairs,
                ...clampAndCount(it.type, it.scoring_method, false),
              },
            };
          }
          if (it.type === "order") {
            // Slice 48: sequence entries are plain strings v1.
            return {
              ...base,
              type: it.type,
              choices: [],
              correct_choice_ids: [],
              correct_answer: null,
              config: {
                sequence: it.sequence,
                ...clampAndCount(it.type, it.scoring_method, false),
              },
            };
          }
          if (it.type === "drawing_upload") {
            // Slice 50: authoring-only; the reference image remaps like the
            // hotspot image. Non-uuid refs are dropped (see
            // importableConfigAssetId).
            const promptId = importableConfigAssetId(it.prompt_asset_id, remap);
            return {
              ...base,
              type: it.type,
              choices: [],
              correct_choice_ids: [],
              correct_answer: null,
              config: {
                ...(promptId ? { prompt_asset_id: promptId } : {}),
                ...(it.canvas ? { canvas: it.canvas } : {}),
                ...clampAndCount(it.type, it.scoring_method, false),
              },
            };
          }
          if (it.type === "hotspot") {
            // Slice 49: the image asset was re-uploaded above (it rides the
            // bundle's assets map) — point config at the importer's copy.
            // An unbundled uuid ref keeps the old id and renders as a
            // missing image, same as stem refs; non-uuid refs are dropped
            // (see importableConfigAssetId).
            const imageId = importableConfigAssetId(it.image_asset_id, remap);
            return {
              ...base,
              type: it.type,
              choices: [],
              correct_choice_ids: [],
              correct_answer: null,
              config: {
                ...(imageId ? { image_asset_id: imageId } : {}),
                regions: it.regions,
                correct_region_ids: it.correct_region_ids,
                ...clampAndCount(it.type, it.scoring_method, false),
              },
            };
          }
          if (it.type === "table") {
            // E3 slice 1: labels are plain strings v1 (KaTeX / emphasis, no
            // asset refs) — no rewrite, same posture as match pairs. Keys
            // ride the teacher bundle and are kept; a keyless table imports
            // as the legal draft it is.
            return {
              ...base,
              type: it.type,
              choices: [],
              correct_choice_ids: [],
              correct_answer: null,
              config: {
                columns: it.columns,
                rows: it.rows,
                ...(it.corner ? { corner: it.corner } : {}),
                ...(it.cell_keys ? { cell_keys: it.cell_keys } : {}),
                ...clampAndCount(it.type, it.scoring_method, false),
              },
            };
          }
          // Slice 46: when the wire schema grows a type, this fails
          // typecheck until an explicit branch above handles it — no more
          // silent import-as-short_text.
          return assertNever(it, "importBundle: unhandled item type");
        }),
      ).returning({ id: items.id, position: items.position });
      for (const r of inserted) insertedIds.set(r.position, r.id);
    }
    // E5 slice 1: recreate the sets on the copy. Bundle item ids → the
    // index in `importable` → the new row id. An item the type-skip above
    // dropped just leaves its set; the survivors stay contiguous because
    // removing an element from a run keeps the rest a run. Stimulus asset
    // refs remap like stem refs.
    if (bundle.item_sets && bundle.item_sets.length > 0) {
      const indexOf = new Map(importable.map((it, idx) => [it.id, idx] as const));
      for (const set of bundle.item_sets) {
        const newIds = set.item_ids
          .map((id) => indexOf.get(id))
          .filter((idx): idx is number => idx !== undefined)
          .map((idx) => insertedIds.get(idx))
          .filter((id): id is string => id !== undefined);
        if (newIds.length === 0) continue;
        // E12 slice 1: keep a set's source link only when THIS owner owns
        // the source assessment and the question is still an allowed type
        // (a copy under another owner, or a stale export, drops it and
        // says so in `sources_dropped`).
        let sourceItemId: string | null = null;
        if (set.source) {
          const [src] = await tx
            .select({ id: items.id, type: items.type, owner_sub: assessments.owner_sub })
            .from(items)
            .innerJoin(assessments, eq(assessments.id, items.assessment_id))
            .where(and(eq(items.id, set.source.item_id), eq(items.assessment_id, set.source.assessment_id)))
            .limit(1);
          if (src && src.owner_sub === owner_sub && SOURCE_ITEM_TYPES.has(src.type)) sourceItemId = src.id;
          else sourcesDropped += 1;
        }
        const [setRow] = await tx
          .insert(item_sets)
          .values({
            assessment_id: row!.id,
            stimulus_text: rewriteAssetRefs(set.stimulus, remap),
            // Multi-source stimulus slice 2: each source's text remaps its
            // asset refs exactly as the introduction does, so a figure inside
            // Source C points at the copy's own asset row.
            sources: set.sources.map((src) => ({
              label: src.label,
              text: rewriteAssetRefs(src.text, remap),
            })),
            layout: set.layout,
            source_item_id: sourceItemId,
          })
          .returning({ id: item_sets.id });
        await tx
          .update(items)
          .set({ item_set_id: setRow!.id })
          .where(inArray(items.id, newIds));
      }
    }
    return row!.id;
  });

  return {
    assessment_id: result,
    item_count: importable.length,
    assets_imported: importedAssetCount,
    sources_dropped: sourcesDropped,
    assets_reused: reusedAssetCount,
    accommodations_imported: allowedValid.length,
    accommodations_dropped: accommodationsDropped,
    construct_altering_imported: caValid.length,
    construct_altering_dropped: caDropped,
    items_skipped_unknown_type: skippedUnknownType,
    scoring_methods_dropped: scoringMethodsDropped,
  };
}

export function isImportBundleError(
  r: ImportBundleResult | ImportBundleError,
): r is ImportBundleError {
  return "error" in r;
}

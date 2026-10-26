import type { ItemBundle } from "@secure-test/schema";
import type { getDb } from "@/db/client";
import { ITEM_TYPES, type ItemType } from "@/db/schema";
import { needsAnswerKey } from "@/app/dashboard/[id]/readiness";
import type { ItemRow } from "@/app/dashboard/[id]/editorModel";
import { importName, keptSourceItemId, planImport, type ImportPlan } from "@/lib/api/importBundle";
import { isAllowedImageMime } from "@/lib/api/uploads";
import { assetIdsFromItemConfig, extractAssetRefsFromMany } from "@/lib/items/extractAssetRefs";

type Db = ReturnType<typeof getDb>;

/**
 * Editor redesign Phase 7 slice C (R-9, D-6): what a JSON (ItemBundle) import
 * WOULD create, computed before anything is written. The questions come from
 * `planImport` — the same function the import itself runs — so the preview
 * shows each question as it will be stored (scoring clamp, blank order, type
 * skip) and its counts are the import's own. The only queries are two reads
 * (the copy's free name and the E12 source-link check); no row is inserted
 * and storage is never touched (test/import-preview.test.ts holds both).
 */

export interface ImportPreviewWarning {
  code:
    | "no_items"
    | "unknown_types"
    | "scoring_dropped"
    | "accommodations_dropped"
    | "sources_dropped"
    | "missing_pictures"
    | "no_answer_key";
  message: string;
}

export interface ImportPreviewSet {
  id: string;
  stimulus_text: string;
  sources: { label: string; text: string }[];
  layout: "inline" | "own_page" | "side_by_side";
}

export interface ImportPreview {
  /** The name the new assessment will get (`title`, `title (copy)`, …). */
  name: string;
  item_count: number;
  /** Questions per type, in ITEM_TYPES order, types with none left out. */
  type_counts: { type: ItemType; count: number }[];
  set_count: number;
  picture_count: number;
  student_layout: "scroll" | "paged";
  calculator_mode: "none" | "four_function" | "scientific" | "graphing";
  calculator_preset: "full" | "state_wa";
  allow_highlighting: boolean;
  accommodation_count: number;
  warnings: ImportPreviewWarning[];
  /** The code the import would refuse this file with, or null: Create stays off. */
  error: string | null;
  /** The questions as they will be stored, with preview-only ids. */
  items: ItemRow[];
  sets: ImportPreviewSet[];
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The import's own refusal of a bundled picture (importBundleForOwner's first check). */
export function assetError(bundle: ItemBundle): string | null {
  for (const asset of Object.values(bundle.assets ?? {})) {
    if (!isAllowedImageMime(asset.content_type)) return "asset_content_type_not_allowed";
  }
  return null;
}

/**
 * The preview from a plan (pure). `name` and `sourcesDropped` are the two
 * facts that need the database; `previewImportBundle` reads them.
 */
export function buildImportPreview(
  bundle: ItemBundle,
  plan: ImportPlan,
  facts: { name: string; sourcesDropped: number },
): ImportPreview {
  const itemIds = plan.importable.map((_, idx) => `preview-item-${idx}`);
  const indexOf = new Map(plan.importable.map((it, idx) => [it.id, idx] as const));

  // Sets as the import recreates them: an item the type skip dropped leaves
  // its set, and a set left with no items is not created.
  const sets: ImportPreviewSet[] = [];
  const setOf = new Map<number, string>();
  for (const set of bundle.item_sets ?? []) {
    const members = set.item_ids.map((id) => indexOf.get(id)).filter((i): i is number => i !== undefined);
    if (members.length === 0) continue;
    const id = `preview-set-${sets.length}`;
    sets.push({ id, stimulus_text: set.stimulus, sources: set.sources, layout: set.layout });
    for (const m of members) setOf.set(m, id);
  }

  const items: ItemRow[] = plan.rows.map((r, idx) => ({
    id: itemIds[idx]!,
    position: r.position,
    item_set_id: setOf.get(idx) ?? null,
    type: r.type,
    stem: r.stem,
    choices: r.choices,
    correct_choice_ids: r.correct_choice_ids,
    correct_answer: r.correct_answer,
    config: r.config as ItemRow["config"],
    standards: r.standards,
  }));

  const counts = new Map<ItemType, number>();
  for (const r of plan.rows) counts.set(r.type, (counts.get(r.type) ?? 0) + 1);

  const bundled = new Set(Object.keys(bundle.assets ?? {}).map((k) => k.toLowerCase()));
  const referenced = new Set([
    ...extractAssetRefsFromMany([
      ...items.flatMap((i) => [i.stem, ...(i.choices as { text: string }[]).map((c) => c.text)]),
      ...sets.flatMap((s) => [s.stimulus_text, ...s.sources.map((src) => src.text)]),
    ]),
    ...items.flatMap((i) => assetIdsFromItemConfig(i.config)),
  ]);
  const missing = [...referenced].filter((id) => !bundled.has(id)).length;
  const keyless = plan.rows.filter((r) => needsAnswerKey(r)).length;
  const accommodationsDropped = plan.accommodationsDropped + plan.caDropped;

  const warnings: ImportPreviewWarning[] = [];
  if (plan.rows.length === 0) {
    warnings.push({ code: "no_items", message: "The file has no questions. The new assessment will be empty." });
  }
  if (plan.skippedUnknownType > 0) {
    warnings.push({
      code: "unknown_types",
      message: `${plural(plan.skippedUnknownType, "question uses a type", "questions use a type")} this version doesn't know. ${plan.skippedUnknownType === 1 ? "It" : "They"} will be left out.`,
    });
  }
  if (plan.scoringMethodsDropped > 0) {
    warnings.push({
      code: "scoring_dropped",
      message: `${plural(plan.scoringMethodsDropped, "question's scoring setting doesn't", "questions' scoring settings don't")} fit the question or need a rubric the file doesn't have. ${plan.scoringMethodsDropped === 1 ? "It" : "They"} will use the usual scoring for the type.`,
    });
  }
  if (accommodationsDropped > 0) {
    warnings.push({
      code: "accommodations_dropped",
      message: `${plural(accommodationsDropped, "accommodation setting isn't", "accommodation settings aren't")} on the current list and will be left out.`,
    });
  }
  if (facts.sourcesDropped > 0) {
    warnings.push({
      code: "sources_dropped",
      message: `${plural(facts.sourcesDropped, "passage shows", "passages show")} a student's answer from a question you don't own. That link will be dropped; the passage text is kept.`,
    });
  }
  if (missing > 0) {
    warnings.push({
      code: "missing_pictures",
      message: `${plural(missing, "picture the questions use isn't", "pictures the questions use aren't")} in the file. ${missing === 1 ? "It" : "They"} will show as missing.`,
    });
  }
  if (keyless > 0) {
    warnings.push({
      code: "no_answer_key",
      message: `${plural(keyless, "question has", "questions have")} no answer key yet. Scoring skips ${keyless === 1 ? "it" : "them"} until you add one.`,
    });
  }

  return {
    name: facts.name,
    item_count: plan.rows.length,
    type_counts: ITEM_TYPES.filter((t) => counts.has(t)).map((t) => ({ type: t, count: counts.get(t)! })),
    set_count: sets.length,
    picture_count: bundled.size,
    student_layout: bundle.student_layout ?? "scroll",
    calculator_mode: bundle.calculator?.mode ?? "none",
    calculator_preset: bundle.calculator?.preset ?? "full",
    allow_highlighting: bundle.allow_highlighting ?? false,
    accommodation_count: plan.allowedValid.length,
    warnings,
    error: assetError(bundle) ?? plan.error?.error ?? null,
    items,
    sets,
  };
}

/**
 * The preview for `owner_sub`. Read-only: two SELECTs, no insert, no storage.
 * Pictures keep their bundle ids (an empty remap), which is how the editor
 * page finds them in the file it already holds.
 */
export async function previewImportBundle(db: Db, bundle: ItemBundle, owner_sub: string): Promise<ImportPreview> {
  const plan = planImport(bundle, new Map());
  const name = await importName(db, owner_sub, bundle.title);
  let sourcesDropped = 0;
  const kept = new Set(plan.importable.map((it) => it.id));
  for (const set of bundle.item_sets ?? []) {
    // Only a set the import recreates is checked, as the import does.
    if (!set.source || !set.item_ids.some((id) => kept.has(id))) continue;
    if (!(await keptSourceItemId(db, set.source, owner_sub))) sourcesDropped += 1;
  }
  return buildImportPreview(bundle, plan, { name, sourcesDropped });
}

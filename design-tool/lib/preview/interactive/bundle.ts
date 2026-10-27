// The interactive preview's delivery bundle, built in the editor page from
// the editor's own state (editor redesign Phase 5 slice B, ADR 0019 §4).
//
// The key boundary (ADR 0016, ADR 0019 risk 7): each item goes through the
// SAME per-item projection the student's bundle uses (`deliveredItem`,
// lib/api/deliveryItem.ts), and the whole bundle through
// `DeliveryBundleSchema`, which has no field that can hold a key, before it
// is posted. Match and order get sealed ids minted in this page for this
// editor session (`createPreviewSealer`); the map back to the real ids never
// leaves the page. test/preview-interactive.test.ts holds every item type's
// keyed fixture to "no key value appears in the posted payload".
//
// Unlike the student's bundle, this one is built from unsaved drafts, so an
// item (or a set) that is not complete enough for the delivery schema yet —
// one choice, no pairs — is left out and listed in `skipped`, rather than
// failing the whole preview.
import {
  DeliveryBundleSchema,
  DeliveryItemSchema,
  DeliveryItemSetSchema,
  type BundleAsset,
  type DeliveryBundle,
  type DeliveryItem,
  type DeliveryItemSet,
  type ItemResponse,
} from "@secure-test/schema";
import type { ItemRow } from "@/db/schema";
import { deliveredItem, type DeliverableRow } from "@/lib/api/deliveryItem";
import { assetIdsFromItemConfig, extractAssetRefsFromMany } from "@/lib/items/extractAssetRefs";
import { blanksForSave } from "@/lib/items/fillBlankEditor";
import type { AssessmentView, ItemSetView, ItemView } from "@/app/dashboard/[id]/editorModel";

export type SealSide = "left" | "right" | "order";

export interface PreviewSealer {
  seal(itemId: string, realId: string, side: SealSide): string;
  /** The real id behind a sealed one this sealer minted, or null. */
  unseal(itemId: string, sealedId: string, side: SealSide): string | null;
}

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Random sealed ids, stable for the sealer's life (one editor session), so an
 * answer given before a live refresh still names the same options after it.
 * Same width as the server's (12 bytes, lib/api/opaqueIds.ts).
 */
export function createPreviewSealer(mint: () => string = () => randomHex(12)): PreviewSealer {
  const forward = new Map<string, string>();
  const back = new Map<string, string>();
  const key = (itemId: string, side: SealSide, id: string) => `${itemId}\u0000${side}\u0000${id}`;
  return {
    seal(itemId, realId, side) {
      const k = key(itemId, side, realId);
      let sealed = forward.get(k);
      if (!sealed) {
        do sealed = mint();
        while (back.has(key(itemId, side, sealed)));
        forward.set(k, sealed);
        back.set(key(itemId, side, sealed), realId);
      }
      return sealed;
    },
    unseal(itemId, sealedId, side) {
      return back.get(key(itemId, side, sealedId)) ?? null;
    },
  };
}

/**
 * The delivery's shuffle, made stable: sorted by the (random) sealed id, so
 * the order is not the key but does not reshuffle on every keystroke.
 */
export function stableShuffle<T>(input: readonly T[]): T[] {
  return [...input].sort((a, b) => {
    const x = (a as { id?: unknown }).id;
    const y = (b as { id?: unknown }).id;
    return String(x) < String(y) ? -1 : String(x) > String(y) ? 1 : 0;
  });
}

function definedOnly<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== null && v !== undefined)) as Partial<T>;
}

/**
 * An editor card as the row shape the delivery projection and the scorer
 * read — the inverse of `rowToView` (editorModel.ts), with the canvas and
 * blank rules of `itemPatchBody`, so it matches what a save would store.
 */
export function viewToRow(item: ItemView): DeliverableRow & Pick<ItemRow, "correct_choice_ids" | "correct_answer"> {
  const width = item.canvas?.width ?? null;
  const height = item.canvas?.height ?? null;
  const background = item.canvas?.background ?? null;
  const canvas =
    width != null && height != null
      ? { width, height, ...(background ? { background } : {}) }
      : background
        ? { width: 800, height: 600, background }
        : null;
  const config = definedOnly({
    max_word_count: item.max_word_count,
    placeholder: item.placeholder || null,
    rich_text: item.rich_text ? true : null,
    show_word_count: item.show_word_count ? true : null,
    no_calculator: item.no_calculator ? true : null,
    graph: item.graph,
    graph_board: item.board,
    graph_key: item.graph_key,
    rubric: item.rubric,
    pairs: item.pairs,
    sequence: item.sequence,
    image_asset_id: item.image_asset_id,
    regions: item.regions,
    correct_region_ids: item.correct_region_ids,
    prompt_asset_id: item.prompt_asset_id,
    canvas,
    columns: item.columns,
    rows: item.rows,
    corner: item.corner || null,
    cell_keys: item.cell_keys,
    blanks: item.type === "fill_blank" ? blanksForSave(item.stem, item.blanks ?? []) : null,
    exact_form: item.exact_form ? true : null,
    scoring_method: item.scoring_method,
  }) as ItemRow["config"];
  return {
    id: item.id,
    type: item.type,
    stem: item.stem,
    choices: item.choices,
    correct_choice_ids: item.correct_choice_ids,
    correct_answer: item.correct_answer,
    config,
  };
}

/** Every asset the preview needs as base64 (stems, choices, configs, stimuli). */
export function previewAssetIds(items: readonly ItemView[], sets: readonly ItemSetView[]): string[] {
  const texts = [
    ...sets.flatMap((s) => [s.stimulus_text, ...s.sources.map((src) => src.text)]),
    ...items.flatMap((i) => [i.stem, ...i.choices.map((c) => c.text)]),
  ];
  return [
    ...new Set([
      ...extractAssetRefsFromMany(texts),
      ...items.flatMap((i) => assetIdsFromItemConfig(viewToRow(i).config)),
    ]),
  ];
}

export interface PreviewSkip {
  /** The item, or for a stimulus the first item of its set. */
  itemId: string;
  what: "question" | "stimulus";
}

export interface PreviewBundleInput {
  assessment: Pick<
    AssessmentView,
    "id" | "name" | "calculator_mode" | "calculator_preset" | "allow_highlighting"
  >;
  items: readonly ItemView[];
  sets: readonly ItemSetView[];
  layout: "scroll" | "paged";
  /** Read-aloud view: mirrors a student granted TTS (items, stimuli, answers). */
  tts: boolean;
  assets: Readonly<Record<string, BundleAsset>>;
  /** Answers given in this preview so far (sealed ids as the frame posted them). */
  saved: Readonly<Record<string, ItemResponse>>;
  sealer: PreviewSealer;
}

export const PREVIEW_TTS_ACCOMMODATIONS = {
  tts_test_content: "Stimuli+Items",
  tts_student_responses: "On",
} as const;

export function buildPreviewBundle(input: PreviewBundleInput): {
  bundle: DeliveryBundle;
  skipped: PreviewSkip[];
} {
  const hasCalculator = input.assessment.calculator_mode !== "none";
  const skipped: PreviewSkip[] = [];
  const items: DeliveryItem[] = [];
  for (const view of input.items) {
    const row = viewToRow(view);
    const parsed = DeliveryItemSchema.safeParse(
      deliveredItem(row, (realId, side) => input.sealer.seal(view.id, realId, side), hasCalculator, stableShuffle),
    );
    if (parsed.success) items.push(parsed.data);
    else skipped.push({ itemId: view.id, what: "question" });
  }
  const shown = new Set(items.map((i) => i.id));

  const sets: DeliveryItemSet[] = [];
  for (const set of input.sets) {
    const members = input.items.filter((i) => i.item_set_id === set.id);
    const itemIds = members.map((i) => i.id).filter((id) => shown.has(id));
    if (itemIds.length === 0) continue;
    const parsed = DeliveryItemSetSchema.safeParse({
      id: set.id,
      stimulus: set.stimulus_text,
      sources: set.sources,
      layout: set.layout,
      item_ids: itemIds,
    });
    if (parsed.success) sets.push(parsed.data);
    else skipped.push({ itemId: members[0]!.id, what: "stimulus" });
  }

  const kinds = new Map(items.map((i) => [i.id, i.type]));
  const saved = Object.fromEntries(
    Object.entries(input.saved).filter(([id, r]) => kinds.get(id) === r.type),
  );
  const answered = Object.keys(saved);
  const assets = Object.fromEntries(
    previewAssetIds(input.items, input.sets)
      .filter((id) => input.assets[id])
      .map((id) => [id, input.assets[id]!]),
  );

  const candidate = {
    test_id: input.assessment.id,
    title: input.assessment.name,
    items,
    ...(sets.length > 0 ? { item_sets: sets } : {}),
    ...(Object.keys(assets).length > 0 ? { assets } : {}),
    ...(input.tts ? { accommodations: { ...PREVIEW_TTS_ACCOMMODATIONS } } : {}),
    ...(input.assessment.allow_highlighting ? { allow_highlighting: true } : {}),
    ...(hasCalculator
      ? {
          calculator: {
            mode: input.assessment.calculator_mode as Exclude<AssessmentView["calculator_mode"], "none">,
            preset: input.assessment.calculator_preset,
          },
        }
      : {}),
    ...(input.layout === "paged" ? { layout: "paged" as const } : {}),
    ...(answered.length > 0 ? { answered_item_ids: answered, saved_responses: saved } : {}),
  };
  const parsed = DeliveryBundleSchema.safeParse(candidate);
  if (parsed.success) return { bundle: parsed.data, skipped };
  // A set the editor has not made contiguous yet (mid-move): show the
  // questions without their stimuli rather than nothing.
  const { item_sets: _sets, ...withoutSets } = candidate;
  return {
    bundle: DeliveryBundleSchema.parse(withoutSets),
    skipped: [...skipped, ...sets.map((s) => ({ itemId: s.item_ids[0]!, what: "stimulus" as const }))],
  };
}

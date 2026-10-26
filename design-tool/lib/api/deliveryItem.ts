// Editor redesign Phase 5 slice B (ADR 0019 §4): the per-item delivery
// projection, moved unchanged out of buildDeliveryBundle.ts so the editor's
// interactive preview builds its bundle with the SAME mapping the student's
// bundle uses, rather than a second copy that could drift into carrying a
// key. Pure: no database, no node:crypto. The caller supplies the sealing —
// the delivery route derives per-attempt HMAC ids (lib/api/opaqueIds.ts),
// the preview mints random ones held in the editor page.
import type { ItemRow, ItemType } from "@/db/schema";
import { assertNever } from "@/lib/assertNever";

/** The row fields the projection reads. */
export type DeliverableRow = Pick<ItemRow, "id" | "type" | "stem" | "choices" | "config">;

/**
 * Seals one authoring id of a match or order item for the delivery bundle.
 * `left` / `right` are a match pair's two sides (they must differ, or the
 * bundle re-pairs itself); `order` is a sequence entry.
 */
export type DeliverySeal = (realId: string, side: "left" | "right" | "order") => string;

// Fisher-Yates. match `rights` and order `entries` ship shuffled so the
// authored order is not itself the answer. This is obfuscation, not secrecy:
// the ids in those arrays are still the authoring ids, so a student reading the
// bundle can correlate them. Sealing that needs a per-attempt id map held
// server-side, which needs the attempt instance from the student plane. The
// wire shape is already final, so that work swaps ids without touching clients.
export function shuffled<T>(input: readonly T[]): T[] {
  const out = [...input];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const a = out[i];
    const b = out[j];
    if (a === undefined || b === undefined) continue;
    out[i] = b;
    out[j] = a;
  }
  return out;
}

// scoring_method is emitted on no branch: it is not an answer key, but it
// telegraphs whether an item is AI- or human-scored, which the student has no
// need for. The assertNever default makes this switch fail typecheck if
// ITEM_TYPES grows without a branch here.
export function mapItemForDelivery(
  row: DeliverableRow,
  seal: DeliverySeal,
  shuffle: <T>(input: readonly T[]) => T[] = shuffled,
) {
  const choices = Array.isArray(row.choices)
    ? (row.choices as { id: string; text: string }[])
    : [];
  const config = row.config ?? {};
  const type = row.type as ItemType;
  switch (type) {
    case "multiple_choice_single":
      return {
        type: "multiple_choice_single" as const,
        id: row.id,
        stem: row.stem,
        choices,
      };
    case "multiple_choice_multi":
      return {
        type: "multiple_choice_multi" as const,
        id: row.id,
        stem: row.stem,
        choices,
      };
    case "short_text":
      // correct_answer dropped entirely — no replacement field.
      return {
        type: "short_text" as const,
        id: row.id,
        stem: row.stem,
      };
    case "essay":
      return {
        type: "essay" as const,
        id: row.id,
        stem: row.stem,
        ...(config.max_word_count != null
          ? { max_word_count: config.max_word_count }
          : {}),
        ...(config.placeholder ? { placeholder: config.placeholder } : {}),
        // RT slice 1 (D-1): the formatting toolbar is student-facing, not a
        // key, so it rides the delivery bundle. Older clients ignore it.
        ...(config.rich_text ? { rich_text: true } : {}),
        // U-22: a running word count with no maximum.
        ...(config.show_word_count ? { show_word_count: true } : {}),
        // Mirrors the export route's B8 gate, minus the teacher opt-in:
        // there is no include_hidden_rubrics on the student path. Level
        // descriptors routinely spell out what a correct answer contains.
        ...(config.rubric?.student_visibility?.during_test
          ? { rubric: config.rubric }
          : {}),
      };
    case "match": {
      // The pair list IS the key: each object holds a left beside its own
      // correct right. Split into two independent arrays so the association is
      // not carried by the structure — and slice 64: both sides carry
      // per-attempt opaque ids, so the arrays cannot be re-paired by reading
      // the identifiers either.
      const pairs = config.pairs ?? [];
      return {
        type: "match" as const,
        id: row.id,
        stem: row.stem,
        lefts: pairs.map((p) => ({
          id: seal(p.id, "left"),
          text: p.left,
        })),
        rights: shuffle(
          pairs.map((p) => ({
            id: seal(p.id, "right"),
            text: p.right,
          })),
        ),
      };
    }
    case "order":
      // The sequence IS the key: it is stored in correct order, and entry ids
      // are assigned in that order, so their natural ordering is the answer
      // too. Shuffling handles the first; opaque ids handle the second.
      return {
        type: "order" as const,
        id: row.id,
        stem: row.stem,
        entries: shuffle(
          (config.sequence ?? []).map((e) => ({
            id: seal(e.id, "order"),
            label: e.label,
          })),
        ),
      };
    case "hotspot":
      // regions stay (the client must draw them); correct_region_ids goes.
      return {
        type: "hotspot" as const,
        id: row.id,
        stem: row.stem,
        ...(config.image_asset_id ? { image_asset_id: config.image_asset_id } : {}),
        regions: config.regions ?? [],
      };
    case "drawing_upload":
      // Authoring-only type; it has no key to drop.
      return {
        type: "drawing_upload" as const,
        id: row.id,
        stem: row.stem,
        ...(config.prompt_asset_id ? { prompt_asset_id: config.prompt_asset_id } : {}),
        ...(config.canvas ? { canvas: config.canvas } : {}),
      };
    case "table":
      // E3 slice 1: the grid ships (columns, rows, corner); cell_keys does
      // not. Row and column ids are structure, not the key — nothing to
      // seal, the response addresses cells by them.
      return {
        type: "table" as const,
        id: row.id,
        stem: row.stem,
        columns: config.columns ?? [],
        rows: config.rows ?? [],
        ...(config.corner ? { corner: config.corner } : {}),
      };
    case "fill_blank":
      // FB slice 1 (docs/fill-in-blank-design.md): each blank ships its id,
      // kind and — for a dropdown — its options in the teacher's order (D-6).
      // Built field by field rather than spread, so `correct_option_id`,
      // `keys` and `exact_form` never reach the object (ADR 0016). Option
      // ids ship as MC choice ids do; blank ids are structure the stem's
      // markers and the response both address.
      return {
        type: "fill_blank" as const,
        id: row.id,
        stem: row.stem,
        blanks: (config.blanks ?? []).map((b) =>
          b.kind === "dropdown"
            ? {
                id: b.id,
                kind: "dropdown" as const,
                options: b.options.map((o) => ({ id: o.id, text: o.text })),
              }
            : { id: b.id, kind: "text" as const },
        ),
      };
    case "graph":
      // Graphing calculator D-9: the board only. `graph_key` is the answer
      // key and is never read here (ADR 0016).
      return {
        type: "graph" as const,
        id: row.id,
        stem: row.stem,
        board: config.graph_board!,
      };
    default:
      return assertNever(type, "delivery: unhandled item type");
  }
}


/**
 * One delivered item: the projection plus the two fields every type carries.
 * Graphing calculator (D-7): the per-question "no calculator" mark rides
 * every item type, and only when the test has a calculator to hide.
 * Stimulus graph (D-8): content, every type.
 */
export function deliveredItem(
  row: DeliverableRow,
  seal: DeliverySeal,
  hasCalculator: boolean,
  shuffle: <T>(input: readonly T[]) => T[] = shuffled,
) {
  const mapped = mapItemForDelivery(row, seal, shuffle);
  return {
    ...mapped,
    ...(hasCalculator && row.config?.no_calculator === true ? { no_calculator: true as const } : {}),
    ...(row.config?.graph ? { graph: row.config.graph } : {}),
  };
}

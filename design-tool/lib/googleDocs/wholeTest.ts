// U-25 slice 4 (docs/google-docs-whole-test-design.md): what a whole-test
// Doc shows for one question's answer, per item type. Pure — an item and the
// student's response in, a `DocAnswer` out — so every type is tested without
// Drive or a database.
//
// D-11 by construction: `DocAnswer` has no field that can hold a key, and
// nothing here reads one (`correct_choice_ids`, `correct_answer`,
// `cell_keys`, a blank's keys or correct option, `correct_region_ids`,
// `graph_key`). A match's pairing and an order's sequence ARE their keys, so
// only the student's own arrangement comes out.

import type { FillBlankBlank, MatchPair, SequenceEntry } from "@secure-test/schema";
import { fillBlankAnswer, filledBlankAnswerText } from "@/lib/items/fillBlankAnswer";
import { graphAnswerLines, type GraphBoard, type GraphObject } from "@secure-test/graphing/server";

/** A picture the Doc may embed (slice 3), named by where its bytes live. */
export type DocPictureRef =
  | { kind: "asset"; asset_id: string }
  | { kind: "upload"; response_id: string; upload_id: string };

export interface DocPicture {
  ref: DocPictureRef;
  alt: string;
}

/** The key a resolved picture is looked up by (content.ts `pictures`). */
export function pictureKey(ref: DocPictureRef): string {
  return ref.kind === "asset" ? `asset:${ref.asset_id}` : `upload:${ref.response_id}`;
}

export type DocAnswer =
  | { kind: "none" }
  /** Every option in the item's order, the student's marked (D-12). */
  | { kind: "choices"; options: Array<{ text: string; chosen: boolean }> }
  | { kind: "lines"; lines: string[]; ordered?: boolean }
  /** The stem as text and the student's answers; `unplaced` follow it. */
  | {
      kind: "fill_blank";
      /**
       * `teacher` marks an answer that is teacher-authored text (a dropdown's
       * chosen option), whose pictures may be embedded; a typed answer is
       * the student's own and is never read for picture refs (PR #174 review).
       */
      segments: Array<{ text: string } | { answer: string; teacher: boolean }>;
      unplaced: Array<{ number: number; answer: string }>;
    }
  | {
      kind: "table";
      corner: string;
      columns: string[];
      rows: Array<{ label: string; cells: string[] }>;
    }
  | { kind: "picture"; picture: DocPicture };

/** The structural part of an item this file reads — no key fields. */
export interface WholeTestItem {
  type: string;
  stem: string;
  choices?: Array<{ id: string; text: string }>;
  config: {
    pairs?: MatchPair[];
    sequence?: SequenceEntry[];
    image_asset_id?: string | null;
    prompt_asset_id?: string | null;
    columns?: Array<{ id: string; label: string }>;
    rows?: Array<{ id: string; label: string }>;
    corner?: string;
    blanks?: FillBlankBlank[];
    graph_board?: GraphBoard;
  };
}

/**
 * D-11 at the handoff (PR #174 review): the config with only the fields
 * WholeTestItem declares, a blank cut to its id, kind and options — so
 * `cell_keys`, a blank's `keys` / `correct_option_id`, `correct_region_ids`
 * and `graph_key` never reach the mapper at all.
 */
export function keyFreeConfig(config: Record<string, unknown> & WholeTestItem["config"]): WholeTestItem["config"] {
  return {
    pairs: config.pairs,
    sequence: config.sequence,
    image_asset_id: config.image_asset_id,
    prompt_asset_id: config.prompt_asset_id,
    columns: config.columns,
    rows: config.rows,
    corner: config.corner,
    blanks: config.blanks?.map((b) =>
      b.kind === "dropdown" ? { id: b.id, kind: b.kind, options: b.options } : { id: b.id, kind: b.kind },
    ),
    graph_board: config.graph_board,
  };
}

export interface WholeTestResponse {
  id: string;
  response: Record<string, unknown>;
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/**
 * The pictures that belong to the question itself, shown under its stem: a
 * hotspot's image (1.1) and a drawing item's reference picture.
 */
export function questionPictures(item: WholeTestItem, number: number): DocPicture[] {
  const id =
    item.type === "hotspot"
      ? item.config.image_asset_id
      : item.type === "drawing_upload"
        ? item.config.prompt_asset_id
        : null;
  return id ? [{ ref: { kind: "asset", asset_id: id }, alt: `Picture for question ${number}` }] : [];
}

/**
 * The answer as the Doc shows it, or `{ kind: "none" }` when the student left
 * the question blank. Essays and short answers stay on content.ts's own path
 * (formatting, double spacing); this returns `none` for them.
 *
 * A response whose type is not the item's (left from before a type change)
 * is no answer, as release.ts already rules for essays.
 */
export function wholeTestAnswer(
  item: WholeTestItem,
  resp: WholeTestResponse | null,
  number: number,
): DocAnswer {
  const r = resp?.response;
  if (!r || r.type !== item.type) return { kind: "none" };
  switch (item.type) {
    case "multiple_choice_single":
    case "multiple_choice_multi": {
      const chosen = new Set([
        ...(typeof r.choice_id === "string" ? [r.choice_id] : []),
        ...strings(r.choice_ids),
      ]);
      if (chosen.size === 0) return { kind: "none" };
      return {
        kind: "choices",
        options: (item.choices ?? []).map((c) => ({ text: c.text, chosen: chosen.has(c.id) })),
      };
    }
    case "match": {
      const pairs = item.config.pairs ?? [];
      const matches = (r.matches ?? {}) as Record<string, unknown>;
      if (Object.keys(matches).length === 0) return { kind: "none" };
      return {
        kind: "lines",
        lines: pairs.map((p) => {
          const to = matches[p.id];
          const right = typeof to === "string" ? pairs.find((q) => q.id === to)?.right : undefined;
          return `${p.left} → ${right ?? "(none)"}`;
        }),
      };
    }
    case "order": {
      const sequence = item.config.sequence ?? [];
      const ids = strings(r.ordered_ids);
      if (ids.length === 0) return { kind: "none" };
      return {
        kind: "lines",
        ordered: true,
        lines: ids.map((id) => sequence.find((e) => e.id === id)?.label ?? "(an entry no longer on this question)"),
      };
    }
    case "hotspot": {
      const n = strings(r.region_ids).length;
      if (n === 0) return { kind: "none" };
      return { kind: "lines", lines: [`You picked ${n} area${n === 1 ? "" : "s"}.`] };
    }
    case "drawing_upload": {
      if (typeof r.upload_id !== "string" || !resp) return { kind: "none" };
      return {
        kind: "picture",
        picture: {
          ref: { kind: "upload", response_id: resp.id, upload_id: r.upload_id },
          alt: `Drawing for question ${number}`,
        },
      };
    }
    case "table": {
      const cells = (r.cells ?? {}) as Record<string, Record<string, unknown>>;
      const columns = item.config.columns ?? [];
      return {
        kind: "table",
        corner: item.config.corner ?? "",
        columns: columns.map((c) => c.label),
        rows: (item.config.rows ?? []).map((row) => ({
          label: row.label,
          cells: columns.map((c) => {
            const v = cells[row.id]?.[c.id];
            return typeof v === "string" && v.trim() !== "" ? v : "—";
          }),
        })),
      };
    }
    case "fill_blank": {
      const filled = fillBlankAnswer(item.stem, item.config.blanks, (r.answers ?? {}) as Record<string, unknown>);
      if (filled.blanks.every((b) => b.answer === null)) return { kind: "none" };
      return {
        kind: "fill_blank",
        segments: filled.segments.map((s) =>
          s.kind === "text"
            ? { text: s.text }
            : {
                answer: filledBlankAnswerText(s.blank),
                teacher: s.blank.format === "content" && s.blank.answer !== null,
              },
        ),
        unplaced: filled.unplaced.map((b) => ({ number: b.number, answer: filledBlankAnswerText(b) })),
      };
    }
    case "graph": {
      const board = item.config.graph_board;
      const objects = Array.isArray(r.objects) ? (r.objects as GraphObject[]) : [];
      if (objects.length === 0) return { kind: "none" };
      // 1.2: in words. The key is never passed, so no line is marked.
      if (!board) return { kind: "lines", lines: ["Answer saved"] };
      return { kind: "lines", lines: graphAnswerLines(board, null, objects).map((l) => l.text) };
    }
    default:
      return { kind: "lines", lines: ["Answer saved"] };
  }
}

import { z } from "zod";
import {
  DrawingCanvasSchema,
  RubricSchema,
  ScoringMethodSchema,
  type ScoringMethod,
} from "@secure-test/schema";
import { ITEM_TYPES, type ItemConfig, type ItemType } from "@/db/schema";

export const ChoiceShape = z.object({
  id: z.string().min(1).max(64),
  text: z.string().max(2000),
});
export type Choice = z.infer<typeof ChoiceShape>;

const BaseItemFields = {
  stem: z.string().min(1).max(10000),
  // Slice 36 + review fix (2026-08-14, finding 8): three-state on PATCH —
  // omitted = PRESERVE the stored method, explicit null = clear back to
  // the type default, value = set. (Previously omission cleared, which
  // silently reverted a teacher's 'human' pick to 'auto' on any partial
  // PATCH.) Cross-field rules live in the superRefine on the union below.
  scoring_method: ScoringMethodSchema.nullable().optional(),
};

// Answer keys are OPTIONAL at write time (James, 2026-09-01). The prod
// sample-import run rejected 35 of 146 extracted candidates solely for a
// missing key (keyless quizzes: "correct_answer: Required" /
// "correct_choice_ids: Required"), and the editor was already working
// around the old min(1) rules by seeding placeholder keys. A keyless item
// is a legitimate draft of its answer key: readiness.ts lists it as
// "needs a correct answer", the delivery bundle never ships keys, and
// lib/scoring/auto.ts returns null (unscorable) until the key is filled —
// including after publish, where the item PATCH route admits key-only
// edits (isAnswerKeyOnlyPatch). Shape rules other than the key are
// unchanged: single-select still allows at most ONE correct id.
const SingleSelectMCItem = z.object({
  type: z.literal("multiple_choice_single"),
  ...BaseItemFields,
  choices: z.array(ChoiceShape).min(2),
  correct_choice_ids: z.array(z.string()).max(1),
  correct_answer: z.null().optional(),
});

const MultiSelectMCItem = z.object({
  type: z.literal("multiple_choice_multi"),
  ...BaseItemFields,
  choices: z.array(ChoiceShape).min(2),
  correct_choice_ids: z.array(z.string()),
  correct_answer: z.null().optional(),
});

const ShortTextItem = z.object({
  type: z.literal("short_text"),
  ...BaseItemFields,
  choices: z.array(ChoiceShape).max(0).default([]),
  correct_choice_ids: z.array(z.string()).max(0).default([]),
  correct_answer: z.string().max(2000).nullable().optional(),
});

// Slice 32: essay. No choices, no correct answer (authoring only). The two
// optional authoring-metadata fields are the ONLY keys allowed into the
// items.config jsonb bag — Zod here is the write-boundary guard that keeps
// the bag from accumulating arbitrary data.
const EssayItem = z.object({
  type: z.literal("essay"),
  ...BaseItemFields,
  choices: z.array(ChoiceShape).max(0).default([]),
  correct_choice_ids: z.array(z.string()).max(0).default([]),
  correct_answer: z.null().optional(),
  max_word_count: z.number().int().positive().max(100000).optional(),
  placeholder: z.string().max(200).optional(),
  // Slice 33: reuse the shared wire schema so the rubric shape has a single
  // source of truth across API body and bundle.
  rubric: RubricSchema.optional(),
  // Rubric library slice 3 (D-4): which `rubrics` row the rubric above was
  // copied from. Editor metadata only — never read by scoring, the delivery
  // bundle or export. Three states, like scoring_method: omitted = the
  // detach rule below decides, explicit null = detach, a uuid = attach (the
  // route checks the caller owns that rubric).
  rubric_id: z.string().uuid().nullable().optional(),
});

// Slice 47: matching. No choices / correct_answer — the pair list is the
// answer key and lives in items.config.pairs. Plain strings v1.
export const MatchPairShape = z.object({
  id: z.string().min(1).max(64),
  left: z.string().min(1).max(2000),
  right: z.string().min(1).max(2000),
});

const MatchItem = z.object({
  type: z.literal("match"),
  ...BaseItemFields,
  choices: z.array(ChoiceShape).max(0).default([]),
  correct_choice_ids: z.array(z.string()).max(0).default([]),
  correct_answer: z.null().optional(),
  pairs: z.array(MatchPairShape).min(2),
});

// Slice 48: ordering. The sequence is authored in correct order — that IS
// the answer key — and lives in items.config.sequence. Plain strings v1.
export const SequenceEntryShape = z.object({
  id: z.string().min(1).max(64),
  label: z.string().min(1).max(2000),
});

const OrderItem = z.object({
  type: z.literal("order"),
  ...BaseItemFields,
  choices: z.array(ChoiceShape).max(0).default([]),
  correct_choice_ids: z.array(z.string()).max(0).default([]),
  correct_answer: z.null().optional(),
  sequence: z.array(SequenceEntryShape).min(2),
});

// Slice 49: hotspot. Draft-friendly — the editor creates the item first
// and the teacher picks an image + draws regions after, so every hotspot
// field is optional here. Integrity of what IS present (bounds, unique
// ids, correct ⊆ regions) is enforced in validateHotspot below; an
// unconfigured hotspot is simply unscorable (auto-score skips it).
export const HotspotRegionShape = z.object({
  id: z.string().min(1).max(64),
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  w: z.number().gt(0).max(1),
  h: z.number().gt(0).max(1),
});

const HotspotItem = z.object({
  type: z.literal("hotspot"),
  ...BaseItemFields,
  choices: z.array(ChoiceShape).max(0).default([]),
  correct_choice_ids: z.array(z.string()).max(0).default([]),
  correct_answer: z.null().optional(),
  image_asset_id: z.string().uuid().nullable().optional(),
  regions: z.array(HotspotRegionShape).max(50).default([]),
  correct_region_ids: z.array(z.string().min(1)).default([]),
});

// Slice 50: drawing/upload — authoring only (no response format exists;
// student ingest is deferred to the student-app plan). Human-scored.
const DrawingUploadItem = z.object({
  type: z.literal("drawing_upload"),
  ...BaseItemFields,
  choices: z.array(ChoiceShape).max(0).default([]),
  correct_choice_ids: z.array(z.string()).max(0).default([]),
  correct_answer: z.null().optional(),
  prompt_asset_id: z.string().uuid().nullable().optional(),
  // Shared wire schema = single source for the 100-4000 bounds (same rule
  // as EssayItem reusing RubricSchema).
  canvas: DrawingCanvasSchema.nullable().optional(),
});

// E3 slice 1: a table the student fills in (docs/e3-table-item-design.md).
// Header row + labelled rows, every body cell a blank; `cell_keys` is the
// answer key (row id → column id → plain text, any subset of cells) and
// lives in items.config.cell_keys. Limits are the design page's: 8 columns,
// 30 rows, 500-char labels and keys. A column label must read as something
// (it heads a column of blanks); a row label may be blank (D-5).
export const TableColumnShape = z.object({
  id: z.string().min(1).max(64),
  label: z.string().min(1).max(500),
});

export const TableRowShape = z.object({
  id: z.string().min(1).max(64),
  label: z.string().max(500),
});

const TableItem = z.object({
  type: z.literal("table"),
  ...BaseItemFields,
  choices: z.array(ChoiceShape).max(0).default([]),
  correct_choice_ids: z.array(z.string()).max(0).default([]),
  correct_answer: z.null().optional(),
  columns: z.array(TableColumnShape).min(1).max(8),
  rows: z.array(TableRowShape).min(1).max(30),
  corner: z.string().max(200).optional(),
  cell_keys: z
    .record(z.string().min(1), z.record(z.string().min(1), z.string().min(1).max(500)))
    .optional(),
});

// Slice 36: which scoring methods each type may declare, and the default
// when unset. auto needs a machine-checkable key (choices / correct_answer),
// which essay lacks; ai/hybrid need a rubric, which only essay carries.
export const DEFAULT_SCORING_METHOD: Record<ItemType, ScoringMethod> = {
  multiple_choice_single: "auto",
  multiple_choice_multi: "auto",
  short_text: "auto",
  essay: "human",
  match: "auto",
  order: "auto",
  hotspot: "auto",
  drawing_upload: "human",
  table: "auto",
};

export const ALLOWED_SCORING_METHODS: Record<
  ItemType,
  readonly ScoringMethod[]
> = {
  multiple_choice_single: ["auto", "human"],
  multiple_choice_multi: ["auto", "human"],
  short_text: ["auto", "human"],
  essay: ["human", "ai", "hybrid"],
  match: ["auto", "human"],
  order: ["auto", "human"],
  hotspot: ["auto", "human"],
  // No auto (nothing machine-checkable) and no ai (no response to read,
  // and rubric-based AI scoring of images is future work).
  drawing_upload: ["human"],
  // E3: per-cell exact match against cell_keys (lib/scoring/auto.ts), or
  // hand-scored; an unkeyed table is simply unscorable, like a draft hotspot.
  table: ["auto", "human"],
};

// The method scoring actually runs with (slice 37 consumes this): the
// stored pick, or the type default when the teacher never chose. E3-F1: a
// table with no cell_keys has nothing to auto-score, so its unset default
// is human — flips to auto the moment a key exists (compactCellKeys never
// stores an empty object, so presence of the field is enough).
export function effectiveScoringMethod(
  type: ItemType,
  config: ItemConfig | null | undefined,
): ScoringMethod {
  if (config?.scoring_method) return config.scoring_method;
  if (type === "table") return config?.cell_keys ? "auto" : "human";
  return DEFAULT_SCORING_METHOD[type];
}

const validateScoring = (
  body: {
    type: ItemType;
    scoring_method?: ScoringMethod | null;
    rubric?: unknown;
  },
  ctx: z.RefinementCtx,
) => {
  const method = body.scoring_method;
  if (!method) return;
  if (!ALLOWED_SCORING_METHODS[body.type].includes(method)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["scoring_method"],
      message: `scoring_method "${method}" is not valid for ${body.type}`,
    });
    return;
  }
  if ((method === "ai" || method === "hybrid") && body.rubric == null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["scoring_method"],
      message: `scoring_method "${method}" requires a rubric`,
    });
  }
};

// Slices 47/48: entry ids must be unique — the response formats key on them.
const validateUniqueIds = (
  body: {
    type: ItemType;
    pairs?: { id: string }[];
    sequence?: { id: string }[];
  },
  ctx: z.RefinementCtx,
) => {
  const [path, entries] =
    body.type === "match"
      ? (["pairs", body.pairs] as const)
      : body.type === "order"
        ? (["sequence", body.sequence] as const)
        : ([null, undefined] as const);
  if (!path || !entries) return;
  const ids = new Set(entries.map((p) => p.id));
  if (ids.size !== entries.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [path],
      message: `${path === "pairs" ? "pair" : "entry"} ids must be unique`,
    });
  }
};

// Slice 49: hotspot cross-field integrity — region ids unique, rects
// inside the image, and the key only references regions that exist.
const validateHotspot = (
  body: {
    type: ItemType;
    regions?: { id: string; x: number; y: number; w: number; h: number }[];
    correct_region_ids?: string[];
  },
  ctx: z.RefinementCtx,
) => {
  if (body.type !== "hotspot") return;
  const regions = body.regions ?? [];
  const ids = new Set(regions.map((r) => r.id));
  if (ids.size !== regions.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["regions"],
      message: "region ids must be unique",
    });
  }
  regions.forEach((r, i) => {
    if (r.x + r.w > 1 || r.y + r.h > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["regions", i],
        message: "region must stay inside the image (x+w and y+h ≤ 1)",
      });
    }
  });
  for (const id of body.correct_region_ids ?? []) {
    if (!ids.has(id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["correct_region_ids"],
        message: `correct_region_ids references unknown region "${id}"`,
      });
      return;
    }
  }
};

// E3 slice 1: table cross-field integrity — column and row ids unique (the
// response and the key address cells by them) and every keyed cell names a
// row and a column that exist.
const validateTable = (
  body: {
    type: ItemType;
    columns?: { id: string }[];
    rows?: { id: string }[];
    cell_keys?: Record<string, Record<string, string>>;
  },
  ctx: z.RefinementCtx,
) => {
  if (body.type !== "table") return;
  const columns = body.columns ?? [];
  const rows = body.rows ?? [];
  const columnIds = new Set(columns.map((c) => c.id));
  const rowIds = new Set(rows.map((r) => r.id));
  if (columnIds.size !== columns.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["columns"],
      message: "column ids must be unique",
    });
  }
  if (rowIds.size !== rows.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["rows"],
      message: "row ids must be unique",
    });
  }
  for (const [rowId, cells] of Object.entries(body.cell_keys ?? {})) {
    if (!rowIds.has(rowId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["cell_keys"],
        message: `cell_keys references unknown row "${rowId}"`,
      });
      return;
    }
    for (const colId of Object.keys(cells)) {
      if (!columnIds.has(colId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["cell_keys"],
          message: `cell_keys references unknown column "${colId}"`,
        });
        return;
      }
    }
  }
};

// Review fix (2026-08-14): a rubric whose total max is 0 can never be
// finalized — max_points > 0 is a DB CHECK and every score path rejects it,
// leaving responses permanently stuck in the review queue. Reject at
// authoring time instead. (Wire schema stays permissive; import clamps.)
const validateRubricMax = (
  body: { type: ItemType; rubric?: { criteria: { levels: { points: number }[] }[] } },
  ctx: z.RefinementCtx,
) => {
  if (body.type !== "essay" || !body.rubric) return;
  const max = body.rubric.criteria.reduce(
    (sum, c) => sum + Math.max(...c.levels.map((l) => l.points)),
    0,
  );
  if (max <= 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["rubric"],
      message:
        "rubric total max points must be > 0 — a 0-point rubric can never be scored",
    });
  }
};

export const CreateItemBody = z
  .discriminatedUnion("type", [
    SingleSelectMCItem,
    MultiSelectMCItem,
    ShortTextItem,
    EssayItem,
    MatchItem,
    OrderItem,
    HotspotItem,
    DrawingUploadItem,
    TableItem,
  ])
  .superRefine(validateScoring)
  .superRefine(validateUniqueIds)
  .superRefine(validateHotspot)
  .superRefine(validateTable)
  .superRefine(validateRubricMax);
export type CreateItemBody = z.infer<typeof CreateItemBody>;

// Map a validated item body to the items.config jsonb value. Emits a key
// only when set so config stays minimal (and export stays byte-stable).
// `existing` is the item's current config on PATCH (omitted on create):
// an omitted scoring_method preserves the stored pick; explicit null
// clears it; a value replaces it (finding 8).
export function itemConfigForWrite(
  body: CreateItemBody,
  existing?: ItemConfig,
): ItemConfig {
  const config: ItemConfig = {};
  const resolvedMethod =
    body.scoring_method === null
      ? undefined
      : (body.scoring_method ?? existing?.scoring_method);
  if (resolvedMethod) config.scoring_method = resolvedMethod;
  if (body.type === "match") {
    config.pairs = body.pairs;
    return config;
  }
  if (body.type === "order") {
    config.sequence = body.sequence;
    return config;
  }
  if (body.type === "hotspot") {
    if (body.image_asset_id != null) config.image_asset_id = body.image_asset_id;
    config.regions = body.regions;
    config.correct_region_ids = body.correct_region_ids;
    return config;
  }
  if (body.type === "drawing_upload") {
    if (body.prompt_asset_id != null) config.prompt_asset_id = body.prompt_asset_id;
    if (body.canvas != null) config.canvas = body.canvas;
    return config;
  }
  if (body.type === "table") {
    config.columns = body.columns;
    config.rows = body.rows;
    if (body.corner) config.corner = body.corner;
    // Rows with no keyed cell are dropped, and a key with nothing left is
    // omitted, so "no key" is the absence of the field rather than an
    // empty object — the same convention as every other optional config key.
    const keys = compactCellKeys(body.cell_keys);
    if (keys) config.cell_keys = keys;
    return config;
  }
  if (body.type !== "essay") return config;
  if (body.max_word_count !== undefined) config.max_word_count = body.max_word_count;
  if (body.placeholder) config.placeholder = body.placeholder;
  if (body.rubric !== undefined) config.rubric = body.rubric;
  const rubricId = resolveRubricId(body, existing);
  if (rubricId) config.rubric_id = rubricId;
  return config;
}

/**
 * Rubric library slice 3 (D-4), copy semantics. `config.rubric` is the
 * item's authoritative copy; `config.rubric_id` only records where that copy
 * came from, so it survives exactly as long as the copy is unchanged:
 *
 * - an explicit id attaches (the route has already checked the caller owns
 *   that rubric);
 * - an explicit null detaches;
 * - omitted + the rubric unchanged preserves the stored id (a PATCH that
 *   only renames the stem must not drop the provenance);
 * - omitted + the rubric CHANGED detaches — the teacher edited their copy,
 *   and a later change in the library must never rescore it behind their
 *   back. Removing the rubric entirely detaches too.
 */
function resolveRubricId(
  body: { rubric?: unknown; rubric_id?: string | null },
  existing?: ItemConfig,
): string | undefined {
  if (body.rubric_id !== undefined) return body.rubric_id ?? undefined;
  if (body.rubric === undefined) return undefined;
  const unchanged =
    existing?.rubric !== undefined &&
    canonicalJson(existing.rubric) === canonicalJson(body.rubric);
  return unchanged ? existing?.rubric_id : undefined;
}

/** JSON with object keys sorted, so "did the rubric change?" compares
 * CONTENT: the stored copy comes back from jsonb in insertion order and the
 * body's comes from the editor, and a plain JSON.stringify would call a
 * re-ordered but identical rubric a detach. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function compactCellKeys(
  keys: Record<string, Record<string, string>> | undefined,
): Record<string, Record<string, string>> | undefined {
  if (!keys) return undefined;
  const out: Record<string, Record<string, string>> = {};
  for (const [rowId, cells] of Object.entries(keys)) {
    if (Object.keys(cells).length > 0) out[rowId] = cells;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// Updates: same discriminated union — type is immutable in this slice, so
// PATCH requires the existing type. Validating the full shape on update
// catches mistakes like clearing all choices off an MC item.
export const UpdateItemBody = CreateItemBody;
export type UpdateItemBody = z.infer<typeof UpdateItemBody>;

export const ReorderBody = z.object({
  ordered_ids: z.array(z.string().uuid()).min(1),
});
export type ReorderBody = z.infer<typeof ReorderBody>;

export const ITEM_TYPE_VALUES = ITEM_TYPES;

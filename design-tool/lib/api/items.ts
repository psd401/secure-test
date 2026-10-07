import { z } from "zod";
import {
  DrawingCanvasSchema,
  RubricSchema,
  ScoringMethodSchema,
  fillBlankMarkerIds,
  isKeyedBlank,
  type FillBlankBlank,
  type ScoringMethod,
} from "@secure-test/schema";
import { ITEM_TYPES, type ItemConfig, type ItemType } from "@/db/schema";
import {
  MAX_STANDARDS,
  MAX_STANDARD_LENGTH,
  normalizeStandards,
} from "@/lib/standards/tags";

export const ChoiceShape = z.object({
  id: z.string().min(1).max(64),
  text: z.string().max(2000),
});
export type Choice = z.infer<typeof ChoiceShape>;

// BG slice 2 (docs/batch-item-generation-design.md, D-1): standards tags,
// stored in their own column (not config). The server normalizes — trim, drop
// empties, dedupe keeping order — and only then applies the limits, so a
// duplicate never counts toward the ten. ANY string is accepted: a catalog
// pick is `scheme:code`, and a code this catalog does not know (another
// version, another state) is kept as typed. On PATCH, omitted = preserve the
// stored tags; an array (even empty) replaces them.
export const StandardsField = z
  .array(z.string())
  .transform(normalizeStandards)
  .pipe(
    z
      .array(
        z
          .string()
          .max(MAX_STANDARD_LENGTH, `each standard must be at most ${MAX_STANDARD_LENGTH} characters`),
      )
      .max(MAX_STANDARDS, `at most ${MAX_STANDARDS} standards per item`),
  );

const BaseItemFields = {
  stem: z.string().min(1).max(10000),
  // Slice 36 + review fix (2026-08-14, finding 8): three-state on PATCH —
  // omitted = PRESERVE the stored method, explicit null = clear back to
  // the type default, value = set. (Previously omission cleared, which
  // silently reverted a teacher's 'human' pick to 'auto' on any partial
  // PATCH.) Cross-field rules live in the superRefine on the union below.
  scoring_method: ScoringMethodSchema.nullable().optional(),
  standards: StandardsField.optional(),
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
  // Numeric equivalence (2026-09-15): the per-item opt-out. Absent = false
  // = equivalent numeric forms score; true = exact form only.
  exact_form: z.boolean().optional(),
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
  // RT slice 1 (docs/rich-text-essay-design.md, D-1): let students format
  // their answer. Essay only — the other types' shapes don't know the key,
  // so Zod strips it from them like any unknown field.
  rich_text: z.boolean().optional(),
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

// FB slice 1 (docs/fill-in-blank-design.md): a sentence with blanks. The
// stem's `[[<id>]]` markers and `blanks` pair one to one (checked in
// validateFillBlank below). A blank is a dropdown with its own options (D-1,
// teacher's order — D-6; `correct_option_id` is its key) or typed (`keys`,
// D-5: several accepted answers, any one matches; `exact_form` opts that
// blank out of numeric equivalence like short_text). Keys are optional while
// drafting, as for every other type. Caps: 20 blanks, 12 options per
// dropdown, 10 keys per typed blank, 500-char option text and keys (a blank
// is a word or a phrase — the table-cell limit). A blank id is what the
// marker spells, so it uses the marker's character set.
const FillBlankId = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,40}$/, "blank ids are 1–40 letters, digits, _ or -");

export const FillBlankDropdownShape = z.object({
  id: FillBlankId,
  kind: z.literal("dropdown"),
  options: z
    .array(z.object({ id: z.string().min(1).max(64), text: z.string().min(1).max(500) }))
    .min(2, "a dropdown blank needs at least 2 options")
    .max(12, "a dropdown blank allows at most 12 options"),
  correct_option_id: z.string().min(1).nullable().optional(),
});

export const FillBlankTextShape = z.object({
  id: FillBlankId,
  kind: z.literal("text"),
  keys: z
    .array(z.string().min(1).max(500))
    .max(10, "a typed blank allows at most 10 accepted answers")
    .optional(),
  exact_form: z.boolean().optional(),
});

const FillBlankItem = z.object({
  type: z.literal("fill_blank"),
  ...BaseItemFields,
  choices: z.array(ChoiceShape).max(0).default([]),
  correct_choice_ids: z.array(z.string()).max(0).default([]),
  correct_answer: z.null().optional(),
  blanks: z
    .array(z.discriminatedUnion("kind", [FillBlankDropdownShape, FillBlankTextShape]))
    .min(1, "a fill-in-the-blank question needs at least one blank")
    .max(20, "a fill-in-the-blank question allows at most 20 blanks"),
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
  fill_blank: "auto",
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
  // FB: one point per keyed blank (lib/scoring/auto.ts), or hand-scored; a
  // fully keyless item is unscorable by auto, like an unkeyed table.
  fill_blank: ["auto", "human"],
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
  // FB (docs/fill-in-blank-design.md, "a blank without a key … is
  // hand-scored like a keyless table cell"): the E3-F1 rule — no keyed blank
  // means nothing to auto-score, so the unset default is human until the
  // first key exists.
  if (type === "fill_blank") {
    return (config?.blanks ?? []).some(isKeyedBlank) ? "auto" : "human";
  }
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

export { isKeyedBlank };

// FB slice 1: fill_blank cross-field integrity. Every `[[id]]` marker in the
// stem names exactly one blank and every blank has exactly one marker — the
// response and the client address blanks by id, and an orphan on either side
// is a sentence the student cannot complete (or a blank they cannot see).
// Within a dropdown, option ids are unique and the key names one of them.
const validateFillBlank = (
  body: {
    type: ItemType;
    stem: string;
    blanks?: (
      | { id: string; kind: "dropdown"; options: { id: string }[]; correct_option_id?: string | null }
      | { id: string; kind: "text" }
    )[];
  },
  ctx: z.RefinementCtx,
) => {
  if (body.type !== "fill_blank") return;
  const blanks = body.blanks ?? [];
  const blankIds = new Set(blanks.map((b) => b.id));
  if (blankIds.size !== blanks.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["blanks"], message: "blank ids must be unique" });
  }
  const markers = fillBlankMarkerIds(body.stem);
  const seen = new Set<string>();
  for (const id of markers) {
    if (seen.has(id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["stem"],
        message: `the stem has the blank [[${id}]] more than once`,
      });
    }
    seen.add(id);
    if (!blankIds.has(id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["stem"],
        message: `the stem's blank [[${id}]] has no matching entry in blanks`,
      });
    }
  }
  blanks.forEach((blank, i) => {
    if (!seen.has(blank.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["blanks", i],
        message: `blank "${blank.id}" has no [[${blank.id}]] marker in the stem`,
      });
    }
    if (blank.kind !== "dropdown") return;
    const optionIds = new Set(blank.options.map((o) => o.id));
    if (optionIds.size !== blank.options.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["blanks", i, "options"],
        message: `option ids in blank "${blank.id}" must be unique`,
      });
    }
    if (blank.correct_option_id != null && !optionIds.has(blank.correct_option_id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["blanks", i, "correct_option_id"],
        message: `blank "${blank.id}" names unknown correct option "${blank.correct_option_id}"`,
      });
    }
  });
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
    FillBlankItem,
  ])
  .superRefine(validateScoring)
  .superRefine(validateUniqueIds)
  .superRefine(validateHotspot)
  .superRefine(validateTable)
  .superRefine(validateFillBlank)
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
  if (body.type === "short_text") {
    // Stored only when ON — absence is the default, like every other
    // optional config key, so existing rows and exports stay byte-stable.
    if (body.exact_form) config.exact_form = true;
    return config;
  }
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
  if (body.type === "fill_blank") {
    config.blanks = compactBlanks(body.blanks);
    return config;
  }
  if (body.type !== "essay") return config;
  if (body.max_word_count !== undefined) config.max_word_count = body.max_word_count;
  if (body.placeholder) config.placeholder = body.placeholder;
  // D-1: stored only when ON, so existing rows and exports stay byte-stable.
  // Student-facing, so the publish lock (isAnswerKeyOnlyPatch) refuses a
  // change to it — it is compared with the rest of config.
  if (body.rich_text) config.rich_text = true;
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

/**
 * FB slice 1: the stored form of a fill_blank's blanks. Keys are emitted only
 * when set — a null `correct_option_id`, an empty `keys` list and a false
 * `exact_form` are all the absence of the field, the convention every other
 * optional config key follows, so "keyless" has one representation.
 */
export function compactBlanks(
  blanks: readonly (
    | { id: string; kind: "dropdown"; options: { id: string; text: string }[]; correct_option_id?: string | null }
    | { id: string; kind: "text"; keys?: string[]; exact_form?: boolean }
  )[],
): FillBlankBlank[] {
  return blanks.map((b): FillBlankBlank => {
    if (b.kind === "dropdown") {
      const out: FillBlankBlank = { id: b.id, kind: "dropdown", options: b.options };
      if (b.correct_option_id != null) out.correct_option_id = b.correct_option_id;
      return out;
    }
    const out: FillBlankBlank = { id: b.id, kind: "text" };
    if (b.keys && b.keys.length > 0) out.keys = b.keys;
    if (b.exact_form) out.exact_form = true;
    return out;
  });
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

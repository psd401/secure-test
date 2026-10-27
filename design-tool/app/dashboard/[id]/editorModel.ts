// Phase 4 slice D (docs/editor-redesign-design.md): the editor's view types
// and pure helpers, moved unchanged out of AssessmentEditor.tsx so the tab
// and per-type components can share them.
import type { AnswersReleaseSetting, FeedbackLevelSetting } from "@/lib/feedback/settingsUi";
import type { AccessLevel, AccessVia } from "@/lib/api/accessLevels";
import type {
  FillBlankBlank,
  HotspotRegion,
  MatchPair,
  Rubric,
  ScoringMethod,
  SequenceEntry,
  TableCellKeys,
  TableColumn,
  TableRow,
  StimulusGraph,
  GraphBoard,
  GraphKey,
} from "@secure-test/schema";
import { DEFAULT_GRAPH_BOARD } from "./GraphItemEditor";
import type { SectionAccommodations } from "@/lib/accommodations/sections";
import type { ItemType } from "@/db/schema";
import { ITEM_TYPE_LABEL } from "@/lib/items/typeLabel";
import type { OspiTier } from "@/lib/accommodations/catalog";
import {
  blanksForSave,
  blanksWithoutKeys,
  hasKeyedBlank,
  orderBlanksByStem,
} from "@/lib/items/fillBlankEditor";

// UX pass 1, slice 4 (decision 3.1): the tab lives in ?tab= so reload, Back
// and deep links land on the same panel. Param values are stable; the labels
// are the teacher's words (proposal §2.2).
export const EDITOR_TABS = ["questions", "settings", "accommodations", "students", "sessions"] as const;
export type EditorTab = (typeof EDITOR_TABS)[number];
export const TAB_LABEL: Record<EditorTab, string> = {
  questions: "Questions",
  settings: "Settings",
  // U-16: the teacher's words for what each tab decides — the old
  // "Accommodations" read as "for all students". `?tab=` values unchanged.
  accommodations: "Allowed on this test",
  students: "Exceptions for this test",
  sessions: "Test sessions",
};
export function parseTab(raw: string | null): EditorTab {
  return (EDITOR_TABS as readonly string[]).includes(raw ?? "")
    ? (raw as EditorTab)
    : "questions";
}

export interface Choice {
  id: string;
  text: string;
}

export interface ItemView {
  id: string;
  position: number;
  // E5 slice 1: the stimulus set this question belongs to, if any.
  item_set_id?: string | null;
  type: ItemType;
  stem: string;
  choices: Choice[];
  correct_choice_ids: string[];
  correct_answer: string | null;
  // Essay-only authoring metadata (slice 32); null for every other type.
  max_word_count: number | null;
  placeholder: string | null;
  // RT slice 1 (docs/rich-text-essay-design.md, D-1): essay only — true lets
  // students format their answer; null = off (the stored absence). Optional
  // so the per-type draft factories need not name it.
  rich_text?: boolean | null;
  // U-22: essay only — true shows the student a running word count with no
  // maximum; null = off. Optional like rich_text.
  show_word_count?: boolean | null;
  // Essay-only rubric (slice 33); null when unset / for other types.
  rubric: Rubric | null;
  // Rubric library slice 3 (D-4): which saved rubric the copy above came
  // from, when it came from one. Cleared the moment the teacher edits the
  // rubric by hand (the detach rule, mirrored from the server so the UI's
  // state matches what a save would store).
  rubric_id: string | null;
  // Match-only pair list (slice 47); null for every other type.
  pairs: MatchPair[] | null;
  // Order-only sequence (slice 48); null for every other type.
  sequence: SequenceEntry[] | null;
  // Hotspot-only (slice 49); null / empty for every other type.
  image_asset_id: string | null;
  regions: HotspotRegion[] | null;
  correct_region_ids: string[] | null;
  // Drawing/upload-only (slice 50, authoring-only). Canvas dims are
  // independently nullable in the editor so typing in one field never
  // mutates the other; persistItem sends the pair only when complete.
  // `background` (docs/drawing-background-design.md): null/absent = blank.
  prompt_asset_id: string | null;
  canvas: {
    width: number | null;
    height: number | null;
    background?: "grid" | "axes" | null;
  } | null;
  // Table-only (E3 slice 2): the grid and the per-cell expected answers;
  // null for every other type. cell_keys is the answer key.
  columns: TableColumn[] | null;
  rows: TableRow[] | null;
  corner: string | null;
  cell_keys: TableCellKeys | null;
  // Fill-in-the-blank only (FB slice 2): one entry per `[[id]]` marker in
  // the stem, kept in STEM order (docs/fill-in-blank-design.md §Progress —
  // "Blank n" is the array position everywhere a teacher reads it). A
  // dropdown's correct_option_id and a typed blank's keys are the key.
  blanks: FillBlankBlank[] | null;
  // Short-text only (numeric equivalence, 2026-09-15): true = compare the
  // answer's exact form, false/null = equivalent numeric forms score.
  exact_form: boolean | null;
  // Slice 36: null = type default (MC/short_text/match auto, essay human).
  scoring_method: ScoringMethod | null;
  // BG slice 2: standards tags (`scheme:code` or the teacher's own text);
  // every type, [] when none.
  standards: string[];
  // Graphing calculator (D-7): hide the test's calculator on this question's
  // page; null = off. Optional so the per-type draft factories need not name it.
  no_calculator?: boolean | null;
  // Graphing calculator D-8: a teacher-authored graph shown with the
  // question; null = none. Optional like no_calculator.
  graph?: StimulusGraph | null;
  // Graphing calculator D-9, graph items only: the board, and the key (an
  // answer key — it saves through the publish lock like other keys).
  board?: GraphBoard | null;
  graph_key?: GraphKey | null;
}

export interface AssessmentView {
  id: string;
  name: string;
  description: string;
  status: string;
  allow_llm_authoring: boolean;
  time_limit_seconds: number | null;
  /** Client paging (docs/client-paging-design.md): scroll | paged. */
  student_layout: "scroll" | "paged";
  /** Instant feedback (docs/instant-feedback-design.md): off | score | right_wrong | answers. */
  student_feedback: FeedbackLevelSetting;
  answers_release: AnswersReleaseSetting;
  /** ISO instant the teacher released the key, or null. */
  answers_released_at: string | null;
  /** Passage highlighting (docs/passage-highlighting-design.md). */
  allow_highlighting: boolean;
  /** Graphing calculator (docs/graphing-calculator-design.md D-7). */
  calculator_mode: "none" | "four_function" | "scientific" | "graphing";
  calculator_preset: "full" | "state_wa";
  allowed_accommodations: string[];
  construct_altering: string[];
  /** U-18: per class period (lib/accommodations/sections.ts). */
  section_accommodations: SectionAccommodations;
  /** teacher | school | district — a period may only narrow above teacher. */
  assigned_scope: string;
  /** D-1 (docs/archive-and-delete-design.md): governs the Settings-tab Delete draft action. */
  attempt_count: number;
  /** D-2 / D-3: null = live. ISO string, or null. */
  archived_at: string | null;
}

// E5 slice 1: a stimulus (passage / figure / data) shared by the contiguous
// questions whose item_set_id names it. Rendered once, above the first of
// them; the set has no position of its own.
// Multi-source stimulus slice 2 (docs/multi-source-stimulus-design.md): the
// ordered labelled sources under the introduction. Edited whole and PATCHed
// whole — a source has no id of its own (D-1).
export interface StimulusSourceView {
  label: string;
  text: string;
}

export interface ItemSetView {
  id: string;
  stimulus_text: string;
  sources: StimulusSourceView[];
  layout: "inline" | "own_page" | "side_by_side";
  /** E12: the source question this stimulus pulls each student's answer from. */
  source?: {
    item_id: string;
    stem: string;
    assessment_id: string;
    assessment_name: string;
    assessment_status: string;
  } | null;
}

/**
 * Access slice 3 (docs/access-model-design.md, D-4 (b)): what the caller may
 * do here. `via === "owner"` gates Share and the Settings tab's Duplicate /
 * Archive / Delete draft — all `own`-level routes (an admin also resolves to
 * `own`, via `"admin"`, but D-6 keeps admin WRITES to the admin surface, so
 * the gate is the narrower `via`, not `level`). `via === "grant"` is a
 * co-teacher — the editor shows "Co-teaching (owner: …)" instead.
 */
export interface EditorAccess {
  level: AccessLevel;
  via: AccessVia;
  owner_email: string | null;
}

/** Pure: does this access carry the owner-only actions (Share, Duplicate,
 * Archive, Delete draft)? Exported so the gate is testable without a DOM. */
export function isOwnerAccess(access: Pick<EditorAccess, "via">): boolean {
  return access.via === "owner";
}

/** Pure: the header's co-teaching reminder, or null when there is none to
 * show — an owner's or an admin's own view carries no such badge. */
export function coTeachingBadgeText(
  access: Pick<EditorAccess, "via" | "owner_email">,
): string | null {
  if (access.via !== "grant") return null;
  return access.owner_email ? `Co-teaching (owner: ${access.owner_email})` : "Co-teaching";
}

export type AiProposal = {
  type: ItemType;
  stem: string;
  choices: Choice[];
  correct_choice_ids: string[];
  correct_answer: string | null;
};

// UX pass 1 (proposal §2.2): plain nouns. "(authoring only)" is stale since
// the client ships drawing (finding 10.10).
export const TYPE_LABEL = ITEM_TYPE_LABEL;

/** What the items routes return: the DB row, with the type-specific fields in `config`. */
export interface ItemRow {
  id: string;
  position: number;
  item_set_id?: string | null;
  type: string;
  stem: string;
  choices: unknown;
  correct_choice_ids: unknown;
  correct_answer: string | null;
  config: {
    max_word_count?: number | null;
    placeholder?: string | null;
    rich_text?: boolean | null;
    show_word_count?: boolean | null;
    no_calculator?: boolean | null;
    graph?: StimulusGraph | null;
    graph_board?: GraphBoard | null;
    graph_key?: GraphKey | null;
    rubric?: Rubric | null;
    rubric_id?: string | null;
    pairs?: MatchPair[] | null;
    sequence?: SequenceEntry[] | null;
    image_asset_id?: string | null;
    regions?: HotspotRegion[] | null;
    correct_region_ids?: string[] | null;
    prompt_asset_id?: string | null;
    canvas?: {
      width: number | null;
      height: number | null;
      background?: "grid" | "axes" | null;
    } | null;
    columns?: TableColumn[] | null;
    rows?: TableRow[] | null;
    corner?: string | null;
    cell_keys?: TableCellKeys | null;
    blanks?: FillBlankBlank[] | null;
    exact_form?: boolean | null;
    scoring_method?: ScoringMethod | null;
  } | null;
  standards?: string[] | null;
}

// Same flattening as app/dashboard/[id]/page.tsx, so a row the API hands
// back can join the list without a round trip through the server component.
export function rowToView(r: ItemRow): ItemView {
  return {
    id: r.id,
    position: r.position,
    item_set_id: r.item_set_id ?? null,
    type: r.type as ItemType,
    stem: r.stem,
    choices: (r.choices ?? []) as Choice[],
    correct_choice_ids: (r.correct_choice_ids ?? []) as string[],
    correct_answer: r.correct_answer,
    max_word_count: r.config?.max_word_count ?? null,
    placeholder: r.config?.placeholder ?? null,
    rich_text: r.config?.rich_text ? true : null,
    show_word_count: r.config?.show_word_count ? true : null,
    no_calculator: r.config?.no_calculator ? true : null,
    graph: r.config?.graph ?? null,
    board: r.config?.graph_board ?? null,
    graph_key: r.config?.graph_key ?? null,
    rubric: r.config?.rubric ?? null,
    rubric_id: r.config?.rubric_id ?? null,
    pairs: r.config?.pairs ?? null,
    sequence: r.config?.sequence ?? null,
    image_asset_id: r.config?.image_asset_id ?? null,
    regions: r.config?.regions ?? null,
    correct_region_ids: r.config?.correct_region_ids ?? null,
    prompt_asset_id: r.config?.prompt_asset_id ?? null,
    canvas: r.config?.canvas ?? null,
    columns: r.config?.columns ?? null,
    rows: r.config?.rows ?? null,
    corner: r.config?.corner ?? null,
    cell_keys: r.config?.cell_keys ?? null,
    // Stem order on the way in, so "Blank n" in the form is Blank n everywhere.
    blanks: r.config?.blanks ? orderBlanksByStem(r.stem, r.config.blanks) : null,
    exact_form: r.config?.exact_form ?? null,
    scoring_method: r.config?.scoring_method ?? null,
    standards: r.standards ?? [],
  };
}

/**
 * What "Unsaved changes" compares: the card's own fields. `position` and
 * `item_set_id` are changed only by calls that have already succeeded
 * (Move, Add stimulus above, Join, Detach) and are never edited in the
 * card, so they must not read as an unsaved edit — before this (rows
 * 23–29 hand-run, 2026-09-02) every question touched by a Join showed the
 * badge and the page raised "Leave site?" with nothing to save.
 */
export function fingerprint(item: ItemView): string {
  const { position: _position, item_set_id: _set, ...own } = item;
  return JSON.stringify(own);
}

export function snapshotAll(list: ItemView[]): Record<string, string> {
  return Object.fromEntries(list.map((i) => [i.id, fingerprint(i)]));
}

// Explicit allowlist (slice 48 — a filter would silently include every new
// type). Essay is authored manually only — it is just a writing prompt.
// Match/order are structural and the AI providers' prompts/tools don't
// know them. Must stay identical to AI_GENERABLE_ITEM_TYPES in
// lib/ai/types.ts, which is the enforcing authority (E18 closed the gap where
// the server still accepted essay and returned a wrong-type item).
export const AI_GENERABLE_TYPES: readonly ItemType[] = [
  "multiple_choice_single",
  "multiple_choice_multi",
  "short_text",
];

// Slice 36: scoring-method picker. Mirrors ALLOWED_SCORING_METHODS /
// DEFAULT_SCORING_METHOD in lib/api/items.ts (the server-side authority).
export const SCORING_LABEL: Record<ScoringMethod, string> = {
  auto: "Auto (machine-scored)",
  ai: "AI (proposes a score, teacher approves)",
  human: "Human (teacher scores)",
  // Hybrid transparency (docs/hybrid-scoring-transparency-design.md, HC-1,
  // decision 4.2): the old "AI + human review" promised a review that a
  // confident score skips. The hint below the select says the rest.
  hybrid: "Hybrid (AI finalizes confident scores)",
};

export const HYBRID_HINT =
  "AI scores it is confident about count at once. You can still change any score.";

export const SCORING_OPTIONS: Record<ItemType, readonly ScoringMethod[]> = {
  multiple_choice_single: ["auto", "human"],
  multiple_choice_multi: ["auto", "human"],
  short_text: ["auto", "human"],
  essay: ["human", "ai", "hybrid"],
  match: ["auto", "human"],
  order: ["auto", "human"],
  hotspot: ["auto", "human"],
  drawing_upload: ["human"],
  table: ["auto", "human"],
  fill_blank: ["auto", "human"],
  graph: ["auto", "human"],
};

export const SCORING_DEFAULT: Record<ItemType, ScoringMethod> = {
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
  graph: "auto",
};

// E3-F1: a table's unset default depends on whether it has a key yet — the
// same rule as lib/api/items.ts effectiveScoringMethod, kept in sync so the
// "Default —" label matches what scoring will actually do.
export function hasCellKeys(cellKeys: TableCellKeys | null): boolean {
  return !!cellKeys && Object.values(cellKeys).some((row) => Object.keys(row).length > 0);
}
export function defaultScoringMethod(item: ItemView): ScoringMethod {
  if (item.type === "table") return hasCellKeys(item.cell_keys) ? "auto" : "human";
  // FB slice 2: the same E3-F1 rule for fill_blank (lib/api/items.ts
  // effectiveScoringMethod — no keyed blank → human).
  if (item.type === "fill_blank") return hasKeyedBlank(item.blanks) ? "auto" : "human";
  // Graphing calculator D-9: no key → hand-scored (lib/api/items.ts).
  if (item.type === "graph") return item.graph_key ? "auto" : "human";
  return SCORING_DEFAULT[item.type];
}

export const OSPI_TIER_LABEL: Record<OspiTier, string> = {
  universal: "Universal Tools (available to all students)",
  designated: "Designated Supports (educator-decided)",
  accommodation: "Accommodations (IEP / 504-documented)",
};

export const OSPI_TIER_ORDER: OspiTier[] = ["universal", "designated", "accommodation"];

// 2026-09-01: while published, the item PATCH route admits edits that touch
// nothing but the answer key. Mirror that here so "Save question" lights up
// for exactly those edits (the server is still the authority).
// BG slice 2 (14.1): standards tags save through the same door — the server's
// isAnswerKeyOnlyPatch admits them while published.
export const ANSWER_KEY_FIELDS = new Set(["correct_choice_ids", "correct_answer", "correct_region_ids", "standards", "graph_key"]);
export function answerKeyOnlyChange(before: ItemView | null, after: ItemView): boolean {
  if (!before) return false;
  const b = before as unknown as Record<string, unknown>;
  const a = after as unknown as Record<string, unknown>;
  return Object.keys(a).every((k) => {
    if (ANSWER_KEY_FIELDS.has(k)) return true;
    // FB slice 2: a fill_blank's key lives inside each blank — compare the
    // blanks with correct_option_id / keys removed, as the server's
    // isAnswerKeyOnlyPatch (lib/api/requireDraft.ts) does.
    if (k === "blanks") {
      return (
        JSON.stringify(blanksWithoutKeys(after.blanks)) ===
        JSON.stringify(blanksWithoutKeys(before.blanks))
      );
    }
    return JSON.stringify(a[k] ?? null) === JSON.stringify(b[k] ?? null);
  });
}

/** A published card's edit the publish lock admits: `persistedFp` is the
 * card's saved fingerprint, which omits position / item_set_id — put the
 * current ones back so only the card's own fields compare. */
export function keyOnlyEdit(persistedFp: string | undefined, item: ItemView): boolean {
  return answerKeyOnlyChange(
    persistedFp
      ? ({ ...(JSON.parse(persistedFp) as Omit<ItemView, "position" | "item_set_id">), position: item.position, item_set_id: item.item_set_id } as ItemView)
      : null,
    item,
  );
}

export function defaultItemFor(type: ItemType): Omit<ItemView, "id" | "position"> {
  if (type === "essay") {
    return {
      type,
      stem: "",
      choices: [],
      correct_choice_ids: [],
      correct_answer: null,
      max_word_count: null,
      placeholder: null,
      rubric: null,
      rubric_id: null,
      pairs: null,
      sequence: null,
      image_asset_id: null,
      regions: null,
      correct_region_ids: null,
      prompt_asset_id: null,
      canvas: null,
      columns: null,
      rows: null,
      corner: null,
      cell_keys: null,
      blanks: null,
      exact_form: null,
      scoring_method: null,
      standards: [],
    };
  }
  if (type === "short_text") {
    return {
      type,
      stem: "",
      choices: [],
      correct_choice_ids: [],
      correct_answer: "",
      max_word_count: null,
      placeholder: null,
      rubric: null,
      rubric_id: null,
      pairs: null,
      sequence: null,
      image_asset_id: null,
      regions: null,
      correct_region_ids: null,
      prompt_asset_id: null,
      canvas: null,
      columns: null,
      rows: null,
      corner: null,
      cell_keys: null,
      blanks: null,
      exact_form: null,
      scoring_method: null,
      standards: [],
    };
  }
  if (type === "match") {
    return {
      type,
      stem: "",
      choices: [],
      correct_choice_ids: [],
      correct_answer: null,
      max_word_count: null,
      placeholder: null,
      rubric: null,
      rubric_id: null,
      pairs: [
        { id: "p1", left: "", right: "" },
        { id: "p2", left: "", right: "" },
      ],
      sequence: null,
      image_asset_id: null,
      regions: null,
      correct_region_ids: null,
      prompt_asset_id: null,
      canvas: null,
      columns: null,
      rows: null,
      corner: null,
      cell_keys: null,
      blanks: null,
      exact_form: null,
      scoring_method: null,
      standards: [],
    };
  }
  if (type === "order") {
    return {
      type,
      stem: "",
      choices: [],
      correct_choice_ids: [],
      correct_answer: null,
      max_word_count: null,
      placeholder: null,
      rubric: null,
      rubric_id: null,
      pairs: null,
      sequence: [
        { id: "s1", label: "" },
        { id: "s2", label: "" },
      ],
      image_asset_id: null,
      regions: null,
      correct_region_ids: null,
      prompt_asset_id: null,
      canvas: null,
      columns: null,
      rows: null,
      corner: null,
      cell_keys: null,
      blanks: null,
      exact_form: null,
      scoring_method: null,
      standards: [],
    };
  }
  if (type === "hotspot") {
    return {
      type,
      stem: "",
      choices: [],
      correct_choice_ids: [],
      correct_answer: null,
      max_word_count: null,
      placeholder: null,
      rubric: null,
      rubric_id: null,
      pairs: null,
      sequence: null,
      image_asset_id: null,
      regions: [],
      correct_region_ids: [],
      prompt_asset_id: null,
      canvas: null,
      columns: null,
      rows: null,
      corner: null,
      cell_keys: null,
      blanks: null,
      exact_form: null,
      scoring_method: null,
      standards: [],
    };
  }
  if (type === "drawing_upload") {
    return {
      type,
      stem: "",
      choices: [],
      correct_choice_ids: [],
      correct_answer: null,
      max_word_count: null,
      placeholder: null,
      rubric: null,
      rubric_id: null,
      pairs: null,
      sequence: null,
      image_asset_id: null,
      regions: null,
      correct_region_ids: null,
      prompt_asset_id: null,
      canvas: null,
      columns: null,
      rows: null,
      corner: null,
      cell_keys: null,
      blanks: null,
      exact_form: null,
      scoring_method: null,
      standards: [],
    };
  }
  if (type === "fill_blank") {
    // FB slice 2: one typed blank to start; Add seeds the sentence that
    // carries its marker (FILL_BLANK_SEED_STEM, flagged by readiness).
    return {
      type,
      stem: "",
      choices: [],
      correct_choice_ids: [],
      correct_answer: null,
      max_word_count: null,
      placeholder: null,
      rubric: null,
      rubric_id: null,
      pairs: null,
      sequence: null,
      image_asset_id: null,
      regions: null,
      correct_region_ids: null,
      prompt_asset_id: null,
      canvas: null,
      columns: null,
      rows: null,
      corner: null,
      cell_keys: null,
      blanks: [{ id: "b1", kind: "text" }],
      exact_form: null,
      scoring_method: null,
      standards: [],
    };
  }
  if (type === "graph") {
    // Graphing calculator D-9: the default grid, no key yet; no choices.
    return {
      type,
      stem: "",
      choices: [],
      correct_choice_ids: [],
      correct_answer: null,
      max_word_count: null,
      placeholder: null,
      rubric: null,
      rubric_id: null,
      pairs: null,
      sequence: null,
      image_asset_id: null,
      regions: null,
      correct_region_ids: null,
      prompt_asset_id: null,
      canvas: null,
      columns: null,
      rows: null,
      corner: null,
      cell_keys: null,
      blanks: null,
      exact_form: null,
      scoring_method: null,
      standards: [],
      board: DEFAULT_GRAPH_BOARD,
      graph_key: null,
    };
  }
  if (type === "table") {
    // E3 slice 2: a 2 × 2 grid to start; the teacher renames and resizes it.
    return {
      type,
      stem: "",
      choices: [],
      correct_choice_ids: [],
      correct_answer: null,
      max_word_count: null,
      placeholder: null,
      rubric: null,
      rubric_id: null,
      pairs: null,
      sequence: null,
      image_asset_id: null,
      regions: null,
      correct_region_ids: null,
      prompt_asset_id: null,
      canvas: null,
      columns: [
        { id: "c1", label: "" },
        { id: "c2", label: "" },
      ],
      rows: [
        { id: "r1", label: "" },
        { id: "r2", label: "" },
      ],
      corner: null,
      cell_keys: null,
      blanks: null,
      exact_form: null,
      scoring_method: null,
      standards: [],
    };
  }
  return {
    type,
    stem: "",
    choices: [
      { id: "a", text: "" },
      { id: "b", text: "" },
    ],
    correct_choice_ids: [],
    correct_answer: null,
    max_word_count: null,
    placeholder: null,
    rubric: null,
    rubric_id: null,
    pairs: null,
    sequence: null,
    image_asset_id: null,
    regions: null,
    correct_region_ids: null,
    prompt_asset_id: null,
    canvas: null,
    columns: null,
    rows: null,
    corner: null,
    cell_keys: null,
    blanks: null,
    exact_form: null,
    scoring_method: null,
    standards: [],
  };
}

/**
 * The item PATCH body for a card (UpdateItemBody is a discriminated union, so
 * `type` and `stem` are always sent). Shared by Save question, the new
 * editor's autosave and History → Restore (R-5), so all three write through
 * one path.
 */
export function itemPatchBody(item: ItemView): Record<string, unknown> {
  const body: Record<string, unknown> = {
    type: item.type,
    stem: item.stem,
    choices: item.choices,
    correct_choice_ids: item.correct_choice_ids,
    correct_answer: item.correct_answer,
    // Graphing calculator (D-7): sent both ways so unticking clears it.
    no_calculator: item.no_calculator === true,
    // Graphing calculator D-8: null removes it, so send it both ways.
    graph: item.graph ?? null,
  };
  if (item.type === "essay") {
    // Omit when unset: the essay body schema treats these as optional
    // number/string, so null/empty would fail validation.
    if (item.max_word_count != null) body.max_word_count = item.max_word_count;
    if (item.placeholder) body.placeholder = item.placeholder;
    // RT slice 1 (D-1): only when on — absence is off.
    if (item.rich_text) body.rich_text = true;
    // U-22: only when on — absence is off.
    if (item.show_word_count) body.show_word_count = true;
    if (item.rubric) body.rubric = item.rubric;
    // Rubric library slice 3 (D-4): send the provenance EXPLICITLY both
    // ways. The server detaches an omitted rubric_id whenever the rubric
    // changed; sending null when the teacher has edited by hand (the view
    // cleared it below) and the id when one was applied keeps the stored
    // config equal to what this editor is showing either way.
    body.rubric_id = item.rubric_id;
  }
  if (item.type === "match") {
    body.pairs = item.pairs ?? [];
  }
  if (item.type === "order") {
    body.sequence = item.sequence ?? [];
  }
  if (item.type === "hotspot") {
    body.image_asset_id = item.image_asset_id;
    body.regions = item.regions ?? [];
    body.correct_region_ids = item.correct_region_ids ?? [];
  }
  if (item.type === "short_text") {
    // Numeric equivalence (2026-09-15): send it only when ON — the schema
    // takes an optional boolean and absence IS the default.
    if (item.exact_form) body.exact_form = true;
  }
  if (item.type === "table") {
    body.columns = item.columns ?? [];
    body.rows = item.rows ?? [];
    // Omit when unset: optional strings / records, null would fail.
    if (item.corner) body.corner = item.corner;
    if (item.cell_keys) body.cell_keys = item.cell_keys;
  }
  if (item.type === "fill_blank") {
    // FB slice 2: stem order, keys only when set (blank accepted answers
    // dropped) — what slice 1's compactBlanks stores anyway.
    body.blanks = blanksForSave(item.stem, item.blanks ?? []);
  }
  if (item.type === "graph") {
    // Graphing calculator D-9: null clears the key.
    body.board = item.board ?? DEFAULT_GRAPH_BOARD;
    body.key = item.graph_key ?? null;
  }
  if (item.type === "drawing_upload") {
    body.prompt_asset_id = item.prompt_asset_id;
    // A half-filled pair saves as "no canvas" (the inline hint tells the
    // teacher); a partial object would 400 on the server's 100-4000 rule.
    // A background rides INSIDE canvas, and width/height stay required, so
    // a background chosen with no complete size saves the 800 × 600 default
    // explicitly rather than `{ background }` alone (Blank omits the field).
    const width = item.canvas?.width ?? null;
    const height = item.canvas?.height ?? null;
    const background = item.canvas?.background ?? null;
    body.canvas =
      width != null && height != null
        ? { width, height, ...(background ? { background } : {}) }
        : background
          ? { width: 800, height: 600, background }
          : null;
  }
  // Review fix (2026-08-14): PATCH omission now PRESERVES the stored
  // method server-side, so "Type default" must clear via explicit null.
  body.scoring_method = item.scoring_method;
  // BG slice 2: always sent whole — an empty list clears the tags.
  body.standards = item.standards;
  return body;
}

"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Fragment, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { ArrowDown, ArrowUp, ListPlus, Plus, Trash2, X } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmptyState } from "@/components/app/EmptyState";
import { ApiError, itemErrorCopy } from "@/lib/ui/errorCopy";
import { plural } from "@/lib/ui/format";
import { NextStepCard } from "@/components/app/NextStepCard";
import { PageHeader } from "@/components/app/PageHeader";
import { PreviewFrame } from "@/components/app/PreviewFrame";
import { PublishDialog } from "@/components/app/PublishDialog";
import { AssessmentStatusBadge } from "@/components/app/StatusBadge";
import { StatusLine, type SaveState } from "@/components/app/StatusLine";
import { questionGaps, readinessChecks } from "./readiness";
import { ShareDialog } from "@/components/app/ShareDialog";
import type {
  HotspotRegion,
  MatchPair,
  Rubric,
  ScoringMethod,
  SequenceEntry,
  TableCellKeys,
  TableColumn,
  TableRow,
} from "@secure-test/schema";
import { MathPreview } from "./MathPreview";
import { ImagePicker } from "./ImagePicker";
import { MathTranslator } from "./MathTranslator";
import { EmphasisButtons } from "./EmphasisButtons";
import { SourcePicker, type SourceSummary } from "./SourcePicker";
import { OverridesPanel } from "./OverridesPanel";
import { ImportItemsPanel } from "./ImportItemsPanel";
import { SittingsPanel } from "./SittingsPanel";
import { PdfImportPanel } from "./PdfImportPanel";
import { RubricEditor } from "./RubricEditor";
import { nextChoiceId } from "@/lib/items/choiceIds";
import { ASSET_REF_ONE_RE } from "@/lib/items/extractAssetRefs";
import type { ItemType } from "@/db/schema";
import {
  ACCOMMODATION_CATALOG,
  type AccommodationCatalogEntry,
  type OspiTier,
} from "@/lib/accommodations/catalog";
import { MatchPairsEditor } from "./MatchPairsEditor";
import { SequenceEditor } from "./SequenceEditor";
import { HotspotEditor } from "./HotspotEditor";
import { TableEditor } from "./TableEditor";
import { createAutosave } from "@/lib/autosave";

// UX pass 1, slice 4 (decision 3.1): the tab lives in ?tab= so reload, Back
// and deep links land on the same panel. Param values are stable; the labels
// are the teacher's words (proposal §2.2).
const EDITOR_TABS = ["questions", "settings", "accommodations", "students", "sessions"] as const;
type EditorTab = (typeof EDITOR_TABS)[number];
const TAB_LABEL: Record<EditorTab, string> = {
  questions: "Questions",
  settings: "Settings",
  accommodations: "Accommodations",
  students: "Student accommodations",
  sessions: "Test sessions",
};
function parseTab(raw: string | null): EditorTab {
  return (EDITOR_TABS as readonly string[]).includes(raw ?? "")
    ? (raw as EditorTab)
    : "questions";
}

interface Choice {
  id: string;
  text: string;
}

interface ItemView {
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
  // Essay-only rubric (slice 33); null when unset / for other types.
  rubric: Rubric | null;
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
  // Slice 36: null = type default (MC/short_text/match auto, essay human).
  scoring_method: ScoringMethod | null;
}

interface AssessmentView {
  id: string;
  name: string;
  description: string;
  status: string;
  allow_llm_authoring: boolean;
  time_limit_seconds: number | null;
  /** Client paging (docs/client-paging-design.md): scroll | paged. */
  student_layout: "scroll" | "paged";
  allowed_accommodations: string[];
  construct_altering: string[];
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
interface StimulusSourceView {
  label: string;
  text: string;
}

interface ItemSetView {
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

interface Props {
  assessment: AssessmentView;
  initialItems: ItemView[];
  initialItemSets: ItemSetView[];
}

type AiProposal = {
  type: ItemType;
  stem: string;
  choices: Choice[];
  correct_choice_ids: string[];
  correct_answer: string | null;
};

// UX pass 1 (proposal §2.2): plain nouns. "(authoring only)" is stale since
// the client ships drawing (finding 10.10).
const TYPE_LABEL: Record<ItemType, string> = {
  multiple_choice_single: "Multiple choice",
  multiple_choice_multi: "Multiple select",
  short_text: "Short answer",
  essay: "Essay",
  match: "Matching",
  order: "Ordering",
  hotspot: "Click the image",
  drawing_upload: "Drawing",
  table: "Table",
};

/** What the items routes return: the DB row, with the type-specific fields in `config`. */
interface ItemRow {
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
    rubric?: Rubric | null;
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
    scoring_method?: ScoringMethod | null;
  } | null;
}

// Same flattening as app/dashboard/[id]/page.tsx, so a row the API hands
// back can join the list without a round trip through the server component.
function rowToView(r: ItemRow): ItemView {
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
    rubric: r.config?.rubric ?? null,
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
    scoring_method: r.config?.scoring_method ?? null,
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
function fingerprint(item: ItemView): string {
  const { position: _position, item_set_id: _set, ...own } = item;
  return JSON.stringify(own);
}

function snapshotAll(list: ItemView[]): Record<string, string> {
  return Object.fromEntries(list.map((i) => [i.id, fingerprint(i)]));
}

// Explicit allowlist (slice 48 — a filter would silently include every new
// type). Essay is authored manually only — it is just a writing prompt.
// Match/order are structural and the AI providers' prompts/tools don't
// know them. Must stay identical to AI_GENERABLE_ITEM_TYPES in
// lib/ai/types.ts, which is the enforcing authority (E18 closed the gap where
// the server still accepted essay and returned a wrong-type item).
const AI_GENERABLE_TYPES: readonly ItemType[] = [
  "multiple_choice_single",
  "multiple_choice_multi",
  "short_text",
];

// Slice 36: scoring-method picker. Mirrors ALLOWED_SCORING_METHODS /
// DEFAULT_SCORING_METHOD in lib/api/items.ts (the server-side authority).
const SCORING_LABEL: Record<ScoringMethod, string> = {
  auto: "Auto (machine-scored)",
  ai: "AI (proposes a score, teacher approves)",
  human: "Human (teacher scores)",
  hybrid: "Hybrid (AI + human review)",
};

const SCORING_OPTIONS: Record<ItemType, readonly ScoringMethod[]> = {
  multiple_choice_single: ["auto", "human"],
  multiple_choice_multi: ["auto", "human"],
  short_text: ["auto", "human"],
  essay: ["human", "ai", "hybrid"],
  match: ["auto", "human"],
  order: ["auto", "human"],
  hotspot: ["auto", "human"],
  drawing_upload: ["human"],
  table: ["auto", "human"],
};

const SCORING_DEFAULT: Record<ItemType, ScoringMethod> = {
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

// E3-F1: a table's unset default depends on whether it has a key yet — the
// same rule as lib/api/items.ts effectiveScoringMethod, kept in sync so the
// "Default —" label matches what scoring will actually do.
function hasCellKeys(cellKeys: TableCellKeys | null): boolean {
  return !!cellKeys && Object.values(cellKeys).some((row) => Object.keys(row).length > 0);
}
function defaultScoringMethod(item: ItemView): ScoringMethod {
  if (item.type === "table") return hasCellKeys(item.cell_keys) ? "auto" : "human";
  return SCORING_DEFAULT[item.type];
}

const OSPI_TIER_LABEL: Record<OspiTier, string> = {
  universal: "Universal Tools (available to all students)",
  designated: "Designated Supports (educator-decided)",
  accommodation: "Accommodations (IEP / 504-documented)",
};

const OSPI_TIER_ORDER: OspiTier[] = ["universal", "designated", "accommodation"];

// 2026-09-01: while published, the item PATCH route admits edits that touch
// nothing but the answer key. Mirror that here so "Save question" lights up
// for exactly those edits (the server is still the authority).
const ANSWER_KEY_FIELDS = new Set(["correct_choice_ids", "correct_answer", "correct_region_ids"]);
function answerKeyOnlyChange(before: ItemView | null, after: ItemView): boolean {
  if (!before) return false;
  const b = before as unknown as Record<string, unknown>;
  const a = after as unknown as Record<string, unknown>;
  return Object.keys(a).every(
    (k) => ANSWER_KEY_FIELDS.has(k) || JSON.stringify(a[k] ?? null) === JSON.stringify(b[k] ?? null),
  );
}

function defaultItemFor(type: ItemType): Omit<ItemView, "id" | "position"> {
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
      scoring_method: null,
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
      scoring_method: null,
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
      scoring_method: null,
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
      scoring_method: null,
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
      scoring_method: null,
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
      scoring_method: null,
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
      scoring_method: null,
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
    scoring_method: null,
  };
}

export function AssessmentEditor({ assessment, initialItems, initialItemSets }: Props) {
  const router = useRouter();
  const [items, setItems] = useState(initialItems);
  // E5 slice 1: stimulus sets, same authoritative-list posture as items —
  // each card compares with its last persisted snapshot for "Unsaved changes".
  const [itemSets, setItemSets] = useState<ItemSetView[]>(initialItemSets);
  const [persistedSets, setPersistedSets] = useState<Record<string, string>>(() =>
    Object.fromEntries(initialItemSets.map((s) => [s.id, JSON.stringify(s)])),
  );
  const [setSave, setSetSave] = useState<Record<string, SaveState>>({});
  const [name, setName] = useState(assessment.name);
  const [description, setDescription] = useState(assessment.description);
  // UI carries minutes; the API contract uses seconds. Convert at the
  // edges so the editor matches the create form (slice 19).
  const [timeLimitMinutes, setTimeLimitMinutes] = useState<string>(
    assessment.time_limit_seconds != null
      ? String(Math.round(assessment.time_limit_seconds / 60))
      : "",
  );
  const [allowedAccommodations, setAllowedAccommodations] = useState<
    Set<string>
  >(() => new Set(assessment.allowed_accommodations));
  const [constructAltering, setConstructAltering] = useState<Set<string>>(
    () => new Set(assessment.construct_altering),
  );
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const activeTab = parseTab(searchParams.get("tab"));
  function setActiveTab(tab: EditorTab) {
    router.replace(tab === "questions" ? pathname : `${pathname}?tab=${tab}`, {
      scroll: false,
    });
  }
  const [allowLlm, setAllowLlm] = useState(assessment.allow_llm_authoring);
  const [studentLayout, setStudentLayout] = useState<"scroll" | "paged">(assessment.student_layout);
  const [settingsSave, setSettingsSave] = useState<SaveState>({ kind: "idle" });
  const [accomSave, setAccomSave] = useState<SaveState>({ kind: "idle" });
  const [publishOpen, setPublishOpen] = useState<null | "publish" | "unpublish">(null);
  // E12 slice 4: which set's source picker is open.
  const [sourcePickerFor, setSourcePickerFor] = useState<string | null>(null);
  const [publishBusy, setPublishBusy] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  // D-1 (docs/archive-and-delete-design.md): Settings-tab "Delete draft".
  const [deleteDraftOpen, setDeleteDraftOpen] = useState(false);
  const [deletingDraft, setDeletingDraft] = useState(false);
  const [deleteDraftError, setDeleteDraftError] = useState<string | null>(null);
  // D-2 / D-3: Settings-tab "Archive" / "Unarchive". Tracked locally (not
  // derived from `assessment`, which never changes) and updated from the
  // PATCH response — archiving is not a publish-lock state, so it needs its
  // own source of truth the way `isLocked` reads the persisted status.
  const [archivedAt, setArchivedAt] = useState<string | null>(assessment.archived_at);
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);

  // UX pass 1, slice 5 (A-05..A-08): the list is authoritative on the client.
  // Each card is compared with its last persisted snapshot for "Unsaved
  // changes"; add / save / delete update the list directly instead of waiting
  // on router.refresh() — `items` was seeded once from props and never
  // re-read, so a refresh never showed a new card (A-07).
  const [persisted, setPersisted] = useState<Record<string, string>>(() =>
    snapshotAll(initialItems),
  );
  const [itemSave, setItemSave] = useState<Record<string, SaveState>>({});
  const [itemErrors, setItemErrors] = useState<Record<string, string>>({});
  const [adding, setAdding] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<ItemView | null>(null);
  const [deleting, setDeleting] = useState(false);
  const focusItemId = useRef<string | null>(null);

  const anyDirty =
    items.some((i) => persisted[i.id] !== fingerprint(i)) ||
    itemSets.some((s) => persistedSets[s.id] !== JSON.stringify(s));
  useEffect(() => {
    if (!anyDirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [anyDirty]);

  // After Add question, land the cursor in the new card.
  useEffect(() => {
    const id = focusItemId.current;
    if (!id) return;
    focusItemId.current = null;
    const el = document.getElementById(`stem-${id}`);
    if (el instanceof HTMLTextAreaElement) {
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      el.focus();
      // UX pass 2 slice 3 (P2-3): the stem arrives pre-filled ("New question");
      // select it so typing replaces the default instead of appending to it.
      el.select();
    }
  }, [items]);

  function setItemError(id: string, message: string | null) {
    setItemErrors((prev) => {
      const next = { ...prev };
      if (message === null) delete next[id];
      else next[id] = message;
      return next;
    });
  }

  const accommodationsByOspi = useMemo(() => {
    const groups = new Map<OspiTier, AccommodationCatalogEntry[]>();
    for (const entry of ACCOMMODATION_CATALOG) {
      const arr = groups.get(entry.ospi_tier) ?? [];
      arr.push(entry);
      groups.set(entry.ospi_tier, arr);
    }
    return groups;
  }, []);

  // C-6 / D-8 (docs/multi-source-stimulus-design.md): both toggles derive
  // allowed_accommodations and construct_altering from the SAME computed
  // next pair, then hand that pair to the autosave debounce — never a stale
  // value from a state setter's closure.
  function toggleAccommodation(id: string) {
    const nextAllowed = new Set(allowedAccommodations);
    if (nextAllowed.has(id)) nextAllowed.delete(id);
    else nextAllowed.add(id);
    // Unchecking the primary checkbox MUST also drop the id from the
    // construct_altering set — the invariant is "construct_altering ⊆
    // allowed_accommodations" and the API enforces it. Keep client +
    // server in agreement so save doesn't 400.
    const nextConstructAltering = new Set(constructAltering);
    if (!nextAllowed.has(id)) nextConstructAltering.delete(id);
    setAllowedAccommodations(nextAllowed);
    setConstructAltering(nextConstructAltering);
    scheduleAccomSave(nextAllowed, nextConstructAltering);
  }

  function toggleConstructAltering(id: string) {
    const nextConstructAltering = new Set(constructAltering);
    if (nextConstructAltering.has(id)) nextConstructAltering.delete(id);
    else nextConstructAltering.add(id);
    setConstructAltering(nextConstructAltering);
    scheduleAccomSave(allowedAccommodations, nextConstructAltering);
  }
  const [addType, setAddType] = useState<ItemType>("multiple_choice_single");

  // Slice 19 publish lock — disable every mutation control + show a
  // banner. The status select and "Save metadata" stay enabled so the
  // teacher has a one-click unlock.
  //
  // C9: this tracked the LOCAL select (`status`), so flipping the dropdown to
  // draft immediately re-enabled every input even though nothing had been
  // saved — the teacher would edit, hit save, and get a 409 from the unlock
  // chokepoint (which accepts a status-only change). Track the PERSISTED
  // status instead: inputs unlock only once the draft save actually lands and
  // router.refresh() brings back the new row.
  const isLocked = assessment.status === "published";
  const [shareOpen, setShareOpen] = useState(false);

  const [aiPanelOpen, setAiPanelOpen] = useState(false);
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiType, setAiType] = useState<ItemType>("multiple_choice_single");
  const [aiBusy, setAiBusy] = useState(false);
  const [proposal, setProposal] = useState<AiProposal | null>(null);

  const apiBase = `/api/assessments/${assessment.id}`;

  // Throws ApiError carrying the route's JSON `error` code, so every catch
  // below can pick teacher copy by code (lib/ui/errorCopy.ts itemErrorCopy)
  // instead of printing `${status} ${body}`.
  async function call(path: string, init?: RequestInit) {
    let res: Response;
    try {
      res = await fetch(path, init);
    } catch {
      throw new ApiError("network", 0);
    }
    if (!res.ok && res.status !== 204) {
      let code = `http_${res.status}`;
      let detail: string | undefined;
      try {
        const body = (await res.json()) as { error?: unknown; detail?: unknown };
        if (typeof body.error === "string") code = body.error;
        if (typeof body.detail === "string") detail = body.detail;
      } catch {
        // not JSON
      }
      throw new ApiError(code, res.status, detail);
    }
    return res;
  }

  function describe(e: unknown): string {
    if (e instanceof ApiError) {
      const copy = itemErrorCopy(e.code);
      return copy.showCode ? `${copy.message} ${e.code}` : copy.message;
    }
    return "Something went wrong. Try again.";
  }

  function refresh() {
    startTransition(() => router.refresh());
  }

  /**
   * After a panel import (CSV, PDF): pull the authoritative list and merge
   * it into state. `items` / `itemSets` are initialised from props ONCE, so
   * a router.refresh alone updates nothing visible — twice on 2026-09-02
   * the question list sat at its old count until a reload (rows 37 / 39).
   * Existing entries keep their in-state object (a card mid-edit is not
   * clobbered); new ones are appended in server order with a clean
   * snapshot; ids the server no longer has are dropped.
   */
  async function reloadFromServer() {
    try {
      const res = await call(`${apiBase}/items`);
      const body = (await res.json()) as {
        items: ItemRow[];
        item_sets: { id: string; stimulus_text: string; sources?: StimulusSourceView[]; layout: string }[];
      };
      const fresh = body.items.map(rowToView);
      setItems((prev) => {
        const byId = new Map(prev.map((i) => [i.id, i]));
        return fresh.map((f) => {
          const mine = byId.get(f.id);
          return mine ? { ...mine, position: f.position, item_set_id: f.item_set_id ?? null } : f;
        });
      });
      setPersisted((prev) => {
        const next = { ...prev };
        for (const f of fresh) if (!(f.id in next)) next[f.id] = fingerprint(f);
        return next;
      });
      const sets: ItemSetView[] = body.item_sets.map((s) => ({
        id: s.id,
        stimulus_text: s.stimulus_text,
        sources: s.sources ?? [],
        layout: s.layout as ItemSetView["layout"],
      }));
      setItemSets((prev) => {
        const byId = new Map(prev.map((s) => [s.id, s]));
        return sets.map((s) => byId.get(s.id) ?? s);
      });
      setPersistedSets((prev) => {
        const next = { ...prev };
        for (const s of sets) if (!(s.id in next)) next[s.id] = JSON.stringify(s);
        return next;
      });
    } catch (e) {
      setError(describe(e));
    }
    refresh();
  }

  // The Settings tab keeps an explicit Save (name/description/time
  // limit/AI/layout). Accommodations autosaves instead — see the
  // createAutosave wiring below.
  async function saveMetadata() {
    setError(null);
    // Convert minutes → seconds at the API boundary. Empty input → null
    // (no time limit). Validation matches what the create form enforces.
    const trimmed = timeLimitMinutes.trim();
    let time_limit_seconds: number | null = null;
    if (trimmed.length > 0) {
      const m = Number.parseInt(trimmed, 10);
      if (Number.isNaN(m) || m <= 0) {
        setSettingsSave({ kind: "failed", message: "Time limit must be a whole number of minutes." });
        return;
      }
      time_limit_seconds = m * 60;
    }
    setSettingsSave({ kind: "saving" });
    try {
      await call(apiBase, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name,
          description,
          time_limit_seconds,
          allow_llm_authoring: allowLlm,
          student_layout: studentLayout,
        }),
      });
      setSettingsSave({ kind: "saved", at: new Date() });
      refresh();
    } catch (e) {
      setSettingsSave({ kind: "failed", message: describe(e) });
    }
  }

  // C-6 / D-8 (docs/multi-source-stimulus-design.md): the Accommodations tab
  // used to only persist on a "Save accommodations" click — a teacher who
  // ticked boxes and navigated away lost the change silently. Autosave with
  // a 600ms debounce instead; created once via a lazy ref so the debounce
  // timer and in-flight tracking survive re-renders. `call` / `refresh` /
  // `describe` are function declarations (hoisted within the component),
  // safe to close over here regardless of source order.
  const accomAutosaveRef = useRef<ReturnType<
    typeof createAutosave<{ allowed: string[]; constructAltering: string[] }>
  > | null>(null);
  if (accomAutosaveRef.current === null) {
    accomAutosaveRef.current = createAutosave({
      delayMs: 600,
      save: async (value) => {
        await call(apiBase, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            allowed_accommodations: value.allowed,
            construct_altering: value.constructAltering,
          }),
        });
        refresh();
      },
      onState: (state, err) => {
        if (state === "saving") setAccomSave({ kind: "saving" });
        else if (state === "saved") setAccomSave({ kind: "saved", at: new Date() });
        else if (state === "failed") setAccomSave({ kind: "failed", message: describe(err) });
        // "idle" is never emitted by createAutosave; nothing to do.
      },
    });
  }

  function scheduleAccomSave(nextAllowed: Set<string>, nextConstructAltering: Set<string>) {
    if (isLocked) return;
    accomAutosaveRef.current?.schedule({
      allowed: [...nextAllowed],
      constructAltering: [...nextConstructAltering],
    });
  }

  // Flush a pending accommodations autosave before it can be lost: when the
  // teacher switches away from the tab, and on unmount (covered by the same
  // cleanup when the tab is still "accommodations" at that point).
  useEffect(() => {
    if (activeTab !== "accommodations") return;
    return () => {
      accomAutosaveRef.current?.flush();
    };
  }, [activeTab]);

  // Publish / Unpublish are status-only PATCHes — the one change the server
  // accepts on a published row (lib/api/requireDraft.ts, isUnlockOnlyPatch).
  // `assessment.status` (persisted) drives isLocked, so inputs unlock only
  // once router.refresh() brings the new row down (C9).
  async function setPublished(next: "published" | "draft") {
    setPublishBusy(true);
    setError(null);
    try {
      await call(apiBase, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: next }),
      });
      setPublishOpen(null);
      refresh();
    } catch (e) {
      setError(describe(e));
    } finally {
      setPublishBusy(false);
    }
  }

  // D-1 (docs/archive-and-delete-design.md): a raw fetch rather than call()
  // because the 409 body carries `attempts` — a field call()'s ApiError
  // doesn't preserve — and the dialog needs that count, not just a message.
  async function deleteDraft() {
    setDeletingDraft(true);
    setDeleteDraftError(null);
    try {
      const res = await fetch(apiBase, { method: "DELETE" });
      if (res.status === 204) {
        router.push("/dashboard");
        return;
      }
      let body: { error?: unknown; attempts?: unknown } = {};
      try {
        body = (await res.json()) as typeof body;
      } catch {
        // not JSON
      }
      if (res.status === 409 && body.error === "has_attempts") {
        const n = typeof body.attempts === "number" ? body.attempts : 0;
        setDeleteDraftError(`${plural(n, "attempt")} — archive instead.`);
      } else {
        setDeleteDraftError(
          describe(
            new ApiError(typeof body.error === "string" ? body.error : `http_${res.status}`, res.status),
          ),
        );
      }
    } catch {
      setDeleteDraftError(describe(new ApiError("network", 0)));
    } finally {
      setDeletingDraft(false);
    }
  }

  // D-2 / D-3: Archive is NOT disabled by the publish lock — archiving a
  // Published assessment is allowed, since it changes no content the lock
  // protects. Same 409 session_open guard as the sitting archive.
  async function toggleArchive() {
    setArchiveBusy(true);
    setArchiveError(null);
    try {
      const res = await call(apiBase, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ archived: archivedAt === null }),
      });
      const body = (await res.json()) as { assessment?: { archived_at?: string | null } };
      setArchivedAt(body.assessment?.archived_at ?? null);
    } catch (e) {
      if (e instanceof ApiError && e.code === "session_open") {
        setArchiveError("Close its open test session first.");
      } else {
        setArchiveError(describe(e));
      }
    } finally {
      setArchiveBusy(false);
    }
  }

  async function addItem() {
    setError(null);
    const draft = defaultItemFor(addType);
    const body: Record<string, unknown> =
      addType === "essay"
        ? { type: "essay" as const, stem: "New essay prompt" }
        : addType === "short_text"
          ? { ...draft, stem: "New short-text item", correct_answer: "answer" }
          : addType === "match"
            ? {
                ...draft,
                stem: "New matching item",
                pairs: [
                  { id: "p1", left: "Left A", right: "Right A" },
                  { id: "p2", left: "Left B", right: "Right B" },
                ],
              }
            : addType === "order"
              ? {
                  ...draft,
                  stem: "New ordering item",
                  sequence: [
                    { id: "s1", label: "First step" },
                    { id: "s2", label: "Second step" },
                  ],
                }
              : addType === "hotspot"
                ? // Draft create: image + regions come after, in the editor.
                  { ...draft, stem: "New hotspot item" }
                : addType === "drawing_upload"
                  ? { ...draft, stem: "New drawing prompt" }
                  : addType === "table"
                    ? {
                        ...draft,
                        stem: "New table",
                        columns: [
                          { id: "c1", label: "Column A" },
                          { id: "c2", label: "Column B" },
                        ],
                        rows: [
                          { id: "r1", label: "Row 1" },
                          { id: "r2", label: "Row 2" },
                        ],
                      }
                  : {
                  ...draft,
                  stem: "New question",
                  choices: [
                    { id: "a", text: "Choice A" },
                    { id: "b", text: "Choice B" },
                  ],
                  correct_choice_ids: ["a"],
                };
    // ItemView carries pairs/sequence: null for other types; the API schema
    // doesn't know those keys outside match/order, so drop the nulls.
    if (body.pairs == null) delete body.pairs;
    if (body.sequence == null) delete body.sequence;
    if (body.image_asset_id == null) delete body.image_asset_id;
    if (body.regions == null) delete body.regions;
    if (body.correct_region_ids == null) delete body.correct_region_ids;
    if (body.prompt_asset_id == null) delete body.prompt_asset_id;
    if (body.canvas == null) delete body.canvas;
    if (body.columns == null) delete body.columns;
    if (body.rows == null) delete body.rows;
    if (body.corner == null) delete body.corner;
    if (body.cell_keys == null) delete body.cell_keys;
    // Draft spreads carry scoring_method: null; the item schema knows the
    // key now and optional-enum rejects null, so omit until picked.
    if (body.scoring_method == null) delete body.scoring_method;
    setAdding(true);
    try {
      const res = await call(`${apiBase}/items`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const created = rowToView(((await res.json()) as { item: ItemRow }).item);
      setItems((prev) => [...prev, created]);
      setPersisted((prev) => ({ ...prev, [created.id]: fingerprint(created) }));
      focusItemId.current = created.id;
    } catch (e) {
      setError(describe(e));
    } finally {
      setAdding(false);
    }
  }

  async function persistItem(item: ItemView) {
    setError(null);
    const body: Record<string, unknown> = {
      type: item.type,
      stem: item.stem,
      choices: item.choices,
      correct_choice_ids: item.correct_choice_ids,
      correct_answer: item.correct_answer,
    };
    if (item.type === "essay") {
      // Omit when unset: the essay body schema treats these as optional
      // number/string, so null/empty would fail validation.
      if (item.max_word_count != null) body.max_word_count = item.max_word_count;
      if (item.placeholder) body.placeholder = item.placeholder;
      if (item.rubric) body.rubric = item.rubric;
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
    if (item.type === "table") {
      body.columns = item.columns ?? [];
      body.rows = item.rows ?? [];
      // Omit when unset: optional strings / records, null would fail.
      if (item.corner) body.corner = item.corner;
      if (item.cell_keys) body.cell_keys = item.cell_keys;
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
    setItemError(item.id, null);
    setItemSave((prev) => ({ ...prev, [item.id]: { kind: "saving" } }));
    try {
      await call(`${apiBase}/items/${item.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      // The snapshot is what we SENT: edits typed while the request was in
      // flight keep the card dirty.
      setPersisted((prev) => ({ ...prev, [item.id]: fingerprint(item) }));
      setItemSave((prev) => ({ ...prev, [item.id]: { kind: "saved", at: new Date() } }));
    } catch (e) {
      setItemSave((prev) => ({ ...prev, [item.id]: { kind: "idle" } }));
      setItemError(item.id, describe(e));
    }
  }

  async function confirmDelete() {
    const target = pendingDelete;
    if (!target) return;
    setDeleting(true);
    setItemError(target.id, null);
    try {
      await call(`${apiBase}/items/${target.id}`, { method: "DELETE" });
      setItems((prev) => prev.filter((i) => i.id !== target.id));
      setPersisted((prev) => {
        const next = { ...prev };
        delete next[target.id];
        return next;
      });
    } catch (e) {
      setItemError(target.id, describe(e));
    } finally {
      setDeleting(false);
      setPendingDelete(null);
    }
  }

  /** E5 slice 1: contiguous blocks in list order — a set's questions are one block. */
  function blocksOf(list: ItemView[]): ItemView[][] {
    const blocks: ItemView[][] = [];
    for (const it of list) {
      const last = blocks[blocks.length - 1];
      if (last && it.item_set_id && last[0]!.item_set_id === it.item_set_id) last.push(it);
      else blocks.push([it]);
    }
    return blocks;
  }

  async function move(itemId: string, direction: -1 | 1) {
    setError(null);
    // E5 slice 1: a set's questions move as one block (the API refuses an
    // order that splits a set), so the unit of movement is the block.
    const blocks = blocksOf(items);
    const bi = blocks.findIndex((b) => b.some((i) => i.id === itemId));
    if (bi < 0) return;
    const swapWith = bi + direction;
    if (swapWith < 0 || swapWith >= blocks.length) return;
    const nextBlocks = [...blocks];
    [nextBlocks[bi], nextBlocks[swapWith]] = [nextBlocks[swapWith]!, nextBlocks[bi]!];
    const next = nextBlocks.flat();
    setItems(next);
    try {
      await call(`${apiBase}/items/reorder`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ordered_ids: next.map((i) => i.id) }),
      });
    } catch (e) {
      setItems(items);
      setError(describe(e));
    }
  }

  function updateItem(itemId: string, mut: (item: ItemView) => ItemView) {
    setItems((prev) => prev.map((i) => (i.id === itemId ? mut(i) : i)));
  }

  // ---- E5 slice 1: stimulus sets ----
  const jsonInit = (method: string, body: unknown): RequestInit => ({
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  function updateSet(setId: string, mut: (s: ItemSetView) => ItemSetView) {
    setItemSets((prev) => prev.map((s) => (s.id === setId ? mut(s) : s)));
  }

  // ---- Multi-source stimulus slice 2: the set's labelled sources ----
  // Edited in place on the ItemSetView; "Save stimulus" PATCHes the whole
  // ordered list, so nothing here talks to the server on its own.
  function updateSources(setId: string, mut: (list: StimulusSourceView[]) => StimulusSourceView[]) {
    updateSet(setId, (sv) => ({ ...sv, sources: mut(sv.sources) }));
  }

  function updateSource(setId: string, index: number, mut: (s: StimulusSourceView) => StimulusSourceView) {
    updateSources(setId, (list) => list.map((s, i) => (i === index ? mut(s) : s)));
  }

  /** "Source A", "Source B", … then "Source 27" past the alphabet. */
  function nextSourceLabel(count: number): string {
    return count < 26 ? `Source ${String.fromCharCode(65 + count)}` : `Source ${count + 1}`;
  }

  function addSource(setId: string) {
    updateSources(setId, (list) => [...list, { label: nextSourceLabel(list.length), text: "" }]);
  }

  function moveSource(setId: string, index: number, delta: -1 | 1) {
    updateSources(setId, (list) => {
      const to = index + delta;
      if (to < 0 || to >= list.length) return list;
      const next = [...list];
      const [moved] = next.splice(index, 1);
      next.splice(to, 0, moved!);
      return next;
    });
  }

  function removeSource(setId: string, index: number) {
    updateSources(setId, (list) => list.filter((_, i) => i !== index));
  }

  function dropSetLocally(setId: string) {
    setItemSets((prev) => prev.filter((s) => s.id !== setId));
    setPersistedSets((prev) => {
      const next = { ...prev };
      delete next[setId];
      return next;
    });
  }

  /** First and last list index of a set's block, or null if it has no questions here. */
  function setBounds(setId: string): { first: number; last: number } | null {
    const idxs = items.map((it, i) => (it.item_set_id === setId ? i : -1)).filter((i) => i >= 0);
    if (idxs.length === 0) return null;
    return { first: Math.min(...idxs), last: Math.max(...idxs) };
  }

  /** "Add stimulus above": a set of one, grown by joining neighbours. */
  async function addStimulus(itemId: string) {
    setError(null);
    try {
      const res = await call(`${apiBase}/item-sets`, jsonInit("POST", { item_ids: [itemId] }));
      const body = (await res.json()) as { item_set: ItemSetView & { stimulus_text: string } };
      const view: ItemSetView = {
        id: body.item_set.id,
        stimulus_text: body.item_set.stimulus_text,
        sources: body.item_set.sources ?? [],
        layout: body.item_set.layout,
      };
      setItemSets((prev) => [...prev, view]);
      setPersistedSets((prev) => ({ ...prev, [view.id]: JSON.stringify(view) }));
      updateItem(itemId, (i) => ({ ...i, item_set_id: view.id }));
    } catch (e) {
      setItemError(itemId, describe(e));
    }
  }

  /** "Join stimulus above": attach to the previous question's set. */
  async function joinStimulusAbove(itemId: string) {
    const idx = items.findIndex((i) => i.id === itemId);
    const setId = idx > 0 ? (items[idx - 1]!.item_set_id ?? null) : null;
    if (!setId) return;
    setError(null);
    try {
      await call(`${apiBase}/item-sets/${setId}/items`, jsonInit("POST", { item_id: itemId }));
      updateItem(itemId, (i) => ({ ...i, item_set_id: setId }));
    } catch (e) {
      setItemError(itemId, describe(e));
    }
  }

  /** Detach an end question; the server deletes a set that empties. */
  async function detachFromStimulus(itemId: string) {
    const setId = items.find((i) => i.id === itemId)?.item_set_id;
    if (!setId) return;
    setError(null);
    try {
      const res = await call(`${apiBase}/item-sets/${setId}/items/${itemId}`, { method: "DELETE" });
      const body = (await res.json().catch(() => null)) as { item_set_deleted?: boolean } | null;
      updateItem(itemId, (i) => ({ ...i, item_set_id: null }));
      if (body?.item_set_deleted) dropSetLocally(setId);
    } catch (e) {
      setItemError(itemId, describe(e));
    }
  }

  async function saveStimulus(setId: string) {
    const set = itemSets.find((s) => s.id === setId);
    if (!set) return;
    setSetSave((p) => ({ ...p, [setId]: { kind: "saving" } }));
    try {
      const res = await call(
        `${apiBase}/item-sets/${setId}`,
        jsonInit("PATCH", {
          stimulus_text: set.stimulus_text,
          // Multi-source stimulus slice 2: sources go whole, in order.
          sources: set.sources,
          layout: set.layout,
        }),
      );
      const body = (await res.json()) as { item_set: ItemSetView };
      const saved: ItemSetView = {
        ...set,
        stimulus_text: body.item_set.stimulus_text,
        sources: body.item_set.sources ?? [],
        layout: body.item_set.layout,
      };
      setItemSets((prev) => prev.map((s) => (s.id === setId ? saved : s)));
      setPersistedSets((prev) => ({ ...prev, [setId]: JSON.stringify(saved) }));
      setSetSave((p) => ({ ...p, [setId]: { kind: "saved", at: new Date() } }));
    } catch (e) {
      setSetSave((p) => ({ ...p, [setId]: { kind: "failed", message: describe(e) } }));
    }
  }

  /** E12 slice 4: point the set at a question elsewhere (or clear it). The
   * server re-checks ownership, type and "another assessment"; on success
   * the view and its snapshot change together — a source is server-managed,
   * never an unsaved edit. */
  async function setSource(setId: string, source: SourceSummary | null) {
    setError(null);
    const res = await call(
      `${apiBase}/item-sets/${setId}`,
      jsonInit("PATCH", { source_item_id: source ? source.item_id : null }),
    );
    await res.json().catch(() => null);
    const apply = (s: ItemSetView): ItemSetView => ({ ...s, source });
    setItemSets((prev) => prev.map((s) => (s.id === setId ? apply(s) : s)));
    setPersistedSets((prev) => {
      const before = prev[setId] ? (JSON.parse(prev[setId]!) as ItemSetView) : null;
      return before ? { ...prev, [setId]: JSON.stringify(apply(before)) } : prev;
    });
    setSourcePickerFor((cur) => (cur === setId ? null : cur));
  }

  /** Remove the stimulus; its questions stay, on their own again. */
  async function removeStimulus(setId: string) {
    setError(null);
    try {
      await call(`${apiBase}/item-sets/${setId}`, { method: "DELETE" });
      setItems((prev) => prev.map((i) => (i.item_set_id === setId ? { ...i, item_set_id: null } : i)));
      dropSetLocally(setId);
    } catch (e) {
      setError(describe(e));
    }
  }

  async function generateWithAi() {
    setError(null);
    setAiBusy(true);
    setProposal(null);
    try {
      const res = await call("/api/ai/generate-item", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          assessment_id: assessment.id,
          item_type: aiType,
          prompt: aiPrompt,
        }),
      });
      const data = (await res.json()) as { provider: string; proposal: AiProposal };
      setProposal(data.proposal);
    } catch (e) {
      setError(describe(e));
    } finally {
      setAiBusy(false);
    }
  }

  async function saveProposal() {
    if (!proposal) return;
    setError(null);
    try {
      const res = await call(`${apiBase}/items`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(proposal),
      });
      const created = rowToView(((await res.json()) as { item: ItemRow }).item);
      setItems((prev) => [...prev, created]);
      setPersisted((prev) => ({ ...prev, [created.id]: fingerprint(created) }));
      setProposal(null);
      setAiPanelOpen(false);
      setAiPrompt("");
      focusItemId.current = created.id;
    } catch (e) {
      setError(describe(e));
    }
  }

  function discardProposal() {
    setProposal(null);
  }

  function updateProposal(mut: (p: AiProposal) => AiProposal) {
    setProposal((prev) => (prev ? mut(prev) : prev));
  }

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <PageHeader
          crumbs={[{ label: "Assessments", href: "/dashboard" }]}
          title={assessment.name}
          status={
            <>
              <AssessmentStatusBadge status={assessment.status} />
              {/* D-2 / D-3: a status change never happens on archive — this
                  badge is the only thing that says so at a glance. */}
              {archivedAt ? <Badge variant="neutral">Archived</Badge> : null}
            </>
          }
          description={assessment.description || undefined}
          actions={
            <>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setActiveTab("questions");
                  setPreviewOpen(true);
                }}
              >
                Preview
              </Button>
              <Button asChild variant="outline">
                <a href={`/preview/${assessment.id}?print=1`} target="_blank" rel="noopener noreferrer">
                  Print
                </a>
              </Button>
              <Button type="button" variant="outline" onClick={() => setShareOpen(true)}>
                Share
              </Button>
              {isLocked ? (
                <Button type="button" variant="outline" onClick={() => setPublishOpen("unpublish")}>
                  Unpublish
                </Button>
              ) : (
                <Button type="button" onClick={() => setPublishOpen("publish")}>
                  Publish
                </Button>
              )}
            </>
          }
        />
        {/* Demoted, not removed (open question 3.3): the routes exist and a
            working link should not vanish during the pilot. The export carries
            include_hidden_rubrics=1 because it is the teacher's own backup, so
            it stays lossless; the route's DEFAULT omits rubrics the teacher hid
            from students (phase-1-2 review, B8). */}
        <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
          <a href={`${apiBase}/export?include_hidden_rubrics=1`} className="hover:underline">
            Download backup (.json)
          </a>
          <Link href={`/dashboard/${assessment.id}/scoring`} className="hover:underline">
            Scoring queue
          </Link>
          <Link href={`/dashboard/${assessment.id}/results`} className="hover:underline">
            Results
          </Link>
        </p>
      </div>

      {error ? (
        <Alert variant="destructive">
          <AlertTitle>{error}</AlertTitle>
        </Alert>
      ) : null}

      {isLocked ? (
        <Alert variant="warning">
          <AlertTitle>Published — locked so a running test can&apos;t change.</AlertTitle>
          <AlertDescription>
            Unpublish to edit. Answer keys can still be changed here; responses
            already scored keep their scores.
          </AlertDescription>
        </Alert>
      ) : null}

      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(parseTab(v))}>
        <TabsList aria-label="Assessment editor sections">
          {EDITOR_TABS.map((t) => (
            <TabsTrigger key={t} value={t}>
              {TAB_LABEL[t]}
            </TabsTrigger>
          ))}
        </TabsList>

      <TabsContent value="settings" className="mt-6">
      <section className="max-w-xl space-y-4">
        <label className="block">
          <span className="block text-sm font-medium">Name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={isLocked}
            className="mt-1 w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm disabled:opacity-60"
          />
        </label>
        <label className="block">
          <span className="block text-sm font-medium">Description</span>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            disabled={isLocked}
            rows={2}
            className="mt-1 w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm disabled:opacity-60"
          />
        </label>
        <label className="block">
          <span className="block text-sm font-medium">Time limit (minutes)</span>
          <input
            type="number"
            min={1}
            step={1}
            value={timeLimitMinutes}
            onChange={(e) => setTimeLimitMinutes(e.target.value)}
            disabled={isLocked}
            placeholder="(none)"
            className="mt-1 w-32 rounded-md border border-border bg-transparent px-3 py-2 text-sm disabled:opacity-60"
          />
          <span className="ml-2 text-xs text-muted-foreground">
            Leave blank for untimed
          </span>
        </label>
        <label className="block">
          <span className="block text-sm font-medium">How students move through the test</span>
          <NativeSelect
            size="sm"
            value={studentLayout}
            onChange={(e) => setStudentLayout(e.target.value as "scroll" | "paged")}
            disabled={isLocked}
            className="mt-1"
          >
            <NativeSelectOption value="scroll">One scrolling page</NativeSelectOption>
            <NativeSelectOption value="paged">One question at a time</NativeSelectOption>
          </NativeSelect>
          <span className="block text-xs text-muted-foreground">
            One question at a time gives each question its own page with Previous / Next; a
            stimulus set to &ldquo;On its own page&rdquo; becomes a passage page. The print view is
            unaffected.
          </span>
        </label>
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            checked={allowLlm}
            onChange={(e) => setAllowLlm(e.target.checked)}
            disabled={isLocked}
            className="mt-1"
          />
          <span className="text-sm">
            Allow AI help when writing questions
            <span className="block text-xs text-muted-foreground">
              Adds a Generate with AI button on the Questions tab.
            </span>
          </span>
        </label>

        <div className="flex items-center gap-3">
          <Button
            type="button"
            onClick={() => saveMetadata()}
            disabled={isPending || isLocked || settingsSave.kind === "saving"}
          >
            Save settings
          </Button>
          <StatusLine state={settingsSave} />
        </div>

        {/* D-2 / D-3: NOT gated by isLocked — archiving a Published
            assessment is allowed, since it changes no content the publish
            lock protects. */}
        <div className="border-t border-border pt-4">
          <Button
            type="button"
            variant="outline"
            onClick={() => void toggleArchive()}
            disabled={archiveBusy}
          >
            {archiveBusy ? (archivedAt ? "Unarchiving…" : "Archiving…") : archivedAt ? "Unarchive" : "Archive"}
          </Button>
          <p className="mt-1 text-xs text-muted-foreground">
            Archived assessments leave the list; sessions, attempts and results are kept.
          </p>
          {archiveError ? (
            <p role="alert" className="mt-1 text-xs text-destructive">
              {archiveError}
            </p>
          ) : null}
        </div>

        {/* D-1 (docs/archive-and-delete-design.md): a draft with attempts on it
            can't be deleted here either — the confirm dialog reads that back
            from the DELETE route, this disables the button up front so the
            teacher isn't invited to try. */}
        <div className="border-t border-border pt-4">
          <Button
            type="button"
            variant="destructive"
            onClick={() => {
              setDeleteDraftError(null);
              setDeleteDraftOpen(true);
            }}
            disabled={isLocked || assessment.attempt_count > 0}
          >
            Delete draft
          </Button>
          {isLocked ? (
            <p className="mt-1 text-xs text-muted-foreground">Unpublish to delete.</p>
          ) : assessment.attempt_count > 0 ? (
            <p className="mt-1 text-xs text-muted-foreground">
              {plural(assessment.attempt_count, "attempt")} — archive instead.
            </p>
          ) : null}
        </div>
      </section>
      </TabsContent>

      <TabsContent value="accommodations" className="mt-6">
      <section className="space-y-4">
        <fieldset
          disabled={isLocked}
          className="block space-y-4 disabled:opacity-60"
        >
          <legend className="text-sm font-medium">
            Allowed accommodations{" "}
            <span className="font-normal text-muted-foreground">
              ({allowedAccommodations.size} selected)
            </span>
          </legend>
          <p className="text-xs text-muted-foreground">
            Which tools, supports and accommodations students may use on this
            assessment. Tick &ldquo;Changes what is measured&rdquo; when a tool
            alters the skill being tested (for example, text-to-speech on a
            reading test) so results can be reported separately.
          </p>
          {OSPI_TIER_ORDER.map((ospiTier) => {
            const entries = accommodationsByOspi.get(ospiTier) ?? [];
            if (entries.length === 0) return null;
            return (
              <div key={ospiTier} className="space-y-1.5">
                <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {OSPI_TIER_LABEL[ospiTier]}
                </div>
                <div className="grid grid-cols-1 gap-1.5 md:grid-cols-2">
                  {entries.map((entry) => {
                    const checked = allowedAccommodations.has(entry.id);
                    const ca = constructAltering.has(entry.id);
                    return (
                      <div
                        key={entry.id}
                        className="flex items-start gap-2 text-sm"
                      >
                        <label
                          className="flex flex-1 items-start gap-2"
                          title={entry.notes ?? undefined}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleAccommodation(entry.id)}
                            className="mt-1"
                          />
                          <span className="flex-1">{entry.label}</span>
                        </label>
                        {checked ? (
                          <label
                            className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground"
                            title="This tool changes the skill being measured on this assessment (for example, text-to-speech on a reading test). Results can be reported separately."
                          >
                            <input
                              type="checkbox"
                              checked={ca}
                              onChange={() =>
                                toggleConstructAltering(entry.id)
                              }
                              className="mt-0.5"
                            />
                            <span>Changes what is measured</span>
                          </label>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </fieldset>

        <div className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground">
            Changes save automatically.
          </span>
          <StatusLine state={accomSave} />
        </div>
      </section>
      </TabsContent>

      <TabsContent value="questions" className="mt-6">
      <section className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-xl font-semibold">Questions ({items.length})</h2>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setPreviewOpen((v) => !v)}
            aria-expanded={previewOpen}
            aria-controls="preview-panel"
          >
            {previewOpen ? "Hide preview" : "Show preview"}
          </Button>
        </div>

        {previewOpen ? (
          <div id="preview-panel" className="space-y-2 rounded-lg border bg-card p-4">
            <p className="text-sm text-muted-foreground">
              This is what students see. Refreshes after you save.
            </p>
            {/* Re-key on the item list + the SAVED allowed_accommodations so
                the iframe re-fetches once a change has actually landed
                (cleanup #7: keying on the unsaved local Set made the preview
                flicker and show the OLD toolbar). Sorted so the key is
                order-stable. */}
            <PreviewFrame
              src={`/preview/${assessment.id}`}
              title="Student view"
              refreshKey={
                items.map((i) => `${i.id}${i.item_set_id ? `@${i.item_set_id}` : ""}`).join("|") +
                "::" +
                Object.keys(persistedSets).sort().map((k) => persistedSets[k]).join("|") +
                "::" +
                [...assessment.allowed_accommodations].sort().join(",")
              }
            />
          </div>
        ) : null}

        <ImportItemsPanel
          assessmentId={assessment.id}
          disabled={isLocked}
          onImported={reloadFromServer}
        />

        <PdfImportPanel
          assessmentId={assessment.id}
          assessmentName={assessment.name}
          disabled={isLocked}
          onImported={reloadFromServer}
        />

        <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-card px-4 py-3">
          <label htmlFor="add-type" className="text-sm font-medium">
            Add a question
          </label>
          <NativeSelect
            id="add-type"
            size="sm"
            value={addType}
            onChange={(e) => setAddType(e.target.value as ItemType)}
            disabled={isLocked}
          >
            {(Object.keys(TYPE_LABEL) as ItemType[]).map((t) => (
              <NativeSelectOption key={t} value={t}>
                {TYPE_LABEL[t]}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <Button type="button" size="sm" onClick={addItem} disabled={isPending || isLocked || adding}>
            <Plus aria-hidden />
            {adding ? "Adding…" : "Add question"}
          </Button>
          {assessment.allow_llm_authoring && !isLocked ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setAiPanelOpen((v) => !v)}
              aria-expanded={aiPanelOpen}
            >
              {aiPanelOpen ? "Close AI panel" : "Generate with AI"}
            </Button>
          ) : null}
        </div>

        {assessment.allow_llm_authoring && aiPanelOpen && !isLocked ? (
          <div className="rounded-md border border-border bg-muted p-4 space-y-3">
            <div className="text-sm font-semibold">Generate a question with AI</div>
            <label className="block text-sm">
              Question type
              <select
                value={aiType}
                onChange={(e) => setAiType(e.target.value as ItemType)}
                className="ml-2 rounded-md border border-border bg-transparent px-2 py-1"
              >
                {AI_GENERABLE_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {TYPE_LABEL[t]}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="block text-sm font-medium">Prompt</span>
              <textarea
                value={aiPrompt}
                onChange={(e) => setAiPrompt(e.target.value)}
                rows={3}
                placeholder="e.g. A 5th-grade word problem about decimal place value using a real-world shopping scenario."
                className="mt-1 w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm"
              />
            </label>
            <div className="flex items-center gap-3">
              <button
                onClick={generateWithAi}
                disabled={aiBusy || aiPrompt.trim().length === 0}
                className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
              >
                {aiBusy ? "Generating…" : "Generate"}
              </button>
            </div>

            {proposal ? (
              <div className="rounded-md border border-border bg-background p-3 space-y-3">
                <div className="text-xs uppercase tracking-wide text-muted-foreground">
                  Proposed · {TYPE_LABEL[proposal.type]}
                </div>
                <label className="block">
                  <span className="block text-sm font-medium">Question</span>
                  <textarea
                    value={proposal.stem}
                    onChange={(e) =>
                      updateProposal((p) => ({ ...p, stem: e.target.value }))
                    }
                    rows={2}
                    className="mt-1 w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm"
                  />
                  <MathPreview text={proposal.stem} />
                </label>
                {proposal.type === "short_text" ? (
                  <label className="block">
                    <span className="block text-sm font-medium">
                      Correct answer
                    </span>
                    <input
                      value={proposal.correct_answer ?? ""}
                      onChange={(e) =>
                        updateProposal((p) => ({
                          ...p,
                          correct_answer: e.target.value,
                        }))
                      }
                      className="mt-1 w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm"
                    />
                    <MathPreview text={proposal.correct_answer ?? ""} />
                  </label>
                ) : (
                  <div className="space-y-2">
                    <div className="text-sm font-medium">Choices</div>
                    {proposal.choices.map((c, ci) => {
                      const isMulti = proposal.type === "multiple_choice_multi";
                      const checked = proposal.correct_choice_ids.includes(c.id);
                      return (
                        <div key={c.id} className="flex items-start gap-2">
                          <input
                            type={isMulti ? "checkbox" : "radio"}
                            name="ai-correct"
                            className="mt-2"
                            checked={checked}
                            onChange={() =>
                              updateProposal((p) => ({
                                ...p,
                                correct_choice_ids: isMulti
                                  ? checked
                                    ? p.correct_choice_ids.filter((x) => x !== c.id)
                                    : [...p.correct_choice_ids, c.id]
                                  : [c.id],
                              }))
                            }
                          />
                          <div className="flex-1">
                            <input
                              value={c.text}
                              onChange={(e) =>
                                updateProposal((p) => ({
                                  ...p,
                                  choices: p.choices.map((cc, cci) =>
                                    cci === ci
                                      ? { ...cc, text: e.target.value }
                                      : cc,
                                  ),
                                }))
                              }
                              className="w-full rounded-md border border-border bg-transparent px-2 py-1 text-sm"
                            />
                            <MathPreview text={c.text} />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
                <div className="flex items-center gap-3 pt-1">
                  <button
                    onClick={saveProposal}
                    disabled={isPending || isLocked}
                    className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
                  >
                    Add this question
                  </button>
                  <button
                    onClick={discardProposal}
                    className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent"
                  >
                    Discard
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        ) : null}

        {items.length === 0 ? (
          <EmptyState
            icon={<ListPlus />}
            title="No questions yet"
            description="Add a question above, or import them from a CSV or PDF."
          />
        ) : (
          <ol className="space-y-4">
            {items.map((item, idx) => {
              const gaps = questionGaps(item);
              const dirty = persisted[item.id] !== fingerprint(item);
              const keyOnlyDirty =
                dirty &&
                isLocked &&
                answerKeyOnlyChange(
                  // The fingerprint omits position / item_set_id; put the
                  // current ones back so only the card's own fields compare.
                  persisted[item.id]
                    ? ({ ...(JSON.parse(persisted[item.id]!) as Omit<ItemView, "position" | "item_set_id">), position: item.position, item_set_id: item.item_set_id } as ItemView)
                    : null,
                  item,
                );
              const save = itemSave[item.id] ?? { kind: "idle" as const };
              const itemError = itemErrors[item.id];
              // E5 slice 1: the stimulus card opens the block above its first
              // question; the questions of a set are indented under it.
              const set = item.item_set_id
                ? (itemSets.find((s) => s.id === item.item_set_id) ?? null)
                : null;
              const bounds = set ? setBounds(set.id) : null;
              const opensSet = !!set && !!bounds && bounds.first === idx;
              const isBlockEnd = !!bounds && (idx === bounds.first || idx === bounds.last);
              const prevSetId = idx > 0 ? (items[idx - 1]!.item_set_id ?? null) : null;
              const setDirty = !!set && persistedSets[set.id] !== JSON.stringify(set);
              const setState = set ? (setSave[set.id] ?? { kind: "idle" as const }) : null;
              return (
              <Fragment key={item.id}>
              {opensSet && set && bounds ? (
                <li
                  className="rounded-lg border border-primary/40 bg-primary/5 p-4"
                  aria-label={`Stimulus for questions ${bounds.first + 1} to ${bounds.last + 1}`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        Stimulus ·{" "}
                        {bounds.first === bounds.last
                          ? `Question ${bounds.first + 1}`
                          : `Questions ${bounds.first + 1}–${bounds.last + 1}`}
                      </span>
                      {/* Multi-source stimulus slice 2: an empty introduction
                          is fine once the reading lives in the sources. */}
                      {set.stimulus_text.trim().length === 0 && set.sources.length === 0 ? (
                        <Badge variant="warning">Empty</Badge>
                      ) : null}
                      {setDirty ? <Badge variant="outline">Unsaved changes</Badge> : null}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <NativeSelect
                        size="sm"
                        aria-label="Where the stimulus appears"
                        value={set.layout}
                        disabled={isLocked}
                        onChange={(e) =>
                          updateSet(set.id, (sv) => ({
                            ...sv,
                            layout: e.target.value as ItemSetView["layout"],
                          }))
                        }
                      >
                        <NativeSelectOption value="inline">Shown above its questions</NativeSelectOption>
                        <NativeSelectOption value="own_page">On its own page</NativeSelectOption>
                        {/* Multi-source stimulus slice 2 (D-2): the teacher picks it. */}
                        <NativeSelectOption value="side_by_side">Side by side (sources beside the question)</NativeSelectOption>
                      </NativeSelect>
                      <Button
                        type="button"
                        size="sm"
                        onClick={() => saveStimulus(set.id)}
                        disabled={isLocked || !setDirty || setState?.kind === "saving"}
                      >
                        {setState?.kind === "saving" ? "Saving…" : "Save stimulus"}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        className="text-destructive hover:text-destructive"
                        onClick={() => removeStimulus(set.id)}
                        disabled={isPending || isLocked}
                        aria-label="Remove this stimulus (the questions stay)"
                        title="Remove this stimulus (the questions stay)"
                      >
                        <X aria-hidden />
                      </Button>
                    </div>
                  </div>
                  <label className="mt-3 block">
                    <span className="block text-sm font-medium">
                      Passage, figure, or data these questions share
                    </span>
                    <textarea
                      id={`stimulus-${set.id}`}
                      value={set.stimulus_text}
                      disabled={isLocked}
                      onChange={(e) =>
                        updateSet(set.id, (sv) => ({ ...sv, stimulus_text: e.target.value }))
                      }
                      rows={4}
                      placeholder="Paste or write the passage; add an image or math below."
                      className="mt-1 w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm"
                    />
                  </label>
                  {!isLocked ? (
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <ImagePicker
                        onInsert={(md) =>
                          updateSet(set.id, (sv) => ({
                            ...sv,
                            stimulus_text: sv.stimulus_text ? `${sv.stimulus_text} ${md}` : md,
                          }))
                        }
                      />
                      <EmphasisButtons apply={(next) => updateSet(set.id, (sv) => ({ ...sv, stimulus_text: next(sv.stimulus_text) }))} />
                      <MathTranslator
                        onInsert={(wrapped) =>
                          updateSet(set.id, (sv) => ({
                            ...sv,
                            stimulus_text: sv.stimulus_text
                              ? `${sv.stimulus_text} ${wrapped}`
                              : wrapped,
                          }))
                        }
                      />
                    </div>
                  ) : null}
                  <MathPreview text={set.stimulus_text} />
                  {/* Multi-source stimulus slice 2: the labelled sources under
                      the introduction — a poem, an article, a chart excerpt.
                      Each row is the same content editor the introduction
                      uses, so KaTeX, images and emphasis behave identically. */}
                  <div className="mt-4 border-t border-border pt-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        Sources
                      </span>
                      {!isLocked ? (
                        <Button type="button" variant="ghost" size="sm" onClick={() => addSource(set.id)}>
                          <ListPlus aria-hidden />
                          Add a source
                        </Button>
                      ) : null}
                    </div>
                    {set.sources.length === 0 ? (
                      <p className="mt-1 text-xs text-muted-foreground">
                        Add a source for each labelled passage, article, or chart these questions draw on.
                      </p>
                    ) : (
                      <ol className="mt-2 space-y-3">
                        {set.sources.map((src, si) => (
                          <li key={si} className="rounded-md border border-border bg-background p-3">
                            <div className="flex flex-wrap items-center gap-2">
                              <input
                                type="text"
                                aria-label="Source label"
                                value={src.label}
                                disabled={isLocked}
                                maxLength={80}
                                onChange={(e) =>
                                  updateSource(set.id, si, (s) => ({ ...s, label: e.target.value }))
                                }
                                className="w-48 rounded-md border border-border bg-transparent px-2 py-1 text-sm"
                              />
                              {src.text.trim().length === 0 ? <Badge variant="warning">Empty</Badge> : null}
                              <span className="ml-auto flex items-center gap-1">
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon-sm"
                                  onClick={() => moveSource(set.id, si, -1)}
                                  disabled={isLocked || si === 0}
                                  aria-label={`Move ${src.label || "source"} up`}
                                >
                                  <ArrowUp aria-hidden />
                                </Button>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon-sm"
                                  onClick={() => moveSource(set.id, si, 1)}
                                  disabled={isLocked || si === set.sources.length - 1}
                                  aria-label={`Move ${src.label || "source"} down`}
                                >
                                  <ArrowDown aria-hidden />
                                </Button>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon-sm"
                                  className="text-destructive hover:text-destructive"
                                  onClick={() => removeSource(set.id, si)}
                                  disabled={isLocked}
                                  aria-label={`Remove ${src.label || "source"}`}
                                >
                                  <X aria-hidden />
                                </Button>
                              </span>
                            </div>
                            <textarea
                              value={src.text}
                              disabled={isLocked}
                              aria-label={`Text of ${src.label || "source"}`}
                              onChange={(e) =>
                                updateSource(set.id, si, (s) => ({ ...s, text: e.target.value }))
                              }
                              rows={5}
                              placeholder="Paste the source exactly as it is printed; line breaks are kept."
                              className="mt-2 w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm"
                            />
                            {!isLocked ? (
                              <div className="mt-2 flex flex-wrap items-center gap-2">
                                <ImagePicker
                                  onInsert={(md) =>
                                    updateSource(set.id, si, (s) => ({
                                      ...s,
                                      text: s.text ? `${s.text} ${md}` : md,
                                    }))
                                  }
                                />
                                <EmphasisButtons
                                  apply={(next) =>
                                    updateSource(set.id, si, (s) => ({ ...s, text: next(s.text) }))
                                  }
                                />
                                <MathTranslator
                                  onInsert={(wrapped) =>
                                    updateSource(set.id, si, (s) => ({
                                      ...s,
                                      text: s.text ? `${s.text} ${wrapped}` : wrapped,
                                    }))
                                  }
                                />
                              </div>
                            ) : null}
                            <MathPreview text={src.text} />
                          </li>
                        ))}
                      </ol>
                    )}
                  </div>
                  {set.source ? (
                    <div className="mt-2 rounded border border-primary/40 bg-primary/5 p-2 text-xs">
                      <span className="font-medium">Each student sees their own answer</span> to &ldquo;{set.source.stem.slice(0, 120)}&rdquo; from{" "}
                      <span className="font-medium">{set.source.assessment_name}</span>
                      {set.source.assessment_status !== "published" ? " (still a draft)" : ""}, under the text above.
                      A student with no answer yet writes it in place.
                      {!isLocked ? (
                        <button type="button" className="ml-2 underline" onClick={() => void setSource(set.id, null).catch((e) => setError(describe(e)))}>
                          Remove
                        </button>
                      ) : null}
                    </div>
                  ) : sourcePickerFor === set.id ? (
                    <SourcePicker
                      assessmentId={assessment.id}
                      disabled={isLocked}
                      onPicked={(src) => setSource(set.id, src)}
                      onCancel={() => setSourcePickerFor(null)}
                    />
                  ) : !isLocked ? (
                    <button type="button" className="mt-2 text-xs underline" onClick={() => setSourcePickerFor(set.id)}>
                      Start with each student&apos;s own earlier answer…
                    </button>
                  ) : null}
                  {setState ? <StatusLine state={setState} className="mt-2" /> : null}
                </li>
              ) : null}
              <li
                className={
                  set
                    ? "ml-4 rounded-lg border border-l-4 border-l-primary/40 bg-card p-4"
                    : "rounded-lg border bg-card p-4"
                }
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      Question {idx + 1} · {TYPE_LABEL[item.type]}
                    </span>
                    {gaps.length > 0 ? (
                      <Badge variant="warning" title={gaps.join("; ")}>
                        Incomplete
                      </Badge>
                    ) : null}
                    {dirty ? <Badge variant="outline">Unsaved changes</Badge> : null}
                  </div>
                  <div className="flex items-center gap-1">
                    {set ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => detachFromStimulus(item.id)}
                        disabled={isPending || isLocked || !isBlockEnd}
                        title={
                          isBlockEnd
                            ? "Take this question out of the stimulus group"
                            : "Only the first or last question of a group can be detached — move it first"
                        }
                      >
                        Detach from stimulus
                      </Button>
                    ) : (
                      <>
                        {prevSetId ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => joinStimulusAbove(item.id)}
                            disabled={isPending || isLocked}
                            title="Share the stimulus of the question above"
                          >
                            Join stimulus above
                          </Button>
                        ) : null}
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => addStimulus(item.id)}
                          disabled={isPending || isLocked}
                          title="Add a passage, figure, or data that this question (and neighbours you join) refers to"
                        >
                          <ListPlus aria-hidden />
                          Add stimulus above
                        </Button>
                      </>
                    )}
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => move(item.id, -1)}
                      disabled={idx === 0 || isPending || isLocked}
                      aria-label={`Move question ${idx + 1} up`}
                    >
                      <ArrowUp aria-hidden />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => move(item.id, 1)}
                      disabled={idx === items.length - 1 || isPending || isLocked}
                      aria-label={`Move question ${idx + 1} down`}
                    >
                      <ArrowDown aria-hidden />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className="ml-3 text-destructive hover:text-destructive"
                      onClick={() => setPendingDelete(item)}
                      disabled={isPending || isLocked}
                      aria-label={`Delete question ${idx + 1}`}
                    >
                      <Trash2 aria-hidden />
                    </Button>
                  </div>
                </div>

                <label className="mt-3 block">
                  <span className="block text-sm font-medium">Question</span>
                  <textarea
                    id={`stem-${item.id}`}
                    value={item.stem}
                    disabled={isLocked}
                    onChange={(e) =>
                      updateItem(item.id, (i) => ({ ...i, stem: e.target.value }))
                    }
                    rows={2}
                    className="mt-1 w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm"
                  />
                  <div className="mt-1 flex flex-wrap items-start gap-2">
                    <ImagePicker
                      onInsert={(md) =>
                        updateItem(item.id, (i) => ({
                          ...i,
                          stem: i.stem ? `${i.stem} ${md}` : md,
                        }))
                      }
                    />
                    <MathTranslator
                      onInsert={(wrapped) =>
                        updateItem(item.id, (i) => ({
                          ...i,
                          stem: i.stem ? `${i.stem} ${wrapped}` : wrapped,
                        }))
                      }
                    />
                    <EmphasisButtons apply={(next) => updateItem(item.id, (i) => ({ ...i, stem: next(i.stem) }))} />
                  </div>
                  <MathPreview text={item.stem} />
                </label>

                {item.type === "match" ? (
                  <div className="mt-3">
                    <MatchPairsEditor
                      pairs={item.pairs ?? []}
                      onChange={(pairs) =>
                        updateItem(item.id, (i) => ({ ...i, pairs }))
                      }
                      disabled={isLocked}
                    />
                  </div>
                ) : item.type === "order" ? (
                  <div className="mt-3">
                    <SequenceEditor
                      sequence={item.sequence ?? []}
                      onChange={(sequence) =>
                        updateItem(item.id, (i) => ({ ...i, sequence }))
                      }
                      disabled={isLocked}
                    />
                  </div>
                ) : item.type === "drawing_upload" ? (
                  <div className="mt-3 space-y-3">
                    <p className="text-xs text-muted-foreground">
                      Students draw or upload their answer in the test app.
                    </p>
                    <div>
                      <span className="block text-sm font-medium">
                        Reference image{" "}
                        <span className="font-normal text-muted-foreground">
                          (optional)
                        </span>
                      </span>
                      <ImagePicker
                        onInsert={(md) => {
                          const m = md.match(ASSET_REF_ONE_RE);
                          if (m)
                            updateItem(item.id, (i) => ({
                              ...i,
                              prompt_asset_id: m[1]!.toLowerCase(),
                            }));
                        }}
                      />
                      {item.prompt_asset_id ? (
                        <div className="mt-2 space-y-1">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={`/api/assets/${item.prompt_asset_id}`}
                            alt="Reference"
                            className="max-h-48 rounded border border-border"
                          />
                          <button
                            onClick={() =>
                              updateItem(item.id, (i) => ({
                                ...i,
                                prompt_asset_id: null,
                              }))
                            }
                            disabled={isLocked}
                            className="rounded-md border border-border px-2 py-1 text-xs disabled:opacity-40"
                          >
                            Remove reference image
                          </button>
                        </div>
                      ) : null}
                    </div>
                    <label className="block">
                      <span className="block text-sm font-medium">
                        Canvas size{" "}
                        <span className="font-normal text-muted-foreground">
                          (optional, px)
                        </span>
                      </span>
                      <div className="mt-1 flex items-center gap-2">
                        <input
                          type="number"
                          min={100}
                          max={4000}
                          placeholder="width"
                          value={item.canvas?.width ?? ""}
                          disabled={isLocked}
                          onChange={(e) =>
                            updateItem(item.id, (i) => {
                              const n = Number(e.target.value);
                              const width =
                                e.target.value === "" || Number.isNaN(n)
                                  ? null
                                  : Math.floor(n);
                              const height = i.canvas?.height ?? null;
                              const background = i.canvas?.background ?? null;
                              return {
                                ...i,
                                canvas:
                                  width == null && height == null && background == null
                                    ? null
                                    : { width, height, background },
                              };
                            })
                          }
                          className="w-28 rounded-md border border-border bg-transparent px-3 py-2 text-sm"
                        />
                        <span aria-hidden>×</span>
                        <input
                          type="number"
                          min={100}
                          max={4000}
                          placeholder="height"
                          value={item.canvas?.height ?? ""}
                          disabled={isLocked}
                          onChange={(e) =>
                            updateItem(item.id, (i) => {
                              const n = Number(e.target.value);
                              const height =
                                e.target.value === "" || Number.isNaN(n)
                                  ? null
                                  : Math.floor(n);
                              const width = i.canvas?.width ?? null;
                              const background = i.canvas?.background ?? null;
                              return {
                                ...i,
                                canvas:
                                  width == null && height == null && background == null
                                    ? null
                                    : { width, height, background },
                              };
                            })
                          }
                          className="w-28 rounded-md border border-border bg-transparent px-3 py-2 text-sm"
                        />
                      </div>
                      {item.canvas &&
                      (item.canvas.width == null) !== (item.canvas.height == null) ? (
                        <p className="mt-1 text-xs text-muted-foreground">
                          Set both width and height (100–4000), or leave both
                          empty — a half-filled pair saves as no canvas.
                        </p>
                      ) : null}
                    </label>
                    {/* docs/drawing-background-design.md (D-1/D-2): the paper
                        the client paints under the student's strokes. Blank
                        clears the field; picking a background with no size
                        saves the 800 × 600 default (persistItem). */}
                    <label className="block">
                      <span className="block text-sm font-medium">
                        Background{" "}
                        <span className="font-normal text-muted-foreground">
                          (optional)
                        </span>
                      </span>
                      <select
                        value={item.canvas?.background ?? ""}
                        onChange={(e) =>
                          updateItem(item.id, (i) => {
                            const background =
                              e.target.value === ""
                                ? null
                                : (e.target.value as "grid" | "axes");
                            const width = i.canvas?.width ?? null;
                            const height = i.canvas?.height ?? null;
                            return {
                              ...i,
                              canvas:
                                width == null && height == null && background == null
                                  ? null
                                  : { width, height, background },
                            };
                          })
                        }
                        disabled={isLocked}
                        className="mt-1 w-full max-w-md rounded-md border border-border bg-transparent px-3 py-2 text-sm"
                      >
                        <option value="">Blank</option>
                        <option value="grid">Grid</option>
                        <option value="axes">Grid with axes</option>
                      </select>
                    </label>
                  </div>
                ) : item.type === "hotspot" ? (
                  <div className="mt-3">
                    <HotspotEditor
                      imageAssetId={item.image_asset_id}
                      regions={item.regions ?? []}
                      correctRegionIds={item.correct_region_ids ?? []}
                      onChange={(patch) =>
                        updateItem(item.id, (i) => ({ ...i, ...patch }))
                      }
                      disabled={isLocked}
                    />
                  </div>
                ) : item.type === "table" ? (
                  <div className="mt-3">
                    <TableEditor
                      columns={item.columns ?? []}
                      rows={item.rows ?? []}
                      corner={item.corner}
                      cellKeys={item.cell_keys}
                      onChange={(patch) =>
                        updateItem(item.id, (i) => ({ ...i, ...patch }))
                      }
                      disabled={isLocked}
                    />
                  </div>
                ) : item.type === "short_text" ? (
                  <label className="mt-3 block">
                    <span className="block text-sm font-medium">
                      Correct answer
                    </span>
                    <input
                      value={item.correct_answer ?? ""}
                      onChange={(e) =>
                        updateItem(item.id, (i) => ({
                          ...i,
                          correct_answer: e.target.value,
                        }))
                      }
                      className="mt-1 w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm"
                    />
                    <MathPreview text={item.correct_answer ?? ""} />
                  </label>
                ) : item.type === "essay" ? (
                  <div className="mt-3 space-y-3">
                    <p className="text-xs text-muted-foreground">
                      Students write a long-form response. Attach an optional
                      scoring rubric below — stored now, used by AI/human
                      scoring in a later phase.
                    </p>
                    <label className="block">
                      <span className="block text-sm font-medium">
                        Max word count{" "}
                        <span className="font-normal text-muted-foreground">
                          (optional)
                        </span>
                      </span>
                      <input
                        type="number"
                        min={1}
                        value={item.max_word_count ?? ""}
                        onChange={(e) =>
                          updateItem(item.id, (i) => ({
                            ...i,
                            max_word_count:
                              e.target.value === ""
                                ? null
                                : Math.max(
                                    1,
                                    Math.floor(Number(e.target.value)),
                                  ),
                          }))
                        }
                        className="mt-1 w-40 rounded-md border border-border bg-transparent px-3 py-2 text-sm"
                      />
                    </label>
                    <label className="block">
                      <span className="block text-sm font-medium">
                        Placeholder{" "}
                        <span className="font-normal text-muted-foreground">
                          (optional)
                        </span>
                      </span>
                      <input
                        value={item.placeholder ?? ""}
                        maxLength={200}
                        onChange={(e) =>
                          updateItem(item.id, (i) => ({
                            ...i,
                            placeholder:
                              e.target.value === "" ? null : e.target.value,
                          }))
                        }
                        className="mt-1 w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm"
                      />
                    </label>
                    <div>
                      <span className="block text-sm font-medium">
                        Scoring rubric{" "}
                        <span className="font-normal text-muted-foreground">
                          (optional)
                        </span>
                      </span>
                      <RubricEditor
                        value={item.rubric}
                        onChange={(rubric) =>
                          updateItem(item.id, (i) => ({ ...i, rubric }))
                        }
                        disabled={isLocked}
                      />
                    </div>
                  </div>
                ) : (
                  <div className="mt-3 space-y-2">
                    <div className="text-sm font-medium">Choices</div>
                    {item.choices.map((c, ci) => {
                      const isMulti = item.type === "multiple_choice_multi";
                      const checked = item.correct_choice_ids.includes(c.id);
                      return (
                        <div key={c.id}>
                          <div className="flex items-center gap-2">
                            <input
                              type={isMulti ? "checkbox" : "radio"}
                              name={`correct-${item.id}`}
                              checked={checked}
                              aria-label={`Mark choice ${c.id.toUpperCase()} as correct`}
                              title="Correct answer"
                              onChange={() =>
                                updateItem(item.id, (i) => ({
                                  ...i,
                                  correct_choice_ids: isMulti
                                    ? checked
                                      ? i.correct_choice_ids.filter((x) => x !== c.id)
                                      : [...i.correct_choice_ids, c.id]
                                    : [c.id],
                                }))
                              }
                            />
                            {/* The id is auto-assigned (nextChoiceId) and only ever
                                shown as a letter; it used to be an editable field (A-16). */}
                            <span
                              className="w-5 text-center font-mono text-xs text-muted-foreground"
                              aria-hidden
                            >
                              {c.id.toUpperCase()}
                            </span>
                            <input
                              value={c.text}
                              onChange={(e) =>
                                updateItem(item.id, (i) => ({
                                  ...i,
                                  choices: i.choices.map((cc, cci) =>
                                    cci === ci ? { ...cc, text: e.target.value } : cc,
                                  ),
                                }))
                              }
                              disabled={isLocked}
                              className="flex-1 rounded-md border border-border bg-transparent px-2 py-1 text-sm"
                              aria-label={`Choice ${c.id.toUpperCase()} text`}
                              placeholder={`Choice ${c.id.toUpperCase()}`}
                            />
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              onClick={() =>
                                updateItem(item.id, (i) => ({
                                  ...i,
                                  choices: i.choices.filter((_, cci) => cci !== ci),
                                  correct_choice_ids: i.correct_choice_ids.filter(
                                    (x) => x !== c.id,
                                  ),
                                }))
                              }
                              disabled={item.choices.length <= 2 || isLocked}
                              aria-label={`Remove choice ${c.id.toUpperCase()}`}
                              title={item.choices.length <= 2 ? "Need at least 2 choices" : "Remove choice"}
                            >
                              <X aria-hidden />
                            </Button>
                          </div>
                          <div className="mt-1 flex flex-wrap items-start gap-2">
                            <ImagePicker
                              onInsert={(md) =>
                                updateItem(item.id, (i) => ({
                                  ...i,
                                  choices: i.choices.map((cc, cci) =>
                                    cci === ci
                                      ? {
                                          ...cc,
                                          text: cc.text ? `${cc.text} ${md}` : md,
                                        }
                                      : cc,
                                  ),
                                }))
                              }
                            />
                            <EmphasisButtons
                              apply={(next) =>
                                updateItem(item.id, (i) => ({
                                  ...i,
                                  choices: i.choices.map((cc, cci) => (cci === ci ? { ...cc, text: next(cc.text) } : cc)),
                                }))
                              }
                            />
                            <MathTranslator
                              onInsert={(wrapped) =>
                                updateItem(item.id, (i) => ({
                                  ...i,
                                  choices: i.choices.map((cc, cci) =>
                                    cci === ci
                                      ? {
                                          ...cc,
                                          text: cc.text
                                            ? `${cc.text} ${wrapped}`
                                            : wrapped,
                                        }
                                      : cc,
                                  ),
                                }))
                              }
                            />
                          </div>
                          <MathPreview text={c.text} />
                        </div>
                      );
                    })}
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={isLocked}
                      onClick={() =>
                        updateItem(item.id, (i) => ({
                          ...i,
                          choices: [
                            ...i.choices,
                            { id: nextChoiceId(i.choices), text: "" },
                          ],
                        }))
                      }
                    >
                      <Plus aria-hidden />
                      Add choice
                    </Button>
                  </div>
                )}

                <label className="mt-3 block">
                  <span className="block text-sm font-medium">
                    Scoring method{" "}
                    <span className="font-normal text-muted-foreground">
                      (how answers are scored)
                    </span>
                  </span>
                  <select
                    value={item.scoring_method ?? ""}
                    onChange={(e) =>
                      updateItem(item.id, (i) => ({
                        ...i,
                        scoring_method:
                          e.target.value === ""
                            ? null
                            : (e.target.value as ScoringMethod),
                      }))
                    }
                    disabled={isLocked}
                    className="mt-1 w-full max-w-md rounded-md border border-border bg-transparent px-3 py-2 text-sm"
                  >
                    <option value="">
                      Default — {SCORING_LABEL[defaultScoringMethod(item)]}
                    </option>
                    {SCORING_OPTIONS[item.type].map((m) => (
                      <option
                        key={m}
                        value={m}
                        disabled={
                          (m === "ai" || m === "hybrid") && !item.rubric
                        }
                      >
                        {SCORING_LABEL[m]}
                      </option>
                    ))}
                  </select>
                  {item.type === "essay" && !item.rubric ? (
                    <p className="mt-1 text-xs text-muted-foreground">
                      AI and Hybrid need a scoring rubric — add one above to
                      enable them.
                    </p>
                  ) : null}
                </label>

                {itemError ? (
                  <Alert variant="destructive" className="mt-4">
                    <AlertTitle>{itemError}</AlertTitle>
                  </Alert>
                ) : null}

                <div className="mt-4 flex flex-wrap items-center gap-3">
                  <Button
                    type="button"
                    onClick={() => persistItem(item)}
                    disabled={
                      isPending || (isLocked && !keyOnlyDirty) || !dirty || save.kind === "saving"
                    }
                  >
                    Save question
                  </Button>
                  <StatusLine state={save} />
                </div>
              </li>
              </Fragment>
              );
            })}
          </ol>
        )}

        <NextStepCard
          status={assessment.status}
          onPublish={() => setPublishOpen("publish")}
          onStartSession={() => setActiveTab("sessions")}
        />
      </section>
      </TabsContent>

      <TabsContent value="students" className="mt-6">
        <OverridesPanel
          assessmentId={assessment.id}
          allowedAccommodations={[...allowedAccommodations]}
          isLocked={isLocked}
          onOpenAccommodations={() => setActiveTab("accommodations")}
        />
      </TabsContent>

      <TabsContent value="sessions" className="mt-6">
        <SittingsPanel
          assessmentId={assessment.id}
          assessmentName={assessment.name}
          isPublished={assessment.status === "published"}
          archived={archivedAt !== null}
          onPublish={() => setPublishOpen("publish")}
        />
      </TabsContent>
      </Tabs>

      <ShareDialog assessmentId={assessment.id} open={shareOpen} onOpenChange={setShareOpen} />

      <PublishDialog
        open={publishOpen !== null}
        onOpenChange={(open) => {
          if (!open) setPublishOpen(null);
        }}
        mode={publishOpen ?? "publish"}
        checks={readinessChecks(items, itemSets)}
        busy={publishBusy}
        onConfirm={() => setPublished(publishOpen === "unpublish" ? "draft" : "published")}
      />

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open && !deleting) setPendingDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete question{" "}
              {pendingDelete ? items.findIndex((i) => i.id === pendingDelete.id) + 1 : ""}
              {pendingDelete?.stem.trim()
                ? ` — "${pendingDelete.stem.trim().slice(0, 60)}${pendingDelete.stem.trim().length > 60 ? "…" : ""}"`
                : ""}
              ?
            </AlertDialogTitle>
            <AlertDialogDescription>
              The question and its answer key are removed from this assessment. This can&apos;t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void confirmDelete();
              }}
              disabled={deleting}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              {deleting ? "Deleting…" : "Delete question"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* D-1 (docs/archive-and-delete-design.md): confirm dialog for the
          Settings-tab Delete draft action. The has_attempts note re-reads
          from the DELETE route in case the assessment gained attempts under
          this page (another tab, another sitting) since it loaded. */}
      <AlertDialog
        open={deleteDraftOpen}
        onOpenChange={(open) => {
          if (!open && !deletingDraft) setDeleteDraftOpen(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {assessment.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              {plural(items.length, "question")} will be removed. This can&apos;t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteDraftError ? (
            <Alert variant="destructive">
              <AlertTitle>{deleteDraftError}</AlertTitle>
            </Alert>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deletingDraft}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void deleteDraft();
              }}
              disabled={deletingDraft}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              {deletingDraft ? "Deleting…" : "Delete draft"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Fragment, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { ArrowDown, ArrowUp, ListPlus, Trash2 } from "lucide-react";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmptyState } from "@/components/app/EmptyState";
import { ApiError, itemErrorCopy } from "@/lib/ui/errorCopy";
import { plural } from "@/lib/ui/format";
import { defaultLayoutAfterAddingSource } from "@/lib/itemSetLayout";
import { NextStepCard } from "@/components/app/NextStepCard";
import { PageHeader } from "@/components/app/PageHeader";
import { PublishDialog } from "@/components/app/PublishDialog";
import { AssessmentStatusBadge } from "@/components/app/StatusBadge";
import { StatusLine, type SaveState } from "@/components/app/StatusLine";
import { beforePublishing, questionGaps, readinessChecks } from "./readiness";
import { BeforePublishingList } from "./BeforePublishingList";
import { AutosaveIndicator } from "./AutosaveIndicator";
import { ItemHistoryDialog, type ItemVersion } from "./ItemHistoryDialog";
import { ShareDialog } from "@/components/app/ShareDialog";
import type { FillBlankBlank, ScoringMethod } from "@secure-test/schema";
import { MathPreview } from "./MathPreview";
import { GraphStimulusEditor } from "./GraphStimulusEditor";
import { DEFAULT_GRAPH_BOARD } from "./GraphItemEditor";
import { ImagePicker } from "./ImagePicker";
import { MathTranslator } from "./MathTranslator";
import { EmphasisButtons } from "./EmphasisButtons";
import { RichTextField } from "./RichTextField";
import type { SourceSummary } from "./SourcePicker";
import { OverridesPanel } from "./OverridesPanel";
import { SittingsPanel } from "./SittingsPanel";
import type { ItemType } from "@/db/schema";
import { usesRichTextField } from "@/lib/authoring/richTextTypes";
import { editorStartAction } from "@/lib/authoring/startScreen";
import {
  blockMoveAnnouncement,
  choiceMessageFor,
  choiceMoveAnnouncement,
  insertAt,
  insertionSlots,
  moveBlockTo,
  moveInList,
  outlineBlocks,
  slashOpensInsertMenu,
  slotAfter,
  splitsSet,
  TEXT_ENTRY_SELECTOR,
} from "@/lib/authoring/outline";
import { newItemSeed } from "@/lib/authoring/insertTypes";
import { changeItemType, typeChangeTargets } from "@/lib/authoring/typeChange";
import { OutlineRail } from "./OutlineRail";
import { InsertQuestionMenu } from "./InsertQuestionMenu";
import { TypeChangeControl } from "./TypeChangeControl";
import { autosaveSummary, createItemAutosaver, type ItemAutosaver } from "@/lib/authoring/itemAutosave";
import {
  VISIBLE_ACCOMMODATION_CATALOG,
  type AccommodationCatalogEntry,
  type OspiTier,
} from "@/lib/accommodations/catalog";
import { InsertBlankButton } from "./FillBlankEditor";
import {
  FILL_BLANK_SEED_STEM,
  fillBlankIssueMessages,
  MAX_BLANKS,
  nextBlankId,
  orderBlanksByStem,
  unplacedBlankIds,
} from "@/lib/items/fillBlankEditor";
import { createAutosave } from "@/lib/autosave";
import { StandardsTagInput } from "@/components/app/StandardsTagInput";
import type { SuggestOutcome } from "@/components/app/SuggestStandardsDialog";
import { StandardSuggestionChips } from "@/components/app/StandardSuggestionChips";
import { removeSuggestion, type SuggestEntry, type SuggestionMap } from "@/lib/ai/suggestForm";
import { addTag, normalizeStandards } from "@/lib/standards/tags";
import { KEY_FIXED_POINTER, answerKeyChanged } from "@/lib/scoring/rescoreDialog";
import {
  EDITOR_TABS,
  type EditorTab,
  TAB_LABEL,
  parseTab,
  type ItemView,
  type AssessmentView,
  type StimulusSourceView,
  type ItemSetView,
  type EditorAccess,
  isOwnerAccess,
  coTeachingBadgeText,
  type AiProposal,
  TYPE_LABEL,
  type ItemRow,
  rowToView,
  fingerprint,
  snapshotAll,
  SCORING_LABEL,
  HYBRID_HINT,
  SCORING_OPTIONS,
  scoringOptionShown,
  defaultScoringMethod,
  keyOnlyEdit,
  defaultItemFor,
  itemPatchBody,
} from "./editorModel";
import { SettingsTab } from "./SettingsTab";
import { AccommodationsTab } from "./AccommodationsTab";
import { QuestionsToolbar } from "./QuestionsToolbar";
import { StimulusSetCard } from "./StimulusSetCard";
import { ItemTypeFields } from "./ItemTypeFields";
import { InteractivePreview } from "./InteractivePreview";

// Phase 4 slice D: the moved helpers stay importable from here (tests and
// ItemHistoryDialog import them from this file).
export { coTeachingBadgeText, defaultItemFor, HYBRID_HINT, isOwnerAccess, itemPatchBody, rowToView, SCORING_LABEL };
export type { ItemRow };

interface Props {
  assessment: AssessmentView;
  access: EditorAccess;
  initialItems: ItemView[];
  initialItemSets: ItemSetView[];
  /** R-12 (docs/editor-redesign-design.md): the staff member opted in to the new editor. */
  newAuthoring?: boolean;
}


export function AssessmentEditor({ assessment, access, initialItems, initialItemSets, newAuthoring = false }: Props) {
  const isOwner = isOwnerAccess(access);
  const coTeachingBadge = coTeachingBadgeText(access);
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
  // U-18: the class period the Allowed tab is showing (null = all periods).
  const [selectedPeriod, setSelectedPeriod] = useState<string | null>(null);
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
  const [calculatorMode, setCalculatorMode] = useState(assessment.calculator_mode);
  const [calculatorPreset, setCalculatorPreset] = useState(assessment.calculator_preset);
  const [settingsSave, setSettingsSave] = useState<SaveState>({ kind: "idle" });
  const [allowHighlighting, setAllowHighlighting] = useState(assessment.allow_highlighting);
  const [highlightSave, setHighlightSave] = useState<SaveState>({ kind: "idle" });
  const [accomSave, setAccomSave] = useState<SaveState>({ kind: "idle" });
  const [publishOpen, setPublishOpen] = useState<null | "publish" | "unpublish">(null);
  // E12 slice 4: which set's source picker is open.
  const [sourcePickerFor, setSourcePickerFor] = useState<string | null>(null);
  const [publishBusy, setPublishBusy] = useState(false);
  // Phase 5 slice B (R-11): the new editor opens with its side-by-side
  // preview showing; the current editor's stacked preview starts hidden.
  const [previewOpen, setPreviewOpen] = useState(newAuthoring);
  // Below 1280 px the new editor shows one pane at a time.
  const [narrowPane, setNarrowPane] = useState<"editor" | "preview">("editor");
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
  // E11: items whose answer key was fixed while Published (the Rescore pointer).
  const [keyFixed, setKeyFixed] = useState<Record<string, boolean>>({});
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
    if (newAuthoring) {
      // R-6: the new card is empty (nothing to select). The rich-text field
      // mounts its editable element a frame or two after the card, so wait
      // for it briefly.
      let tries = 0;
      const land = () => {
        const target = document.getElementById(`stem-${id}`);
        if (target) {
          target.scrollIntoView({ block: "center", behavior: "smooth" });
          target.focus({ preventScroll: true });
        } else if (tries++ < 20) requestAnimationFrame(land);
      };
      land();
      return;
    }
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
    for (const entry of VISIBLE_ACCOMMODATION_CATALOG) {
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
  // Editor redesign Phase 8 (D-5): a draft made from the start screen opens
  // with its import panel or the AI dialog open (`?start=`), read once.
  const [startWith] = useState(() =>
    editorStartAction(searchParams.get("start"), {
      newAuthoring,
      allowLlm: assessment.allow_llm_authoring,
      locked: isLocked,
    }),
  );
  // BG slice 2: every tag used on this assessment, offered first in each
  // question's picker so one test stays consistent.
  const usedStandards = useMemo(() => normalizeStandards(items.flatMap((i) => i.standards)), [items]);
  const [shareOpen, setShareOpen] = useState(false);
  // BG slice 5: the AI's standards suggestions for untagged questions. Page
  // state only — lost on reload (1.1); Accept saves through persistItem.
  const [suggestions, setSuggestions] = useState<SuggestionMap>({});
  const [suggestionEntries, setSuggestionEntries] = useState<Record<string, SuggestEntry>>({});
  const [suggestionNote, setSuggestionNote] = useState<string | null>(null);

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
          calculator_mode: calculatorMode,
          calculator_preset: calculatorPreset,
        }),
      });
      setSettingsSave({ kind: "saved", at: new Date() });
      refresh();
    } catch (e) {
      setSettingsSave({ kind: "failed", message: describe(e) });
    }
  }

  // Passage highlighting (docs/passage-highlighting-design.md): saves itself
  // at once with a PATCH carrying only this field, so it works while
  // Published (the server's isFeedbackSettingsOnlyPatch door).
  async function saveHighlighting(next: boolean) {
    const prev = allowHighlighting;
    setAllowHighlighting(next);
    setHighlightSave({ kind: "saving" });
    try {
      await call(apiBase, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ allow_highlighting: next }),
      });
      setHighlightSave({ kind: "saved", at: new Date() });
      refresh();
    } catch (e) {
      setAllowHighlighting(prev);
      setHighlightSave({ kind: "failed", message: describe(e) });
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
                  : addType === "fill_blank"
                  ? { ...draft, stem: FILL_BLANK_SEED_STEM }
                  : addType === "graph"
                  ? { ...draft, stem: "Graph your answer.", board: DEFAULT_GRAPH_BOARD, key: null }
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
    if (body.blanks == null) delete body.blanks;
    // short_text only, and only when ON: the other types' schemas don't
    // know the key, and `null` would fail the optional boolean.
    if (!body.exact_form) delete body.exact_form;
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

  async function persistItem(item: ItemView, opts: { restore?: boolean } = {}): Promise<boolean> {
    setError(null);
    const body = itemPatchBody(item);
    // E11 (docs/rescore-after-key-change-design.md, D-4): a key fixed on a
    // Published test points to Rescore on Results once it is saved.
    const persistedBefore = persisted[item.id];
    const keyChanged =
      isLocked &&
      answerKeyChanged(
        persistedBefore ? (JSON.parse(persistedBefore) as Record<string, unknown>) : null,
        item as unknown as Record<string, unknown>,
      );
    setItemError(item.id, null);
    setItemSave((prev) => ({ ...prev, [item.id]: { kind: "saving" } }));
    try {
      // R-5: a History restore asks the server to keep the version it replaces.
      await call(`${apiBase}/items/${item.id}${opts.restore ? "?restore=1" : ""}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      // The snapshot is what we SENT: edits typed while the request was in
      // flight keep the card dirty.
      setPersisted((prev) => ({ ...prev, [item.id]: fingerprint(item) }));
      setItemSave((prev) => ({ ...prev, [item.id]: { kind: "saved", at: new Date() } }));
      if (keyChanged) setKeyFixed((prev) => ({ ...prev, [item.id]: true }));
      return true;
    } catch (e) {
      setItemSave((prev) => ({ ...prev, [item.id]: { kind: "idle" } }));
      // FB slice 2: name the blank problem slice 1's write boundary found
      // (the 400's detail) instead of only "isn't complete yet".
      const blankIssues =
        item.type === "fill_blank" && e instanceof ApiError && e.code === "invalid_body"
          ? fillBlankIssueMessages(e.detail)
          : [];
      setItemError(
        item.id,
        blankIssues.length > 0 ? `${describe(e)} ${blankIssues.join("; ")}.` : describe(e),
      );
      return false;
    }
  }

  // R-5 (docs/editor-redesign-design.md), new editor only: each card saves
  // itself a second after its last edit, through persistItem — the same
  // PATCH as Save question. While published only an answer-key-only edit
  // saves (the server's publish lock); anything else waits for Unpublish and
  // the indicator says so. The refs keep the autosaver, created once, calling
  // this render's persistItem and reading this render's saved snapshots.
  const persistItemRef = useRef(persistItem);
  persistItemRef.current = persistItem;
  const persistedRef = useRef(persisted);
  persistedRef.current = persisted;
  const autosaverRef = useRef<ItemAutosaver<ItemView> | null>(null);
  if (newAuthoring && autosaverRef.current === null) {
    autosaverRef.current = createItemAutosaver<ItemView>({
      save: async (_id, item) => {
        // Saved meanwhile by another path (an accepted suggestion, a restore).
        if (persistedRef.current[item.id] === fingerprint(item)) return;
        await persistItemRef.current(item);
      },
    });
  }
  const canAutosave = (item: ItemView) => !isLocked || keyOnlyEdit(persisted[item.id], item);
  // F-5: a blank whose marker was deleted would be refused; the card waits
  // until the teacher puts it back or removes it (the leave-page warning holds).
  const waitsOnBlank = (item: ItemView) =>
    item.type === "fill_blank" && unplacedBlankIds(item.stem, item.blanks ?? []).length > 0;
  // R-6: where the new editor's "+" insertion points sit (list indexes).
  const slotSet = new Set(newAuthoring ? insertionSlots(items) : []);
  useEffect(() => {
    autosaverRef.current?.sync(
      items.map((item) => {
        const fp = fingerprint(item);
        return {
          id: item.id,
          fingerprint: fp,
          value: item,
          pending: persisted[item.id] !== fp && canAutosave(item) && !waitsOnBlank(item),
        };
      }),
    );
  });
  // Leaving the editor sends whatever is still waiting on its timer.
  useEffect(() => () => void autosaverRef.current?.flushAll(), []);

  const [historyFor, setHistoryFor] = useState<string | null>(null);

  /** R-5: the "Before publishing" and indicator links — scroll to the card and
   * put the cursor in its question text (or on the card). */
  function jumpToItem(itemId: string) {
    const card = document.getElementById(`question-${itemId}`);
    if (!card) return;
    card.scrollIntoView({ block: "center", behavior: "smooth" });
    const stem = document.getElementById(`stem-${itemId}`);
    (stem ?? card).focus({ preventScroll: true });
  }

  /** Phase 5 slice B: show a question in the editor — scrolled into view,
   * focus left where it is (the teacher may be answering in the preview). A
   * click on a question's text in the preview (`frame`) only scrolls: below
   * 1280 px the editor pane stays hidden until the teacher picks it, so
   * clicking in the preview never takes it away. A "Question N" link under
   * the hand-in result (`score`) is an explicit move, so it switches panes. */
  function showItemFromPreview(itemId: string, from: "frame" | "score") {
    if (from === "score") setNarrowPane("editor");
    requestAnimationFrame(() =>
      document.getElementById(`question-${itemId}`)?.scrollIntoView({ block: "start", behavior: "smooth" }),
    );
  }

  function retryFailedSaves() {
    for (const item of items) {
      if (itemErrors[item.id] && persisted[item.id] !== fingerprint(item)) {
        void autosaverRef.current?.retry(item.id, item);
      }
    }
  }

  /** R-5: History → Restore. Anything still waiting to autosave is sent
   * first, so the server's copy of "the version this replaces" is current;
   * then the version is saved through the ordinary PATCH (`restore`). The
   * card is held out of autosave meanwhile, and a refused restore puts the
   * current content back (as changeType does) — otherwise an ordinary
   * autosave, without `restore`, could write the old version over the
   * current one with no copy kept of it. */
  async function restoreVersion(current: ItemView, version: ItemVersion): Promise<boolean> {
    await autosaverRef.current?.flush(current.id);
    autosaverRef.current?.hold(current.id);
    const next: ItemView = {
      ...rowToView(version.item),
      position: current.position,
      item_set_id: current.item_set_id ?? null,
    };
    updateItem(current.id, () => next);
    const ok = await persistItem(next, { restore: true });
    autosaverRef.current?.release(current.id);
    if (!ok) updateItem(current.id, () => current);
    return ok;
  }

  function onSuggested(outcome: SuggestOutcome) {
    setSuggestions(outcome.map);
    setSuggestionEntries(outcome.entries);
    setSuggestionNote(outcome.summary);
  }

  function dismissSuggestion(itemId: string, tag: string) {
    setSuggestions((prev) => removeSuggestion(prev, itemId, tag));
  }

  // Accept = an ordinary tag (D-2a). A card with nothing else unsaved saves at
  // once through the card's own save (tags stay editable while Published,
  // 14.1); a card mid-edit gets the tag in its field and keeps the teacher's
  // Save button — one PATCH never carries edits the teacher has not saved.
  async function acceptSuggestion(itemId: string, tag: string) {
    const item = items.find((i) => i.id === itemId);
    if (!item) return;
    const result = addTag(item.standards, tag);
    if (!result.ok) {
      setItemError(itemId, result.error);
      return;
    }
    const next: ItemView = { ...item, standards: result.next };
    const clean = persisted[itemId] === fingerprint(item);
    setSuggestions((prev) => removeSuggestion(prev, itemId, tag));
    updateItem(itemId, (i) => ({ ...i, standards: result.next }));
    if (clean) await persistItem(next);
  }

  async function confirmDelete() {
    const target = pendingDelete;
    if (!target) return;
    autosaverRef.current?.cancel(target.id);
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

  // ---- R-6 / R-7 (docs/editor-redesign-design.md, Phase 4 slice B), new editor only ----
  // Which "+" slot's menu is open (a list index; see insertionSlots).
  const [insertSlot, setInsertSlot] = useState<number | null>(null);
  const [outlineMessage, setOutlineMessage] = useState("");
  // F-4: the move is announced in the moved question's card only; every
  // card has its own live region, so one shared message was read once per card.
  const [choiceMessage, setChoiceMessage] = useState<{ itemId: string; text: string } | null>(null);

  /** Save a new order through the existing reorder route; put the old one back if it is refused. */
  async function saveOrder(next: ItemView[], movedId: string) {
    setError(null);
    const before = items;
    setItems(next);
    setOutlineMessage(blockMoveAnnouncement(before, next, movedId));
    try {
      await call(`${apiBase}/items/reorder`, jsonInit("POST", { ordered_ids: next.map((i) => i.id) }));
    } catch (e) {
      setItems(before);
      setOutlineMessage("The order could not be saved, so it is back as it was.");
      setError(describe(e));
    }
  }

  /** The outline rail: drag (from → to) or Move up / Move down on the selected block. */
  function moveOutlineBlock(from: number, to: number) {
    const blocks = outlineBlocks(items);
    const moved = blocks[from]?.items[0];
    const next = moveBlockTo(items, from, to);
    if (!moved || !next || splitsSet(next)) return;
    void saveOrder(next, moved.id);
  }

  /** "+" / "/" menu: a new, EMPTY question of `type` at list index `index` (UX3-1, UX3-4). */
  async function insertItem(type: ItemType, index: number) {
    setError(null);
    setAdding(true);
    try {
      const draft: ItemView = { ...defaultItemFor(type), ...newItemSeed(type), id: "", position: 0 } as ItemView;
      const res = await call(`${apiBase}/items`, jsonInit("POST", itemPatchBody(draft)));
      const created = rowToView(((await res.json()) as { item: ItemRow }).item);
      // The route appends; the reorder route then puts it where the "+" was.
      const order = insertAt(items.map((i) => i.id), created.id, index);
      setItems((prev) => insertAt(prev, created, index));
      setPersisted((prev) => ({ ...prev, [created.id]: fingerprint(created) }));
      focusItemId.current = created.id;
      if (index < items.length) {
        try {
          await call(`${apiBase}/items/reorder`, jsonInit("POST", { ordered_ids: order }));
        } catch (e) {
          // It exists, at the end: show it where the server has it.
          setItems((prev) => [...prev.filter((i) => i.id !== created.id), created]);
          setError(describe(e));
        }
      }
    } catch (e) {
      setError(describe(e));
    } finally {
      setAdding(false);
    }
  }

  /**
   * In-place type change (R-6). Saved at once rather than on the autosave
   * timer, with `restore` so the server always keeps the version it replaces
   * — the warning tells the teacher History can bring it back.
   */
  async function changeType(item: ItemView, target: ItemType) {
    const { item: next } = changeItemType(item, target, defaultItemFor(target), (t) => SCORING_OPTIONS[t]);
    await autosaverRef.current?.flush(item.id);
    // Held, as in restoreVersion: no ordinary autosave of `next` races this PATCH.
    autosaverRef.current?.hold(item.id);
    updateItem(item.id, () => next);
    const ok = await persistItem(next, { restore: true });
    autosaverRef.current?.release(item.id);
    if (ok) {
      setOutlineMessage(`Question ${items.findIndex((i) => i.id === item.id) + 1} is now ${TYPE_LABEL[target]}.`);
    } else {
      // Refused (e.g. students have answered it): keep the question as it was;
      // persistItem has put the reason on the card.
      updateItem(item.id, () => item);
    }
  }

  /** Choice reorder (R-7): drag or Move up / Move down. Ids (and so the key) stay with their text. */
  function moveChoice(itemId: string, from: number, to: number) {
    const item = items.find((i) => i.id === itemId);
    if (!item || to < 0 || to >= item.choices.length || from === to) return;
    updateItem(itemId, (i) => ({ ...i, choices: moveInList(i.choices, from, to) }));
    setChoiceMessage({ itemId, text: choiceMoveAnnouncement(from, to, item.choices.length) });
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
    // C-8(b): the first source on a set still at the schema default flips
    // the layout to side-by-side in this same update; a set already on
    // own_page/side_by_side, or gaining a second+ source, is left alone.
    updateSet(setId, (sv) => ({
      ...sv,
      sources: [...sv.sources, { label: nextSourceLabel(sv.sources.length), text: "" }],
      layout: defaultLayoutAfterAddingSource(sv.layout, sv.sources.length),
    }));
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
              {/* Access slice 3: a co-teacher's own reminder that they are
                  not the owner — Share, Duplicate, Archive and Delete draft
                  are all missing from this same view for the same reason. */}
              {coTeachingBadge ? <Badge variant="info">{coTeachingBadge}</Badge> : null}
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
              {isOwner ? (
                <Button type="button" variant="outline" onClick={() => setShareOpen(true)}>
                  Share
                </Button>
              ) : null}
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
            Unpublish to edit. Answer keys and standards can still be changed
            here; responses already scored keep their scores.
          </AlertDescription>
        </Alert>
      ) : null}

      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(parseTab(v))}>
        {/* Narrow windows (2026-09-24): the five tabs wrap to a second
            line instead of clipping "Test sessions" behind a hidden
            scroll — the strip's fixed h-9 is what stopped them. */}
        <TabsList
          aria-label="Assessment editor sections"
          className="max-w-full flex-wrap justify-start group-data-[orientation=horizontal]/tabs:h-auto"
        >
          {EDITOR_TABS.map((t) => (
            <TabsTrigger key={t} value={t}>
              {TAB_LABEL[t]}
            </TabsTrigger>
          ))}
        </TabsList>

      <TabsContent value="settings" className="mt-6">
      <SettingsTab
        assessment={assessment}
        items={items}
        name={name}
        setName={setName}
        description={description}
        setDescription={setDescription}
        timeLimitMinutes={timeLimitMinutes}
        setTimeLimitMinutes={setTimeLimitMinutes}
        allowLlm={allowLlm}
        setAllowLlm={setAllowLlm}
        studentLayout={studentLayout}
        setStudentLayout={setStudentLayout}
        calculatorMode={calculatorMode}
        setCalculatorMode={setCalculatorMode}
        calculatorPreset={calculatorPreset}
        setCalculatorPreset={setCalculatorPreset}
        settingsSave={settingsSave}
        saveMetadata={saveMetadata}
        allowHighlighting={allowHighlighting}
        highlightSave={highlightSave}
        saveHighlighting={saveHighlighting}
        isLocked={isLocked}
        isOwner={isOwner}
        isPending={isPending}
        refresh={refresh}
        archivedAt={archivedAt}
        archiveBusy={archiveBusy}
        archiveError={archiveError}
        toggleArchive={toggleArchive}
        setDeleteDraftOpen={setDeleteDraftOpen}
        setDeleteDraftError={setDeleteDraftError}
      />
      </TabsContent>

      <TabsContent value="accommodations" className="mt-6">
      <AccommodationsTab
        assessment={assessment}
        isLocked={isLocked}
        refresh={refresh}
        accommodationsByOspi={accommodationsByOspi}
        allowedAccommodations={allowedAccommodations}
        toggleAccommodation={toggleAccommodation}
        constructAltering={constructAltering}
        toggleConstructAltering={toggleConstructAltering}
        accomSave={accomSave}
        selectedPeriod={selectedPeriod}
        setSelectedPeriod={setSelectedPeriod}
      />
      </TabsContent>

      <TabsContent value="questions" className="mt-6">
      <section className="space-y-4">
        <QuestionsToolbar
          assessment={assessment}
          items={items}
          persistedSets={persistedSets}
          isLocked={isLocked}
          isPending={isPending}
          newAuthoring={newAuthoring}
          startWith={startWith}
          previewOpen={previewOpen}
          setPreviewOpen={setPreviewOpen}
          reloadFromServer={reloadFromServer}
          addType={addType}
          setAddType={setAddType}
          adding={adding}
          addItem={addItem}
          usedStandards={usedStandards}
          suggestions={suggestions}
          onSuggested={onSuggested}
          suggestionNote={suggestionNote}
          setSuggestionNote={setSuggestionNote}
          aiPanelOpen={aiPanelOpen}
          setAiPanelOpen={setAiPanelOpen}
          aiPrompt={aiPrompt}
          setAiPrompt={setAiPrompt}
          aiType={aiType}
          setAiType={setAiType}
          aiBusy={aiBusy}
          generateWithAi={generateWithAi}
          proposal={proposal}
          updateProposal={updateProposal}
          saveProposal={saveProposal}
          discardProposal={discardProposal}
        />

        {newAuthoring && items.length > 0 ? (
          <div className="mb-4 space-y-3">
            <AutosaveIndicator
              summary={autosaveSummary(
                items.map((i) => ({
                  id: i.id,
                  dirty: persisted[i.id] !== fingerprint(i),
                  saving: itemSave[i.id]?.kind === "saving",
                  failed: !!itemErrors[i.id],
                  blocked: !canAutosave(i),
                  waiting: waitsOnBlank(i),
                })),
              )}
              questionNumber={(id) => items.findIndex((i) => i.id === id) + 1}
              onJump={jumpToItem}
              onRetry={retryFailedSaves}
            />
            {!isLocked ? (
              <BeforePublishingList entries={beforePublishing(items, itemSets)} onJump={jumpToItem} />
            ) : null}
          </div>
        ) : null}

        {/* Phase 5 slice B (R-11): editor | student preview at ≥ 1280 px;
            below that, a toggle between the two panes. */}
        {newAuthoring && previewOpen ? (
          <div role="tablist" aria-label="Show" className="flex gap-1 xl:hidden">
            {(["editor", "preview"] as const).map((pane) => (
              <Button
                key={pane}
                type="button"
                role="tab"
                size="sm"
                variant={narrowPane === pane ? "default" : "outline"}
                aria-selected={narrowPane === pane}
                aria-controls={pane === "editor" ? "editor-panel" : "preview-panel"}
                onClick={() => setNarrowPane(pane)}
              >
                {pane === "editor" ? "Editor" : "Student preview"}
              </Button>
            ))}
          </div>
        ) : null}
        <div className={newAuthoring && previewOpen ? "grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(26rem,42%)]" : undefined}>
        <div
          id={newAuthoring && previewOpen ? "editor-panel" : undefined}
          className={newAuthoring && previewOpen && narrowPane === "preview" ? "hidden xl:block" : undefined}
        >
        {/* R-6 / R-7: the new editor puts the outline rail beside the list. */}
        <div className={newAuthoring && items.length > 0 ? "grid items-start gap-4 lg:grid-cols-[15rem_minmax(0,1fr)]" : undefined}>
        {newAuthoring && items.length > 0 ? (
          <OutlineRail
            items={items}
            disabled={isPending || isLocked || adding}
            locked={isLocked}
            onMoveBlock={moveOutlineBlock}
            onShow={(id) => document.getElementById(`question-${id}`)?.scrollIntoView({ block: "start", behavior: "smooth" })}
            announcement={outlineMessage}
          />
        ) : null}
        <div className="min-w-0">
        {items.length === 0 ? (
          newAuthoring ? (
            <div className="space-y-3">
              <EmptyState
                icon={<ListPlus />}
                title="No questions yet"
                description="Add one below, or import them from a CSV or PDF."
              />
              <InsertQuestionMenu
                prominent
                open={insertSlot === 0}
                onOpenChange={(open) => setInsertSlot(open ? 0 : null)}
                onInsert={(type) => insertItem(type, 0)}
                disabled={isLocked}
                busy={adding}
                label="Add a question"
              />
            </div>
          ) : (
          <EmptyState
            icon={<ListPlus />}
            title="No questions yet"
            description="Add a question above, or import them from a CSV or PDF."
          />
          )
        ) : (
          <ol className="space-y-4">
            {items.map((item, idx) => {
              const gaps = questionGaps(item);
              const dirty = persisted[item.id] !== fingerprint(item);
              const keyOnlyDirty = dirty && isLocked && keyOnlyEdit(persisted[item.id], item);
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
              {/* R-6: a "+" before every block (never inside a set). */}
              {newAuthoring && slotSet.has(idx) ? (
                <li>
                  <InsertQuestionMenu
                    open={insertSlot === idx}
                    onOpenChange={(open) => setInsertSlot(open ? idx : null)}
                    onInsert={(type) => insertItem(type, idx)}
                    disabled={isLocked}
                    busy={adding}
                    label={`Add a question before question ${idx + 1}`}
                  />
                </li>
              ) : null}
              {opensSet && set && bounds ? (
                <StimulusSetCard
                  assessment={assessment}
                  set={set}
                  bounds={bounds}
                  setDirty={setDirty}
                  setState={setState}
                  isLocked={isLocked}
                  isPending={isPending}
                  updateSet={updateSet}
                  saveStimulus={saveStimulus}
                  removeStimulus={removeStimulus}
                  addSource={addSource}
                  updateSource={updateSource}
                  moveSource={moveSource}
                  removeSource={removeSource}
                  sourcePickerFor={sourcePickerFor}
                  setSourcePickerFor={setSourcePickerFor}
                  setSource={setSource}
                  setError={setError}
                  describe={describe}
                />
              ) : null}
              <li
                id={newAuthoring ? `question-${item.id}` : undefined}
                tabIndex={newAuthoring ? -1 : undefined}
                onKeyDown={
                  newAuthoring && !isLocked
                    ? (e) => {
                        // R-6: "/" on a card, outside a text field, opens the
                        // add menu just after this question (or its stimulus group).
                        if (
                          !slashOpensInsertMenu({
                            key: e.key,
                            metaKey: e.metaKey,
                            ctrlKey: e.ctrlKey,
                            altKey: e.altKey,
                            defaultPrevented: e.defaultPrevented,
                            inTextField: (e.target as HTMLElement).closest(TEXT_ENTRY_SELECTOR) !== null,
                          })
                        )
                          return;
                        e.preventDefault();
                        setInsertSlot(slotAfter(items, item.id));
                      }
                    : undefined
                }
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
                    {/* R-5: the new editor saves on its own; the list's indicator says so. */}
                    {dirty && !newAuthoring ? <Badge variant="outline">Unsaved changes</Badge> : null}
                  </div>
                  <div className="flex items-center gap-1">
                    {newAuthoring ? (
                      <TypeChangeControl
                        itemLabel={`question ${idx + 1}`}
                        type={item.type}
                        targets={typeChangeTargets(item, Object.keys(TYPE_LABEL) as ItemType[])}
                        disabled={isPending || isLocked || save.kind === "saving"}
                        preview={(target) =>
                          changeItemType(item, target, defaultItemFor(target), (t) => SCORING_OPTIONS[t])
                        }
                        onChange={(target) => void changeType(item, target)}
                      />
                    ) : null}
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

                {newAuthoring && usesRichTextField(item.type) ? (
                  <div className="mt-3 block">
                    <span className="block text-sm font-medium">Question</span>
                    <RichTextField
                      id={`stem-${item.id}`}
                      label={`Question ${idx + 1}`}
                      placeholder="Type the question"
                      value={item.stem}
                      disabled={isLocked}
                      onChange={(stem) =>
                        updateItem(item.id, (i) => ({
                          ...i,
                          stem,
                          // As the textarea does: blanks follow the stem's order.
                          blanks: i.type === "fill_blank" ? orderBlanksByStem(stem, i.blanks ?? []) : i.blanks,
                        }))
                      }
                      blanks={
                        item.type === "fill_blank"
                          ? {
                              ids: (item.blanks ?? []).map((b) => b.id),
                              canInsert: !isLocked && (item.blanks ?? []).length < MAX_BLANKS,
                              limitTitle: `A question allows at most ${MAX_BLANKS} blanks`,
                              onInsert: (key) => {
                                const blankId = nextBlankId(item.stem, item.blanks ?? []);
                                const blank: FillBlankBlank = key
                                  ? { id: blankId, kind: "text", keys: [key] }
                                  : { id: blankId, kind: "text" };
                                updateItem(item.id, (i) => ({ ...i, blanks: [...(i.blanks ?? []), blank] }));
                                return blankId;
                              },
                            }
                          : undefined
                      }
                    />
                  </div>
                ) : (
                <label className="mt-3 block">
                  <span className="block text-sm font-medium">Question</span>
                  <textarea
                    id={`stem-${item.id}`}
                    value={item.stem}
                    disabled={isLocked}
                    onChange={(e) =>
                      updateItem(item.id, (i) => ({
                        ...i,
                        stem: e.target.value,
                        // FB slice 2: keep blanks in stem order as the
                        // teacher types (cut / paste can move a marker).
                        blanks:
                          i.type === "fill_blank"
                            ? orderBlanksByStem(e.target.value, i.blanks ?? [])
                            : i.blanks,
                      }))
                    }
                    rows={2}
                    placeholder={newAuthoring ? "Type the question" : undefined}
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
                    {item.type === "fill_blank" ? (
                      <InsertBlankButton
                        itemId={item.id}
                        stem={item.stem}
                        blanks={item.blanks ?? []}
                        onChange={(patch) => updateItem(item.id, (i) => ({ ...i, ...patch }))}
                        disabled={isLocked}
                      />
                    ) : null}
                  </div>
                  <MathPreview text={item.stem} />
                </label>
                )}

                <StandardsTagInput
                  value={item.standards}
                  onChange={(standards) => updateItem(item.id, (i) => ({ ...i, standards }))}
                  suggestions={usedStandards}
                />
                {/* Graphing calculator D-8: a graph shown with the question. */}
                <GraphStimulusEditor
                  value={item.graph ?? null}
                  onChange={(graph) => updateItem(item.id, (i) => ({ ...i, graph }))}
                  disabled={isLocked}
                />
                {/* Graphing calculator (D-7): only when the test has one. */}
                {calculatorMode !== "none" ? (
                  <label className="mt-2 flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={item.no_calculator === true}
                      onChange={(e) =>
                        updateItem(item.id, (i) => ({ ...i, no_calculator: e.target.checked ? true : null }))
                      }
                      disabled={isLocked}
                    />
                    <span>
                      No calculator on this question
                      {studentLayout === "scroll" ? (
                        <span className="block text-xs text-muted-foreground">
                          Takes effect only when students see one question at a time.
                        </span>
                      ) : null}
                    </span>
                  </label>
                ) : null}
                <StandardSuggestionChips
                  suggestions={suggestions[item.id] ?? []}
                  entries={suggestionEntries}
                  busy={save.kind === "saving"}
                  onAccept={(tag) => void acceptSuggestion(item.id, tag)}
                  onDismiss={(tag) => dismissSuggestion(item.id, tag)}
                />

                <ItemTypeFields
                  assessment={assessment}
                  item={item}
                  isLocked={isLocked}
                  newAuthoring={newAuthoring}
                  updateItem={updateItem}
                  choiceMessage={choiceMessageFor(choiceMessage, item.id)}
                  moveChoice={moveChoice}
                />

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
                    {SCORING_OPTIONS[item.type].filter((m) => scoringOptionShown(item, m, newAuthoring)).map((m) => (
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
                  {item.scoring_method === "hybrid" ? (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {HYBRID_HINT}
                    </p>
                  ) : null}
                </label>

                {itemError ? (
                  <Alert variant="destructive" className="mt-4">
                    <AlertTitle>{itemError}</AlertTitle>
                  </Alert>
                ) : null}

                {newAuthoring ? (
                  // R-5: no Save question — the card autosaves.
                  <div className="mt-4 flex flex-wrap items-center gap-3">
                    <Button type="button" variant="outline" size="sm" onClick={() => setHistoryFor(item.id)}>
                      History
                    </Button>
                    <StatusLine state={save} />
                  </div>
                ) : (
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
                )}
                {keyFixed[item.id] && !dirty ? (
                  <p role="status" className="mt-2 text-sm text-muted-foreground">
                    {KEY_FIXED_POINTER}{" "}
                    <Link
                      href={`/dashboard/${assessment.id}/results`}
                      className="underline"
                    >
                      Rescore from Results
                    </Link>
                  </p>
                ) : null}
              </li>
              </Fragment>
              );
            })}
            {newAuthoring ? (
              <li>
                <InsertQuestionMenu
                  prominent
                  open={insertSlot === items.length}
                  onOpenChange={(open) => setInsertSlot(open ? items.length : null)}
                  onInsert={(type) => insertItem(type, items.length)}
                  disabled={isLocked}
                  busy={adding}
                  label="Add a question at the end"
                />
              </li>
            ) : null}
          </ol>
        )}
        </div>
        </div>
        </div>
        {newAuthoring && previewOpen ? (
          <aside
            id="preview-panel"
            aria-label="Student preview"
            className={`xl:sticky xl:top-4 ${narrowPane === "editor" ? "hidden xl:block" : ""}`}
          >
            <InteractivePreview
              assessment={assessment}
              items={items}
              itemSets={itemSets}
              onShowItem={showItemFromPreview}
              frameClassName="h-[70vh] xl:h-[calc(100vh-12rem)]"
            />
          </aside>
        ) : null}
        </div>

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
          allowedAccommodations={[
            // U-18 (17.2): a tool a class period allows can get an exception too.
            ...new Set([
              ...allowedAccommodations,
              ...Object.values(assessment.section_accommodations).flatMap((c) => c.allowed ?? []),
            ]),
          ]}
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
          assessmentUntimed={(assessment.time_limit_seconds ?? 0) <= 0}
        />
      </TabsContent>
      </Tabs>

      <ShareDialog assessmentId={assessment.id} open={shareOpen} onOpenChange={setShareOpen} />

      {(() => {
        const historyItem = historyFor ? items.find((i) => i.id === historyFor) : undefined;
        return newAuthoring && historyItem ? (
          <ItemHistoryDialog
            open
            onOpenChange={(open) => {
              if (!open) setHistoryFor(null);
            }}
            assessmentId={assessment.id}
            itemId={historyItem.id}
            questionNumber={items.indexOf(historyItem) + 1}
            locked={isLocked}
            onRestore={(v) => restoreVersion(historyItem, v)}
          />
        ) : null;
      })()}

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

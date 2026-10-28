"use client";
import { needsAnswerKey } from "./readiness";

import { useEffect, useRef, useState } from "react";
import { FilePicker } from "@/components/app/FilePicker";
import { RenderedText } from "@/components/app/RenderedText";
import { ChangedFromPdf } from "./ChangedFromPdf";
import { attachFigure, figureFileName, figureUseLabel, itemRangeLabel, stemSnippet } from "./pdfFigures";
import type { CandidateChange } from "@/lib/pdfImport/extractCore";
import { itemTypeName } from "@/lib/items/typeLabel";
import { hasKeyedBlank, orderBlanksByStem, stemWithGaps } from "@/lib/items/fillBlankEditor";
import type { FillBlankBlank } from "@secure-test/schema";
import type { ItemType } from "@/db/schema";
import type { CandidateRegion } from "@/lib/pdfImport/regions";
import { proposedSetLayout } from "@/lib/pdfImport/setLayout";
import {
  addChoice,
  editableKey,
  editedFields,
  editsChoices,
  removeChoice,
  setChoiceText,
  toggleKey,
} from "@/lib/pdfImport/cardEdit";
import { isProposedPageGroup, prependToSet, splitProposedGroup } from "@/lib/pdfImport/groupEdit";
import { RichTextField } from "./RichTextField";
import { MathPreview } from "./MathPreview";
import {
  TRIAGE_LABEL,
  TRIAGE_ORDER,
  acceptSkip,
  convertUnconverted,
  readyToAccept,
  triageCandidate,
  triageCounts,
  unconvertedTargets,
  type Triage,
  type TriageField,
  type TriageStatus,
  type UnconvertedProposal,
} from "@/lib/pdfImport/triage";
import { PdfSourcePane, type SourceRegion } from "./PdfSourcePane";
import { DocxSourcePane } from "./DocxSourcePane";
import type { WordBlock } from "@/lib/docxImport/document";

// Slice 42: PDF item import. Upload a PDF → the server extracts text (or,
// for scanned/image PDFs, has the model read the pages directly — slice 44
// AI OCR, ADR 0015) and an LLM (mock by default) proposes candidate items.
// One big review list: the teacher adds the ones worth keeping (each goes
// through the normal item-create path and can then be edited in place) and
// skips the junk. Nothing is written until the teacher clicks Add.

interface Candidate {
  type: string;
  stem: string;
  choices?: { id: string; text: string }[];
  correct_choice_ids?: string[];
  correct_answer?: string | null;
  scoring_method?: string;
  max_word_count?: number;
  placeholder?: string;
  rubric?: unknown;
  /** E1: match candidates carry their pairs (the answer key). */
  pairs?: { id: string; left: string; right: string }[];
  /** E3: table candidates carry their grid (keys never come from a PDF). */
  columns?: { id: string; label: string }[];
  rows?: { id: string; label: string }[];
  corner?: string;
  /** FB slice 4: fill_blank candidates carry their blanks (Add posts them). */
  blanks?: FillBlankBlank[];
}

interface ExtractResult {
  page_count: number;
  extracted_chars: number;
  ocr_used: boolean;
  candidates: Candidate[];
  rejected: { index: number; errors: string[] }[];
  rejected_count: number;
  /** Aligned with `candidates`: what the model changed from the printed
   *  text (beta feedback 2026-10-07). Absent from an older server. */
  changes?: CandidateChange[][];
  truncated: boolean;
  // E8 (lib/pdfImport/extractCore.ts numberingReport): the document's own
  // numbering vs what came back.
  numbered_items: number | null;
  extracted_count: number;
  missing_numbers: number[] | null;
  shortfall: boolean;
  // E5 slice 4: figures found in the PDF, in document order. Multi-source
  // stimulus slice 5 adds vector ones — charts drawn as paths, rasterised on
  // the server — with the printed title line above them as `caption`.
  figures: {
    n: number;
    page: number;
    width_px: number;
    height_px: number;
    data_url: string | null;
    omitted?: string;
    source?: "raster" | "vector";
    caption?: string;
    /** Import fixes slice 2: the answer key's own drawing (a sample answer).
     * Labelled and in no proposed set; the teacher can still add it to a
     * question on purpose with "Use with item…". */
    answer_key?: boolean;
    /** PDF-import fixes: a blank answer area (an empty grid or table to fill).
     * Same handling as `answer_key`. */
    answer_area?: boolean;
    /** Two prose lines inside the drawing (an instructions box or a chart):
     * its text is already in the questions; same handling as `answer_key`. */
    text_inside?: boolean;
  }[];
  figure_count: number;
  // E5 slice 3: proposed stimulus sets over candidate indexes. `source` says
  // whether the model paired them or the adjacency rule ("the figure
  // immediately above") did — the teacher confirms either way.
  proposed_sets: ProposedSet[];
  rejected_sets: { index: number; reason: string }[];
  // E9: several forms in one PDF — `groups` are validated candidate indexes
  // per form (null when only "Form A / Form B" labels were seen).
  forms: { count: number; groups: number[][] | null; source: "numbering" | "labels" } | null;
  /** PDF-import fixes (2026-10-25): repeated questions (a form printed twice
   * on a page) left out of `candidates`. */
  print_copies_dropped?: number;
  // Editor redesign Phase 7 slice A (R-8). Aligned with `candidates`; absent
  // from an older server.
  source_numbers?: number[][];
  regions?: (CandidateRegion | null)[];
  converted?: ({ from: string; to: string } | null)[];
  pages?: { width: number; height: number }[];
  /** Aligned with `rejected`: each refused proposal as text. */
  unconverted?: (UnconvertedProposal & { source_numbers: number[]; region: CandidateRegion | null })[];
  // Editor redesign Phase 7 slice B (R-10): a Word document (flag on only)
  // comes back with its blocks for the review's left pane.
  source_kind?: "pdf" | "docx";
  document?: { blocks: WordBlock[]; pictures: number };
}

/** R-10 (flag on): the file types the picker offers. */
const WORD_ACCEPT = ".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document";

// Multi-source stimulus slice 3 (docs/multi-source-stimulus-design.md): a
// labelled source the model read out of the document.
interface ProposedSource {
  label: string;
  text: string;
  /** The document's text under this heading is markedly longer than what
   * came back — the model abbreviated it (flagShortenedSources). */
  shortened?: boolean;
}

type SetLayout = "inline" | "own_page" | "side_by_side";

/** The editor's own wording for the three layouts, so the card and the
 * stimulus card in AssessmentEditor read the same. */
const LAYOUT_LABEL: Record<SetLayout, string> = {
  inline: "Shown above its questions",
  own_page: "On its own page",
  side_by_side: "Side by side (sources beside the question)",
};

interface ProposedSet {
  id: string;
  stimulus: string;
  figures: number[];
  item_indexes: number[];
  source: "model" | "adjacency";
  /** Always present ([] when the document had no labelled sources). */
  sources: ProposedSource[];
  /** `side_by_side` when the set has sources, else `inline` (D-2: the
   * teacher can change it on the card before Add). */
  layout: SetLayout;
  /** More than 12 sources came back; the list was cut. */
  sources_truncated?: boolean;
  /** E13: a scan's set that depends on a figure nothing could extract. */
  needs_figure?: boolean;
}

// E2/E4 (James, 2026-09-01): the extractor proposes essay for typed work
// ("show your work") and drawing_upload for graphs and figures, and either
// way the teacher may want the other — surface the choice on every essay
// and drawing candidate, before Add. Both are stem-only shapes, so the swap
// is a type change and nothing else (essay-only fields are dropped by the
// item schema if a candidate carried any).
// E3 slice 4: a table candidate offers the same kind of choice — the grid,
// or an essay text box (the grid is dropped; the stem stays).
type WorkType = "drawing_upload" | "essay" | "table";
const WORK_TYPE_LABEL: Record<WorkType, string> = {
  drawing_upload: "Drawing / upload (hand-scored)",
  essay: "Essay text box",
  table: "Table (a grid of cells to fill in)",
};
/** Which alternatives a candidate of this type is offered; none = no choice. */
function workTypeOptions(type: string): readonly WorkType[] {
  if (type === "drawing_upload" || type === "essay") return ["drawing_upload", "essay"];
  if (type === "table") return ["table", "essay"];
  return [];
}

// Multi-source stimulus slice 5: the figure markers a source's text still
// carries. The model is told to keep one on its own line where the figure is
// printed; Add turns each into an image ref (or strips it when the teacher
// discarded that figure).
const FIGURE_MARKER_RE = /\[FIGURE (\d+)\]/g;
export function figureNumbersIn(text: string): number[] {
  return [...new Set([...text.matchAll(FIGURE_MARKER_RE)].map((m) => Number(m[1])))];
}

// FB slice 4: the card's "Needs answer key" badge. A fill-in-the-blank with
// no keyed blank is a valid item (hand-scored per blank, E3-F1 — so it is not
// a readiness gap and needsAnswerKey stays false for it), but on a PDF card
// it means the document's key did not come through, like a keyless MC.
export function candidateNeedsKey(c: Candidate): boolean {
  if (c.type === "fill_blank") return !hasKeyedBlank(c.blanks ?? null);
  return needsAnswerKey(c);
}

function typeLabel(c: Candidate): string {
  const name = itemTypeName(c.type);
  if (c.type === "match") return `${name} · ${c.pairs?.length ?? 0} pairs`;
  if (c.type === "drawing_upload") return `${name} · hand-scored`;
  if (c.type === "table") return `${name} · ${c.columns?.length ?? 0} × ${c.rows?.length ?? 0} cells`;
  if (c.type === "fill_blank") {
    const n = c.blanks?.length ?? 0;
    return `${name} · ${n} blank${n === 1 ? "" : "s"}`;
  }
  return name;
}

interface Props {
  assessmentId: string;
  /** E9 slice 2: the sibling drafts are named after this one ("… — Form 2"). */
  assessmentName: string;
  disabled: boolean;
  onImported: () => void;
  /** R-12: the side-by-side, triaged review (Phase 7 slice A). */
  newAuthoring?: boolean;
  /** Phase 8 (D-5): open on first render, for a draft started as "Import from PDF or Word". */
  initialOpen?: boolean;
}

/** R-8 triage colours: amber means "look at this", as elsewhere on the card. */
const TRIAGE_BADGE: Record<TriageStatus, string> = {
  ready: "bg-success text-success-foreground",
  needs_key: "bg-warning-foreground/10 text-warning-foreground",
  check: "bg-warning-foreground/20 text-warning-foreground",
  cant_convert: "bg-destructive/10 text-destructive",
};
/** The ring on a field a "check this" reason is about. */
const CHECK_RING = "rounded ring-2 ring-warning-foreground/60 ring-offset-1";

export function PdfImportPanel({
  assessmentId,
  assessmentName,
  disabled,
  onImported,
  newAuthoring = false,
  initialOpen = false,
}: Props) {
  const [open, setOpen] = useState(initialOpen);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ExtractResult | null>(null);
  const [added, setAdded] = useState<Set<number>>(new Set());
  // Per-candidate drawing↔essay choice (E2/E4); absent = as proposed.
  const [workTypes, setWorkTypes] = useState<Map<number, WorkType>>(new Map());
  // E5 slice 3: the sets as the teacher has shaped them (split / merge /
  // discard figure / edit text) — local until Add.
  const [sets, setSets] = useState<ProposedSet[]>([]);
  const [addedSets, setAddedSets] = useState<Set<string>>(new Set());
  // Multi-source stimulus slice 3: which source previews are expanded into
  // an editable textarea, keyed `${setId}:${index}` (collapsed by default —
  // four AP sources are 13k characters).
  const [openSources, setOpenSources] = useState<Set<string>>(new Set());
  // E9 (decision James 2026-09-02): what to do with a multi-form PDF.
  // "all" keeps today's behaviour (every form into this draft, the default);
  // "first" hides every group but the first. Per-student form assignment
  // is deferred post-MVP.
  // Slice 2 adds "split": form 1 into this draft, every other form into a
  // new draft of its own, all from Add all.
  const [formChoice, setFormChoice] = useState<"all" | "first" | "split">("all");
  const formGroups = result?.forms?.groups ?? null;
  const hidden = new Set<number>(
    formChoice !== "all" && formGroups ? formGroups.slice(1).flat() : [],
  );
  // E9 slice 2: the drafts Add all created, for the links under the notice.
  const [createdDrafts, setCreatedDrafts] = useState<{ id: string; name: string; count: number }[]>([]);
  // Beta feedback 2026-10-08 slice 2: figures the teacher saved to the
  // Images page from the strip (James 5.2: a teacher action, never automatic).
  const [savedFigures, setSavedFigures] = useState<Set<number>>(new Set());
  // ---- Editor redesign Phase 7 slice A (R-8), flag on only ----
  // The file the teacher picked, drawn in the source pane (never re-sent).
  const [file, setFile] = useState<File | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  // Below 1280 px one pane shows at a time (R-11).
  const [pane, setPane] = useState<"source" | "items">("items");
  const [filter, setFilter] = useState<TriageStatus | "all">("all");
  // The card / region pair last selected on either side, and a request for
  // the source pane to scroll to one.
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [focusRequest, setFocusRequest] = useState<{ key: string; n: number } | null>(null);
  // A refused proposal the teacher turned into a question (candidate index →
  // its `unconverted` index), or left out.
  const [fromUnconverted, setFromUnconverted] = useState<Map<number, number>>(new Map());
  const [leftOut, setLeftOut] = useState<Set<number>>(new Set());
  const [chosenTypes, setChosenTypes] = useState<Map<number, ItemType>>(new Map());
  // Beta report 2026-10-28 (flag on only): the teacher's edits to a card,
  // over `result.candidates` (which stays the import's own proposal, so
  // triage still reads what the model returned). Accept posts the edited
  // question. `editing` is which cards have their Edit toggle open.
  const [edits, setEdits] = useState<Map<number, Candidate>>(new Map());
  const [editing, setEditing] = useState<Set<number>>(new Set());
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (!reviewOpen) return;
    reviewHeading.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setReviewOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [reviewOpen]);

  /** The question as Accept will post it: the teacher's edit, else the proposal. */
  function candidateAt(i: number): Candidate {
    return edits.get(i) ?? result!.candidates[i]!;
  }
  function updateCandidate(i: number, mut: (c: Candidate) => Candidate) {
    setEdits((prev) => new Map(prev).set(i, mut(prev.get(i) ?? result!.candidates[i]!)));
  }
  function toggleEditing(i: number) {
    setEditing((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  }

  const keyless = result ? result.candidates.filter((_, i) => candidateNeedsKey(candidateAt(i))).length : 0;
  // R-10: a Word result is only ever returned with the flag on, so with it
  // off every string below still says "PDF".
  const isWord = result?.source_kind === "docx";
  const srcNoun = isWord ? "document" : "PDF";
  const needFigure = sets.filter((s) => s.needs_figure && !addedSets.has(s.id)).length;
  // The questions a figure can still go with: shown, not added, and not in
  // a set that was added.
  const attachable = result
    ? result.candidates
        .map((c, i) => ({ i, c }))
        .filter(
          ({ i }) =>
            !hidden.has(i) &&
            !added.has(i) &&
            !sets.some((s) => addedSets.has(s.id) && s.item_indexes.includes(i)),
        )
    : [];

  async function extract(file: File) {
    setBusy(true);
    setError(null);
    setResult(null);
    setAdded(new Set());
    setWorkTypes(new Map());
    setSets([]);
    setAddedSets(new Set());
    setOpenSources(new Set());
    setFormChoice("all");
    setCreatedDrafts([]);
    setSavedFigures(new Set());
    setFile(newAuthoring ? file : null);
    setFilter("all");
    setActiveKey(null);
    setFocusRequest(null);
    setFromUnconverted(new Map());
    setLeftOut(new Set());
    setChosenTypes(new Map());
    setEdits(new Map());
    setEditing(new Set());
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch(
        `/api/assessments/${assessmentId}/items/import-pdf`,
        { method: "POST", body: form },
      );
      // A non-JSON failure body (proxy/500) used to surface as a raw
      // "Unexpected end of JSON input" TypeError (ERAS exam, 2026-09-01).
      const body = (await res.json().catch(() => null)) as
        | (ExtractResult & { ok: boolean; error?: string; hint?: string })
        | null;
      if (!res.ok || !body?.ok) {
        throw new Error(body?.hint ?? body?.error ?? `HTTP ${res.status}`);
      }
      setResult(body);
      if (newAuthoring) {
        setReviewOpen(true);
        setPane("items");
      }
      // Multi-source stimulus slice 3: `sources` / `layout` always ride the
      // response, but default them so an older cached response cannot crash
      // the card.
      const known = new Set((body.figures ?? []).map((f) => f.n));
      setSets(
        (body.proposed_sets ?? []).map((s) => {
          const sources = s.sources ?? [];
          // Slice 5: a figure a source's text places is used by the set — it
          // shows in the card's thumbnails and can be discarded there.
          const inSources = sources.flatMap((src) => figureNumbersIn(src.text)).filter((n) => known.has(n));
          return {
            ...s,
            sources,
            figures: [...new Set([...s.figures, ...inSources])],
            layout: s.layout ?? proposedSetLayout(sources.length > 0),
          };
        }),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  /** Post one candidate through the normal item-create path. The created
   * item id comes back so a set can be built over it. */
  async function postItem(index: number, cand: Candidate, targetId: string = assessmentId): Promise<string | null> {
    const chosen = workTypes.get(index);
    const body = chosen && chosen !== cand.type ? { ...cand, type: chosen } : cand;
    const res = await fetch(`/api/assessments/${targetId}/items`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => null)) as { detail?: string; error?: string } | null;
      throw new Error(err?.detail ?? err?.error ?? `HTTP ${res.status}`);
    }
    const created = (await res.json()) as { item: { id: string } };
    setAdded((prev) => new Set(prev).add(index));
    return created.item.id;
  }

  async function add(index: number, cand: Candidate): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      await postItem(index, cand);
      onImported();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  /** E5 slice 3: a figure becomes an asset only now — extraction wrote
   * nothing. Same upload route the image picker uses; per-owner dedupe by
   * hash means re-adding the same figure re-uses the asset. */
  async function uploadFigure(n: number): Promise<string> {
    const fig = result?.figures.find((f) => f.n === n);
    if (!fig?.data_url) throw new Error(`Figure ${n} has no image to upload`);
    const blob = await (await fetch(fig.data_url)).blob();
    const form = new FormData();
    // Slice 2 (James 5.3): named after the printed caption when there is one,
    // so the editor's Image… picker lists "Votes by state.png".
    form.append("file", new File([blob], figureFileName(n, fig.caption), { type: "image/png" }));
    const res = await fetch("/api/uploads/image", { method: "POST", body: form });
    if (!res.ok) {
      const err = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(err?.error ?? `figure upload failed (HTTP ${res.status})`);
    }
    const body = (await res.json()) as { asset?: { id: string }; id?: string };
    const id = body.asset?.id ?? body.id;
    if (!id) throw new Error("figure upload returned no asset id");
    return id;
  }

  /** Slice 2: "Save to Images" — the same upload Add does, on its own. */
  async function saveFigures(ns: readonly number[]) {
    setBusy(true);
    setError(null);
    try {
      for (const n of ns) {
        if (savedFigures.has(n)) continue;
        await uploadFigure(n);
        setSavedFigures((prev) => new Set(prev).add(n));
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  /** Add a set: its figures become assets, its questions are posted in
   * order (they land next to each other), then the set groups them with a
   * stimulus made of the image refs plus the text. A failure after the
   * questions are in leaves them ungrouped and says so. */
  async function addSet(set: ProposedSet, targetId: string = assessmentId): Promise<boolean> {
    if (!result) return false;
    setBusy(true);
    setError(null);
    let postedIds: string[] = [];
    try {
      // Slice 5: one upload per figure, shared between the introduction and
      // the source texts that place it. The alt is the printed caption (the
      // chart title) when the extractor found one.
      const uploaded = new Map<number, string>();
      const assetFor = async (n: number): Promise<string> => {
        const hit = uploaded.get(n);
        if (hit) return hit;
        const id = await uploadFigure(n);
        uploaded.set(n, id);
        return id;
      };
      const altFor = (n: number) => result.figures.find((f) => f.n === n)?.caption ?? `Figure ${n}`;
      // A figure a source places sits inside that source, not above the set.
      const placedInSources = new Set(set.sources.flatMap((s) => figureNumbersIn(s.text)));
      const refs: string[] = [];
      for (const n of set.figures) {
        if (placedInSources.has(n)) continue;
        refs.push(`![${altFor(n)}](asset:${await assetFor(n)})`);
      }
      for (const i of set.item_indexes) {
        if (added.has(i)) continue;
        const id = await postItem(i, candidateAt(i), targetId);
        if (id) postedIds.push(id);
      }
      if (postedIds.length === 0) throw new Error("nothing to group — those questions were already added");
      const stimulus_text = [...refs, set.stimulus.trim()].filter(Boolean).join("\n");
      // Multi-source stimulus slice 3: the sources and the card's layout ride
      // the create call (slice 2 made the route take both). `shortened` is a
      // panel-only hint and never leaves the browser; a source the teacher
      // emptied the label of is dropped rather than failing the write schema.
      // Slice 5: each `[FIGURE n]` a source kept becomes the picture at that
      // point; a marker for a figure the teacher discarded (or that never
      // came back) is stripped rather than shown to a student.
      const kept = new Set(
        set.figures.filter((n) => result.figures.some((f) => f.n === n && f.data_url)),
      );
      const sources: { label: string; text: string }[] = [];
      for (const s of set.sources) {
        const label = s.label.trim();
        if (label.length === 0) continue;
        let text = s.text;
        for (const n of figureNumbersIn(text)) {
          if (kept.has(n)) {
            text = text.split(`[FIGURE ${n}]`).join(`![${altFor(n)}](asset:${await assetFor(n)})`);
          } else {
            // Whole line out, so a discarded figure leaves no blank gap.
            text = text.replace(new RegExp(`^[ \\t]*\\[FIGURE ${n}\\][ \\t]*\\n?`, "gm"), "");
            text = text.split(`[FIGURE ${n}]`).join("");
          }
        }
        sources.push({ label, text });
      }
      const res = await fetch(`/api/assessments/${targetId}/item-sets`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // A page group is one page whatever the card's layout says.
        body: JSON.stringify({
          item_ids: postedIds,
          stimulus_text,
          sources,
          layout: isProposedPageGroup(set) ? "inline" : set.layout,
        }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => null)) as { hint?: string; error?: string } | null;
        throw new Error(
          `questions added but not grouped: ${err?.hint ?? err?.error ?? `HTTP ${res.status}`}`,
        );
      }
      setAddedSets((prev) => new Set(prev).add(set.id));
      onImported();
      return true;
    } catch (e) {
      setError((e as Error).message);
      if (postedIds.length > 0) onImported();
      return false;
    } finally {
      setBusy(false);
    }
  }

  /** Add the candidates at `indexes` (document order) to `targetId`, sets
   * first so a set's questions land next to each other. Returns how many
   * adds failed. */
  async function addRange(indexes: readonly number[], targetId: string): Promise<number> {
    if (!result) return 0;
    let failed = 0;
    for (const i of indexes) {
      if (added.has(i)) continue;
      const set = sets.find((s) => s.item_indexes[0] === i);
      if (set && !addedSets.has(set.id)) {
        if (!(await addSet(set, targetId))) failed += 1;
        continue;
      }
      if (sets.some((s) => s.item_indexes.includes(i))) continue; // inside a set handled above
      if (targetId === assessmentId) {
        if (!(await add(i, candidateAt(i)))) failed += 1;
      } else {
        try {
          await postItem(i, candidateAt(i), targetId);
        } catch (e) {
          setError((e as Error).message);
          failed += 1;
        }
      }
    }
    return failed;
  }

  /** E9 slice 2: a sibling draft for one form, named after this one. */
  async function createSiblingDraft(formNumber: number): Promise<{ id: string; name: string }> {
    const name = `${assessmentName} — Form ${formNumber}`.slice(0, 200);
    const res = await fetch("/api/assessments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(`could not create the draft for Form ${formNumber}: ${err?.error ?? `HTTP ${res.status}`}`);
    }
    const body = (await res.json()) as { assessment: { id: string } };
    return { id: body.assessment.id, name };
  }

  /** `only` (R-8 "Accept all ready"): add just these candidate indexes. */
  async function addAll(only?: ReadonlySet<number>) {
    if (!result) return;
    // Review fix (2026-08-14): each add() clears the error banner, so a
    // mid-list failure used to vanish behind later successes. Tally and
    // report the aggregate instead. E5 slice 3: walk in document order so a
    // set's questions land next to each other. E9: "Form 1 only" leaves the
    // hidden groups out; "One assessment per form" sends form 1 here and
    // every other form to a new draft of its own.
    const visible = result.candidates.map((_, i) => i).filter((i) => !hidden.has(i) && (!only || only.has(i)));
    let failed = await addRange(visible, assessmentId);
    if (formChoice === "split" && formGroups) {
      setBusy(true);
      try {
        for (let k = 1; k < formGroups.length; k++) {
          // "Accept all ready" (`only`) can leave a form with nothing ready:
          // no empty draft is made for it.
          const group = formGroups[k]!.filter((i) => !only || only.has(i));
          if (group.length === 0) continue;
          const draft = await createSiblingDraft(k + 1);
          failed += await addRange(group, draft.id);
          setCreatedDrafts((prev) => [...prev, { ...draft, count: group.length }]);
        }
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(false);
      }
    }
    if (failed > 0) {
      setError(`${failed} item(s) failed to add (see the list — failed items are still addable)`);
    }
  }

  // ---- Editor redesign Phase 7 slice A (R-8): triage ----
  /** Each candidate's pile (lib/pdfImport/triage.ts). */
  function triageOf(i: number): Triage {
    const c = result!.candidates[i]!;
    const set = sets.find((s) => s.item_indexes.includes(i)) ?? null;
    const cur = candidateAt(i);
    return triageCandidate({
      candidate: c,
      needsKey: candidateNeedsKey(cur),
      reviewed: editedFields(c, cur),
      changes: result!.changes?.[i] ?? [],
      convertedFrom: result!.converted?.[i]?.from ?? null,
      set,
      typeChosen: fromUnconverted.has(i),
    });
  }
  const triages = result && newAuthoring ? result.candidates.map((_, i) => triageOf(i)) : [];
  // A form the teacher chose not to show is not counted or accepted.
  const shownStatuses = triages.map((t, i) => (hidden.has(i) ? null : t.status));
  const openUnconverted = (result?.unconverted ?? []).filter(
    (u) => !leftOut.has(u.index) && ![...fromUnconverted.values()].includes(u.index),
  );
  const counts = triageCounts([
    ...shownStatuses.filter((s): s is TriageStatus => s !== null),
    ...openUnconverted.map(() => "cant_convert" as const),
  ]);
  const readyIndexes = readyToAccept(
    triages.map((t) => t.status),
    sets.filter((s) => !addedSets.has(s.id)),
    acceptSkip(formChoice, hidden, added),
  );
  /** A card's link to its place in the source. A Word document has no pages. */
  function sourceLinkLabel(region: CandidateRegion): string {
    if (isWord) return region.how === "order" ? "Position not found — show in document" : "Show in document";
    return `Page ${region.page}${region.how === "order" ? " (by order)" : ""} — show in PDF`;
  }
  function cardKey(i: number): string {
    return `c${i}`;
  }
  function unconvertedKey(index: number): string {
    return `u${index}`;
  }
  /** Card → source: select the pair and scroll the PDF to it. */
  function showInSource(key: string) {
    setActiveKey(key);
    setPane("source");
    setFocusRequest((prev) => ({ key, n: (prev?.n ?? 0) + 1 }));
  }
  /** Source → card: select the pair, scroll the list to the card and focus it. */
  function showCard(key: string) {
    setActiveKey(key);
    setPane("items");
    setFilter("all");
    // After the pane switch and filter have rendered.
    requestAnimationFrame(() => {
      const el = document.getElementById(`pdf-card-${key}`);
      el?.scrollIntoView({ block: "center", behavior: "smooth" });
      el?.focus({ preventScroll: true });
    });
  }
  /** "Choose a type": the refused proposal becomes a new candidate at the
   * end of the list, triaged "check this" (the teacher chose its type). */
  function convertProposal(u: NonNullable<ExtractResult["unconverted"]>[number], type: ItemType) {
    if (!result) return;
    const at = result.candidates.length;
    setResult({
      ...result,
      candidates: [...result.candidates, convertUnconverted(u, type) as Candidate],
      changes: [...(result.changes ?? result.candidates.map(() => [])), []],
      regions: [...(result.regions ?? result.candidates.map(() => null)), u.region],
      converted: [...(result.converted ?? result.candidates.map(() => null)), null],
      source_numbers: [...(result.source_numbers ?? result.candidates.map(() => [])), u.source_numbers],
    });
    setFromUnconverted((prev) => new Map(prev).set(at, u.index));
    if (activeKey === unconvertedKey(u.index)) setActiveKey(cardKey(at));
  }
  /** Every region the source pane draws: the candidates, then the refused. */
  const sourceRegions: SourceRegion[] = result
    ? [
        ...result.candidates.flatMap((_, i): SourceRegion[] => {
          const region = result.regions?.[i];
          return region && !hidden.has(i)
            ? [{ key: cardKey(i), label: String(i + 1), name: `Question ${i + 1}`, region }]
            : [];
        }),
        ...openUnconverted.flatMap((u, k): SourceRegion[] =>
          u.region
            ? [{ key: unconvertedKey(u.index), label: `✕${k + 1}`, name: `Could not convert ${k + 1}`, region: u.region, unconverted: true }]
            : [],
        ),
      ]
    : [];

  // ---- E5 slice 3: shaping a proposed set before Add ----
  function updateSet(id: string, mut: (s: ProposedSet) => ProposedSet | null) {
    setSets((prev) => prev.flatMap((s) => (s.id === id ? (mut(s) ? [mut(s)!] : []) : [s])));
  }
  /** The last question leaves the set; an emptied set disappears. */
  function splitLast(id: string) {
    updateSet(id, (s) =>
      s.item_indexes.length > 1 ? { ...s, item_indexes: s.item_indexes.slice(0, -1) } : null,
    );
  }
  /** Take the question after the block into the set (it stays contiguous). */
  function extendDown(id: string) {
    if (!result) return;
    updateSet(id, (s) => {
      const next = s.item_indexes[s.item_indexes.length - 1]! + 1;
      if (next >= result.candidates.length) return s;
      if (sets.some((o) => o.id !== id && o.item_indexes.includes(next))) return s;
      return { ...s, item_indexes: [...s.item_indexes, next] };
    });
  }
  /** Join the set whose block ends right above this one. */
  function mergeUp(id: string) {
    const me = sets.find((s) => s.id === id);
    if (!me) return;
    const above = sets.find((s) => s.item_indexes[s.item_indexes.length - 1] === me.item_indexes[0]! - 1);
    if (!above) return;
    setSets((prev) =>
      prev
        .filter((s) => s.id !== id)
        .map((s) =>
          s.id === above.id
            ? {
                ...s,
                figures: [...new Set([...s.figures, ...me.figures])],
                stimulus: [s.stimulus, me.stimulus].filter((t) => t.trim()).join("\n"),
                item_indexes: [...s.item_indexes, ...me.item_indexes],
                // Slice 3: the merged card carries both sets' sources, and
                // side_by_side wins if either half proposed it.
                sources: [...s.sources, ...me.sources],
                layout: s.layout === "side_by_side" || me.layout === "side_by_side" ? "side_by_side" : s.layout,
                ...(s.needs_figure || me.needs_figure ? { needs_figure: true } : {}),
              }
            : s,
        ),
    );
  }
  // ---- 2026-10-28: page groups (questions kept on one page) ----
  /** "Same page as question above": into the set ending above, or a new
   * group of the two loose questions. */
  function keepWithPrevious(index: number) {
    const above = sets.find((s) => s.item_indexes[s.item_indexes.length - 1] === index - 1);
    if (above) return extendDown(above.id);
    setSets((prev) => [
      ...prev,
      {
        id: `local-${Date.now()}-${index}`,
        stimulus: "",
        figures: [],
        item_indexes: [index - 1, index],
        source: "model",
        sources: [],
        layout: "inline",
      },
    ]);
  }
  /** "… below": the loose question just above a set joins it. */
  function joinSetBelow(index: number) {
    setSets((prev) => prev.map((s) => prependToSet(s, index)));
  }
  /** "Start a new page here" inside a page group. */
  function startNewPage(setId: string, index: number) {
    setSets((prev) =>
      prev.flatMap((s) => (s.id === setId ? splitProposedGroup(s, index, `local-${Date.now()}-${index}`) : [s])),
    );
  }
  function discardFigure(id: string, n: number) {
    updateSet(id, (s) => ({ ...s, figures: s.figures.filter((f) => f !== n) }));
  }
  /** Beta feedback 2026-10-08: put a figure with a question — the set that
   * holds it, or a new stimulus card of one. */
  function useFigureWith(n: number, index: number) {
    setSets((prev) =>
      attachFigure(prev, n, index, (i, figures) => ({
        id: `local-${Date.now()}-${i}`,
        stimulus: "",
        figures,
        item_indexes: [i],
        source: "model",
        sources: [],
        layout: proposedSetLayout(false),
      })),
    );
  }
  /** A loose candidate right below a set can be pulled in; anything else
   * becomes its own set of one (a passage typed by hand). */
  function startSet(index: number) {
    setSets((prev) => [
      ...prev,
      {
        id: `local-${Date.now()}-${index}`,
        stimulus: "",
        figures: [],
        item_indexes: [index],
        source: "model",
        sources: [],
        layout: proposedSetLayout(false),
      },
    ]);
  }

  // ---- Multi-source stimulus slice 3: editing a card's sources ----
  /** A teacher edit is the answer to the shortened badge, so it clears it. */
  function updateSource(setId: string, at: number, mut: (s: ProposedSource) => ProposedSource) {
    updateSet(setId, (s) => ({
      ...s,
      sources: s.sources.map((src, i) => (i === at ? mut(src) : src)),
    }));
  }
  function removeSource(setId: string, at: number) {
    updateSet(setId, (s) => ({ ...s, sources: s.sources.filter((_, i) => i !== at) }));
  }
  function toggleSource(key: string) {
    setOpenSources((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return (
    <div className="rounded-lg border border-border">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-4 py-2 text-sm font-medium"
      >
        <span>{newAuthoring ? "Import items from PDF or Word" : "Import items from PDF"}</span>
        <span aria-hidden>{open ? "−" : "+"}</span>
      </button>
      {open ? (
        <div className="space-y-3 border-t border-border p-4">
          {newAuthoring ? (
            <>
              <p className="text-xs text-muted-foreground">
                Upload a PDF or a Word document (.docx). The proposed questions open in a review beside the
                document: accept the ones you want, then edit them in place. Scanned/image PDFs are read by AI
                OCR (up to 30 pages); Word documents can be up to 5 MB, and their pictures are not imported.
              </p>
              <p id="pdf-import-gdocs-tip" className="text-xs text-muted-foreground">
                From Google Docs: <b>File → Download → Microsoft Word (.docx)</b>, then choose that file here.
              </p>
            </>
          ) : (
          <p className="text-xs text-muted-foreground">
            Upload a PDF. Proposed items appear below for review — add the
            ones you want, then edit them in place. Scanned/image PDFs are
            read by AI OCR (up to 30 pages).
          </p>
          )}
          <FilePicker
            accept={newAuthoring ? `application/pdf,.pdf,${WORD_ACCEPT}` : "application/pdf,.pdf"}
            label={newAuthoring ? "Choose a PDF or Word file…" : "Choose a PDF…"}
            aria-describedby={newAuthoring ? "pdf-import-gdocs-tip" : undefined}
            disabled={disabled || busy}
            onFile={(f) => {
              if (f) void extract(f);
            }}
          />
          {busy ? (
            <p className="text-xs text-muted-foreground">
              Working…
            </p>
          ) : null}
          {error ? (
            <p className="rounded border border-destructive/40 p-2 text-xs text-destructive">
              {error}
            </p>
          ) : null}

          {result && !newAuthoring ? renderResult(result) : null}
          {result && newAuthoring ? (
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="text-muted-foreground">
                {result.candidates.length} proposed from {file?.name ?? `the ${srcNoun}`}
              </span>
              <button
                type="button"
                onClick={() => setReviewOpen(true)}
                className="rounded-md border border-border px-2 py-1 font-medium"
              >
                Open the review
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
      {result && newAuthoring && reviewOpen ? renderReview(result) : null}
    </div>
  );

  /** The proposal list and its notices (the panel's own view, flag off; the
   * right-hand pane of the review, flag on). */
  function renderResult(result: ExtractResult) {
    return (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>
                  {result.candidates.length} proposed · {isWord ? "Word document" : (
                    <>
                  {result.page_count}{" "}
                  page(s)
                    </>
                  )}
                  {result.ocr_used ? " · scanned PDF, read by AI OCR" : ""}
                  {result.rejected_count > 0
                    ? ` · ${result.rejected_count} unparseable skipped`
                    : ""}
                  {result.truncated ? " · list truncated" : ""}
                  {keyless > 0 ? ` · ${keyless} need an answer key` : ""}
                  {result.forms ? ` · ${result.forms.count} forms` : ""}
                  {result.print_copies_dropped
                    ? ` · ${result.print_copies_dropped} repeated question${result.print_copies_dropped === 1 ? "" : "s"} (a printed copy) left out`
                    : ""}
                </span>
                {result.candidates.length > 0 && newAuthoring ? (
                  // R-8: only the ready pile goes in one click; the rest one by one.
                  <button
                    onClick={() => addAll(new Set(readyIndexes))}
                    disabled={disabled || busy || readyIndexes.length === 0}
                    className="rounded-md bg-primary px-2 py-1 text-xs font-medium text-primary-foreground disabled:opacity-40"
                  >
                    Accept all ready ({readyIndexes.length})
                  </button>
                ) : result.candidates.length > 0 ? (
                  <button
                    onClick={() => addAll()}
                    disabled={disabled || busy}
                    className="rounded-md bg-primary px-2 py-1 text-xs font-medium text-primary-foreground disabled:opacity-40"
                  >
                    Add all
                  </button>
                ) : null}
              </div>
              {keyless > 0 ? (
                <p className="rounded border border-warning-foreground/30 p-2 text-xs text-warning-foreground">
                  {keyless} proposed item{keyless === 1 ? "" : "s"} came without an
                  answer key. They can be added now and the key filled in the
                  editor (even after publishing); they are not auto-scored
                  until then.
                </p>
              ) : null}
              {result.forms ? (
                <div className="rounded border border-warning-foreground/30 p-2 text-xs text-warning-foreground">
                  <p>
                    This {srcNoun} looks like {result.forms.count} forms
                    {result.forms.groups
                      ? ` (${result.forms.groups.map((g) => g.length).join(" / ")} questions, each numbered from 1)`
                      : " (it names Form A, B… but its numbering runs on, so the questions cannot be split by form)"}
                    . Handing different forms to different students is not available yet; every form you add lands in this draft.
                  </p>
                  {result.forms.groups ? (
                    <div className="mt-1 flex flex-wrap gap-3">
                      <label className="flex items-center gap-1">
                        <input type="radio" name="pdf-forms" checked={formChoice === "all"} disabled={disabled || busy} onChange={() => setFormChoice("all")} />
                        All forms
                      </label>
                      <label className="flex items-center gap-1">
                        <input type="radio" name="pdf-forms" checked={formChoice === "first"} disabled={disabled || busy} onChange={() => setFormChoice("first")} />
                        Form 1 only ({result.forms.groups[0]!.length} questions)
                      </label>
                      <label className="flex items-center gap-1">
                        <input type="radio" name="pdf-forms" checked={formChoice === "split"} disabled={disabled || busy} onChange={() => setFormChoice("split")} />
                        One assessment per form
                      </label>
                    </div>
                  ) : null}
                  {formChoice === "split" && result.forms.groups ? (
                    <p className="mt-1">
                      Add all puts Form 1 here and creates {result.forms.groups.length - 1} new draft
                      {result.forms.groups.length - 1 === 1 ? "" : "s"} — "{assessmentName} — Form 2"
                      {result.forms.groups.length > 2 ? ` … Form ${result.forms.groups.length}` : ""} — one per remaining form.
                      The list below shows Form 1.
                    </p>
                  ) : null}
                  {createdDrafts.length > 0 ? (
                    <ul className="mt-1 list-disc pl-4">
                      {createdDrafts.map((d) => (
                        <li key={d.id}>
                          <a className="underline" href={`/dashboard/${d.id}`}>{d.name}</a> — {d.count} question{d.count === 1 ? "" : "s"}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}
              {needFigure > 0 ? (
                <p className="rounded border border-warning-foreground/30 p-2 text-xs text-warning-foreground">
                  {needFigure} stimulus set{needFigure === 1 ? "" : "s"} in this scan depend
                  {needFigure === 1 ? "s" : ""} on a figure that could not be extracted. Nothing
                  describes the figure to students. Add the figure by hand in the editor after
                  Add (the stimulus card takes an image); the publish checklist flags a set left
                  with no stimulus until then.
                </p>
              ) : null}
              {result.shortfall && result.numbered_items != null ? (
                <p className="rounded border border-warning-foreground/30 p-2 text-xs text-warning-foreground">
                  This {srcNoun} numbers its questions up to {result.numbered_items};{" "}
                  {result.extracted_count} were extracted.
                  {result.missing_numbers && result.missing_numbers.length > 0
                    ? ` Not found: ${result.missing_numbers.join(", ")}.`
                    : ""}{" "}
                  Questions that are only an image or a table in the {srcNoun} need to
                  be added by hand.
                </p>
              ) : null}
              {result.figure_count > 0 ? (
                <details className="text-xs text-muted-foreground" open>
                  <summary className="cursor-pointer underline">
                    {result.figure_count} figure{result.figure_count === 1 ? "" : "s"} found in the PDF
                  </summary>
                  {/* Beta feedback 2026-10-08 slice 3: the teacher could not
                      tell what the strip was for. */}
                  <p className="mt-1">
                    A figure marked <b>Not used</b> isn&apos;t on any question yet. Choose{" "}
                    <b>Use with item…</b> to show it above that question, or <b>Save to Images</b> to
                    add it later with the question&apos;s <b>Image…</b> button.
                  </p>
                  <ul className="mt-2 flex flex-wrap gap-2">
                    {result.figures.map((f) => (
                      <li key={f.n} className="w-28 rounded border border-border p-1 text-center">
                        {f.data_url ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={f.data_url}
                            alt={`Figure ${f.n}, page ${f.page}`}
                            className="mx-auto max-h-20 max-w-full"
                          />
                        ) : (
                          <span className="block py-6 text-[11px]">
                            {f.omitted === "too_large" ? "too large to preview" : "no preview"}
                          </span>
                        )}
                        <span className="block text-[11px]">
                          Figure {f.n} · p{f.page}
                          {/* Slice 5: a chart drawn as paths, rasterised here. */}
                          {f.source === "vector" ? (
                            <span className="ml-1 rounded bg-primary/10 px-1 py-0.5">chart</span>
                          ) : null}
                        </span>
                        {f.answer_key || f.answer_area ? (
                          <span className="mt-0.5 block rounded bg-muted px-1 py-0.5 text-[11px]">
                            {f.answer_key ? "Answer key drawing" : "Blank answer space"} — not shown to students
                            unless you add it
                          </span>
                        ) : f.text_inside ? (
                          <span className="mt-0.5 block rounded bg-muted px-1 py-0.5 text-[11px]">
                            Has text inside — its words are in the questions; add the picture only if it is a chart
                          </span>
                        ) : (() => {
                          const use = figureUseLabel(sets, f.n);
                          return use ? (
                            <span className="block text-[11px]">{use}</span>
                          ) : (
                            <span className="mt-0.5 block rounded bg-warning-foreground/10 px-1 py-0.5 text-[11px] text-warning-foreground">
                              Not used
                            </span>
                          );
                        })()}
                        {/* Review on #102: a flagged figure can still be put with a
                            question here, deliberately — the rules that flag
                            them can be wrong, and nothing else would bring
                            one back. The per-set "Add a figure…" leaves them
                            out. */}
                        {f.data_url && attachable.length > 0 ? (
                          <select
                            value=""
                            disabled={disabled || busy}
                            onChange={(e) => {
                              if (e.target.value !== "") useFigureWith(f.n, Number(e.target.value));
                            }}
                            aria-label={`Use figure ${f.n} with an item`}
                            className="mt-1 w-full rounded border border-border bg-background px-0.5 py-0.5 text-[11px]"
                          >
                            <option value="">Use with item…</option>
                            {attachable.map(({ i, c }) => (
                              <option key={i} value={i}>
                                Item {i + 1} — {stemSnippet(c.stem, 40)}
                              </option>
                            ))}
                          </select>
                        ) : null}
                        {f.data_url ? (
                          <button
                            type="button"
                            onClick={() => saveFigures([f.n])}
                            disabled={disabled || busy || savedFigures.has(f.n)}
                            className="mt-1 block w-full text-[11px] underline disabled:no-underline"
                          >
                            {savedFigures.has(f.n) ? "Saved to Images" : "Save to Images"}
                          </button>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                  {(() => {
                    // Slice 2: "Save all" leaves the key's drawings and blank answer areas out; one can
                    // still be saved on its own, deliberately.
                    const savable = result.figures
                      .filter((f) => f.data_url && !f.answer_key && !f.answer_area && !f.text_inside)
                      .map((f) => f.n);
                    const left = savable.filter((n) => !savedFigures.has(n));
                    return savable.length > 1 ? (
                      <button
                        type="button"
                        onClick={() => saveFigures(left)}
                        disabled={disabled || busy || left.length === 0}
                        className="mt-2 rounded-md border border-border px-2 py-1 text-xs disabled:opacity-40"
                      >
                        {left.length === 0 ? "All figures saved to Images" : "Save all figures to Images"}
                      </button>
                    ) : null;
                  })()}
                </details>
              ) : null}
              {newAuthoring ? renderUnconverted(result) : result.rejected.length > 0 ? (
                <details className="text-xs text-muted-foreground">
                  <summary className="cursor-pointer underline">
                    Why {result.rejected.length} item(s) could not be imported
                  </summary>
                  <ul className="mt-1 list-disc pl-4">
                    {result.rejected.map((r) => (
                      <li key={r.index}>
                        Item {r.index + 1}: {r.errors.join("; ")}
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
              <ul className="space-y-2">
                {result.candidates.map((c, i) => {
                  if (hidden.has(i)) return null; // E9: not in the chosen form
                  const set = sets.find((s) => s.item_indexes.includes(i));
                  const opensSet = set && set.item_indexes[0] === i;
                  if (set && !opensSet) return null; // rendered inside its card
                  const rows = set ? set.item_indexes : [i];
                  // R-8: the pile filter shows a set when any question in it matches.
                  if (newAuthoring && filter !== "all" && !rows.some((ri) => triages[ri]?.status === filter)) return null;
                  const setAdded = !!set && addedSets.has(set.id);
                  const above = set
                    ? sets.find((o) => o.item_indexes[o.item_indexes.length - 1] === set.item_indexes[0]! - 1)
                    : null;
                  const belowIsFree =
                    !!set &&
                    set.item_indexes[set.item_indexes.length - 1]! + 1 < result.candidates.length &&
                    !sets.some((o) => o.item_indexes.includes(set.item_indexes[set.item_indexes.length - 1]! + 1));
                  const rowsHtml = rows.map((ri) => renderRow(ri, result.candidates[ri]!));
                  if (!set) return rowsHtml[0];
                  return (
                    <li
                      key={set.id}
                      className={`rounded border border-primary/40 bg-primary/5 p-2 ${
                        newAuthoring && rows.some((ri) => triages[ri]?.reasons.some((r) => r.field === "stimulus"))
                          ? CHECK_RING
                          : ""
                      }`}
                    >
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                            {isProposedPageGroup(set) ? "Same page" : "Stimulus"} · {itemRangeLabel(set.item_indexes)}
                            {set.source === "adjacency" ? " · paired by position, please check" : ""}
                            {set.needs_figure ? " · figure not extracted" : ""}
                          </span>
                          {set.needs_figure ? (
                            <p className="mt-1 text-[11px] text-warning-foreground">
                              These questions depend on a figure in the scan. Add it by hand in the
                              editor after Add; do not describe it here.
                            </p>
                          ) : null}
                          {set.figures.length > 0 ? (
                            <ul className="mt-1 flex flex-wrap gap-2">
                              {set.figures.map((n) => {
                                const fig = result.figures.find((f) => f.n === n);
                                return (
                                  <li key={n} className="w-28 rounded border border-border bg-background p-1 text-center">
                                    {fig?.data_url ? (
                                      // eslint-disable-next-line @next/next/no-img-element
                                      <img src={fig.data_url} alt={`Figure ${n}`} className="mx-auto max-h-20 max-w-full" />
                                    ) : (
                                      <span className="block py-6 text-[11px]">no preview</span>
                                    )}
                                    <span className="block text-[11px]">Figure {n}</span>
                                    {!setAdded ? (
                                      <button
                                        type="button"
                                        onClick={() => discardFigure(set.id, n)}
                                        disabled={disabled || busy}
                                        className="text-[11px] underline"
                                      >
                                        Discard
                                      </button>
                                    ) : null}
                                  </li>
                                );
                              })}
                            </ul>
                          ) : null}
                          {(() => {
                            const others = result.figures.filter(
                              (f) =>
                                f.data_url && !f.answer_key && !f.answer_area && !f.text_inside && !set.figures.includes(f.n),
                            );
                            return !setAdded && others.length > 0 ? (
                              <select
                                value=""
                                disabled={disabled || busy}
                                onChange={(e) => {
                                  if (e.target.value !== "") useFigureWith(Number(e.target.value), set.item_indexes[0]!);
                                }}
                                aria-label="Add a figure to this stimulus"
                                className="mt-1 block rounded border border-border bg-background px-1 py-0.5 text-[11px]"
                              >
                                <option value="">Add a figure…</option>
                                {others.map((f) => (
                                  <option key={f.n} value={f.n}>
                                    Figure {f.n} · p{f.page}
                                    {f.caption ? ` — ${f.caption}` : ""}
                                    {figureUseLabel(sets, f.n) ? "" : " (not used)"}
                                  </option>
                                ))}
                              </select>
                            ) : null;
                          })()}
                          <textarea
                            value={set.stimulus}
                            disabled={disabled || busy || setAdded}
                            onChange={(e) => updateSet(set.id, (s) => ({ ...s, stimulus: e.target.value }))}
                            rows={2}
                            placeholder="Passage or data the questions share (optional when a figure is the stimulus)"
                            className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1 text-xs"
                          />
                          {/* Multi-source stimulus slice 3: the labelled
                              sources the model read, each collapsed to its
                              first line until the teacher opens it. */}
                          {set.sources.length > 0 ? (
                            <ul className="mt-2 space-y-1">
                              {set.sources.map((src, si) => {
                                const key = `${set.id}:${si}`;
                                const expanded = openSources.has(key);
                                const firstLine = src.text.split("\n").find((l) => l.trim().length > 0) ?? "";
                                return (
                                  <li key={key} className="rounded border border-border bg-background p-1">
                                    <div className="flex flex-wrap items-center gap-2">
                                      <input
                                        value={src.label}
                                        disabled={disabled || busy || setAdded}
                                        onChange={(e) =>
                                          updateSource(set.id, si, (s) => ({ ...s, label: e.target.value }))
                                        }
                                        aria-label={`Label for source ${si + 1}`}
                                        className="w-40 rounded border border-border bg-background px-1 py-0.5 text-xs font-medium"
                                      />
                                      <span className="text-[11px] text-muted-foreground">
                                        {src.text.length} characters
                                      </span>
                                      {src.shortened ? (
                                        <span className="rounded bg-warning-foreground/10 px-1.5 py-0.5 text-[11px] text-warning-foreground">
                                          Looks shorter than the document — check it
                                        </span>
                                      ) : null}
                                      <button
                                        type="button"
                                        onClick={() => toggleSource(key)}
                                        className="text-[11px] underline"
                                      >
                                        {expanded ? "Collapse" : "Expand"}
                                      </button>
                                      {!setAdded ? (
                                        <button
                                          type="button"
                                          onClick={() => removeSource(set.id, si)}
                                          disabled={disabled || busy}
                                          className="text-[11px] underline"
                                        >
                                          Remove
                                        </button>
                                      ) : null}
                                    </div>
                                    {expanded ? (
                                      <textarea
                                        value={src.text}
                                        disabled={disabled || busy || setAdded}
                                        onChange={(e) =>
                                          updateSource(set.id, si, (s) => ({
                                            ...s,
                                            text: e.target.value,
                                            // The teacher has looked at it — the
                                            // model-abbreviation warning is answered.
                                            shortened: false,
                                          }))
                                        }
                                        rows={8}
                                        aria-label={`Text of source ${si + 1}`}
                                        className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1 text-xs"
                                      />
                                    ) : (
                                      <p className="truncate text-[11px] text-muted-foreground">
                                        {firstLine || "(empty — paste the source text)"}
                                      </p>
                                    )}
                                  </li>
                                );
                              })}
                            </ul>
                          ) : null}
                          {set.sources_truncated ? (
                            <p className="mt-1 text-[11px] text-warning-foreground">
                              This set came back with more than 12 sources; the list was cut at 12.
                            </p>
                          ) : null}
                          {isProposedPageGroup(set) ? null : (
                          <label className="mt-1 block text-[11px] text-muted-foreground">
                            Layout{" "}
                            <select
                              value={set.layout}
                              disabled={disabled || busy || setAdded}
                              onChange={(e) =>
                                updateSet(set.id, (s) => ({ ...s, layout: e.target.value as SetLayout }))
                              }
                              className="rounded border border-border bg-background px-1 py-0.5 text-[11px]"
                            >
                              {(Object.keys(LAYOUT_LABEL) as SetLayout[]).map((l) => (
                                <option key={l} value={l}>
                                  {LAYOUT_LABEL[l]}
                                </option>
                              ))}
                            </select>
                          </label>
                          )}
                          <div className="mt-1 flex flex-wrap gap-2 text-[11px]">
                            <button type="button" onClick={() => splitLast(set.id)} disabled={disabled || busy || setAdded} className="underline">
                              {set.item_indexes.length > 1 ? "Split off the last question" : "Drop this stimulus"}
                            </button>
                            {belowIsFree ? (
                              <button type="button" onClick={() => extendDown(set.id)} disabled={disabled || busy || setAdded} className="underline">
                                Include the next question
                              </button>
                            ) : null}
                            {above ? (
                              <button type="button" onClick={() => mergeUp(set.id)} disabled={disabled || busy || setAdded || addedSets.has(above.id)} className="underline">
                                Merge with the stimulus above
                              </button>
                            ) : null}
                          </div>
                        </div>
                        <button
                          onClick={() => addSet(set)}
                          disabled={disabled || busy || setAdded}
                          className="shrink-0 rounded-md border border-border px-2 py-1 text-xs disabled:opacity-40"
                        >
                          {setAdded
                            ? newAuthoring ? "Accepted" : "Added"
                            : `${newAuthoring ? "Accept" : "Add"} ${
                                isProposedPageGroup(set)
                                  ? `${rows.length} on one page`
                                  : rows.length === 1
                                    ? "with stimulus"
                                    : `${rows.length} with stimulus`
                              }`}
                        </button>
                      </div>
                      <ul className="mt-2 space-y-2 border-l-2 border-primary/30 pl-2">{rowsHtml}</ul>
                    </li>
                  );
                })}
              </ul>
            </div>
    );
  }

  /** R-8 "can't convert": each proposal the item schema refused, with its
   * text, why, and a choice of type — or leave it out. None is dropped
   * without the teacher seeing it. */
  function renderUnconverted(result: ExtractResult) {
    const list = result.unconverted ?? [];
    if (list.length === 0 || (filter !== "all" && filter !== "cant_convert")) return null;
    return (
      <section aria-label="Proposals the import could not convert" className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Can&apos;t convert ({openUnconverted.length})
        </h3>
        <ul className="space-y-2">
          {list.map((u) => {
            const k = openUnconverted.indexOf(u);
            const key = unconvertedKey(u.index);
            const converted = [...fromUnconverted.entries()].find(([, ui]) => ui === u.index)?.[0];
            if (converted !== undefined) {
              return (
                <li key={key} className="rounded border border-dashed border-border p-2 text-[11px] text-muted-foreground">
                  Turned into question {converted + 1} (below).
                </li>
              );
            }
            if (leftOut.has(u.index)) {
              return (
                <li key={key} className="flex items-center justify-between gap-2 rounded border border-dashed border-border p-2 text-[11px] text-muted-foreground">
                  <span className="truncate">Left out: {stemSnippet(u.stem, 60) || "(no text)"}</span>
                  <button
                    type="button"
                    onClick={() => setLeftOut((prev) => { const next = new Set(prev); next.delete(u.index); return next; })}
                    className="underline"
                  >
                    Undo
                  </button>
                </li>
              );
            }
            const targets = unconvertedTargets(u);
            const chosen = chosenTypes.get(u.index) ?? targets[0];
            return (
              <li
                key={key}
                id={`pdf-card-${key}`}
                tabIndex={-1}
                aria-label={`Could not convert ${k + 1}`}
                className={`rounded border border-dashed bg-background p-2 ${
                  activeKey === key ? "border-primary ring-2 ring-primary/40" : "border-destructive/40"
                }`}
              >
                <div className="mb-1 flex flex-wrap items-center gap-1.5 text-[11px]">
                  <span className="rounded bg-destructive/70 px-1.5 py-0.5 font-semibold text-destructive-foreground">✕{k + 1}</span>
                  <span className={`rounded px-1.5 py-0.5 font-medium ${TRIAGE_BADGE.cant_convert}`}>
                    {TRIAGE_LABEL.cant_convert}
                  </span>
                  {u.type ? <span className="text-muted-foreground">proposed as {itemTypeName(u.type)}</span> : null}
                  <button
                    type="button"
                    onClick={() => (u.region ? showInSource(key) : undefined)}
                    disabled={!u.region}
                    className="underline disabled:no-underline disabled:text-muted-foreground"
                  >
                    {u.region ? sourceLinkLabel(u.region) : `Not found in the ${srcNoun}`}
                  </button>
                </div>
                {u.stem ? <RenderedText text={u.stem} className="block text-sm" /> : <p className="text-sm text-muted-foreground">(no question text came back)</p>}
                {u.choices.length > 0 ? (
                  <ul className="mt-1 space-y-0.5 text-xs">
                    {u.choices.map((t, ci) => (
                      <li key={ci}>
                        <span className="text-muted-foreground">{String.fromCharCode(65 + ci)}.</span>{" "}
                        <RenderedText text={t} className="inline" />
                      </li>
                    ))}
                  </ul>
                ) : null}
                <p className="mt-1 text-[11px] text-destructive">Why: {u.errors.join("; ")}</p>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
                  {targets.length > 0 ? (
                    <>
                      <label className="flex items-center gap-1">
                        Choose a type
                        <select
                          value={chosen}
                          disabled={disabled || busy}
                          onChange={(e) => setChosenTypes((prev) => new Map(prev).set(u.index, e.target.value as ItemType))}
                          className="rounded border border-border bg-background px-1 py-0.5 text-xs"
                        >
                          {targets.map((t) => (
                            <option key={t} value={t}>
                              {itemTypeName(t)}
                            </option>
                          ))}
                        </select>
                      </label>
                      <button
                        type="button"
                        onClick={() => chosen && convertProposal(u, chosen)}
                        disabled={disabled || busy || !chosen}
                        className="rounded-md border border-border px-2 py-0.5 disabled:opacity-40"
                      >
                        Make it a question
                      </button>
                    </>
                  ) : (
                    <span className="text-muted-foreground">Nothing here to convert — write it by hand if you need it.</span>
                  )}
                  <button
                    type="button"
                    onClick={() => setLeftOut((prev) => new Set(prev).add(u.index))}
                    disabled={disabled || busy}
                    className="underline"
                  >
                    Leave it out
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      </section>
    );
  }

  /** R-8 (flag on): the review, full screen — the PDF on the left with a
   * numbered box per question, the triaged proposals on the right. Below
   * 1280 px one pane shows at a time. Nothing is written until Accept. */
  function renderReview(result: ExtractResult) {
    const scanned = result.ocr_used;
    const located = (result.regions ?? []).filter((r) => r?.how === "number").length;
    return (
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="pdf-review-heading"
        className="fixed inset-0 z-50 flex flex-col bg-background"
      >
        <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-2">
          <h2 id="pdf-review-heading" ref={reviewHeading} tabIndex={-1} className="text-sm font-semibold">
            Review the import{file ? ` — ${file.name}` : ""}
          </h2>
          <div role="group" aria-label="Show" className="flex flex-wrap gap-1 text-xs">
            {(["all", ...TRIAGE_ORDER] as const).map((f) => (
              <button
                key={f}
                type="button"
                aria-pressed={filter === f}
                onClick={() => setFilter(f)}
                className={`rounded-full border px-2 py-0.5 ${filter === f ? "border-primary bg-primary/10 font-medium" : "border-border"}`}
              >
                {f === "all"
                  ? `All (${TRIAGE_ORDER.reduce((n, t) => n + counts[t], 0)})`
                  : `${TRIAGE_LABEL[f]} (${counts[f]})`}
              </button>
            ))}
          </div>
          <span className="flex-1" />
          <p className="text-[11px] text-muted-foreground">Nothing is added until you accept it.</p>
          <button
            type="button"
            onClick={() => setReviewOpen(false)}
            className="rounded-md border border-border px-2 py-1 text-xs"
          >
            Back to the editor
          </button>
        </div>
        <div role="group" aria-label="Pane" className="flex gap-1 border-b border-border px-4 py-1 text-xs xl:hidden">
          {(["source", "items"] as const).map((p) => (
            <button
              key={p}
              type="button"
              aria-pressed={pane === p}
              onClick={() => setPane(p)}
              className={`rounded px-2 py-0.5 ${pane === p ? "bg-primary/10 font-medium" : ""}`}
            >
              {p === "source" ? (isWord ? "Source document" : "Source PDF") : "Proposed questions"}
            </button>
          ))}
        </div>
        <div className="grid min-h-0 flex-1 xl:grid-cols-2">
          <div className={`min-h-0 overflow-y-auto border-r border-border p-4 ${pane === "source" ? "" : "hidden xl:block"}`}>
            {scanned ? (
              <p className="mb-2 text-xs text-muted-foreground">
                This is a scanned PDF: there is no text to find the questions in, so no boxes are drawn. Compare by
                order.
              </p>
            ) : result.candidates.length > 0 && located < result.candidates.length ? (
              <p className="mb-2 text-xs text-muted-foreground">
                {isWord
                  ? `${located} of ${result.candidates.length} questions were found in the document by their printed number. The others are listed above it.`
                  : `${located} of ${result.candidates.length} questions were found on the page by their printed number. The others are shown on the page of the question before them, or not at all.`}
              </p>
            ) : null}
            {isWord && result.document ? (
              <DocxSourcePane
                blocks={result.document.blocks}
                pictures={result.document.pictures}
                regions={sourceRegions}
                activeKey={activeKey}
                onSelect={showCard}
                focusRequest={focusRequest}
              />
            ) : file && !isWord ? (
              <PdfSourcePane
                file={file}
                regions={sourceRegions}
                activeKey={activeKey}
                onSelect={showCard}
                focusRequest={focusRequest}
              />
            ) : null}
          </div>
          <div className={`min-h-0 space-y-2 overflow-y-auto p-4 ${pane === "items" ? "" : "hidden xl:block"}`}>
            {busy ? <p className="text-xs text-muted-foreground" role="status">Working…</p> : null}
            {error ? (
              <p role="alert" className="rounded border border-destructive/40 p-2 text-xs text-destructive">
                {error}
              </p>
            ) : null}
            {renderResult(result)}
          </div>
        </div>
      </div>
    );
  }

  /** One candidate row — on its own in the list, or inside a set card. */
  function renderRow(i: number, proposed: Candidate) {
    // 2026-10-28: the card shows (and Accept posts) the teacher's edit.
    const c = edits.get(i) ?? proposed;
    const isEditing = newAuthoring && editing.has(i) && !added.has(i);
    const keyKind = editableKey(c.type);
    const mySet = sets.find((s) => s.item_indexes.includes(i)) ?? null;
    const inSet = !!mySet;
    // 2026-10-28 (flag on): page-group and stimulus controls on the card.
    const aboveSet = sets.find((s) => s.item_indexes[s.item_indexes.length - 1] === i - 1) ?? null;
    const belowSet = sets.find((s) => s.item_indexes[0] === i + 1) ?? null;
    const aboveFree = i > 0 && !hidden.has(i - 1) && !added.has(i - 1) && (!aboveSet || !addedSets.has(aboveSet.id));
    const prevInSet = i > 0 && sets.some((s) => s.item_indexes.includes(i - 1));
    // R-8 (flag on): the card's pile, its place on the PDF, and the fields a
    // "check this" reason is about.
    const tri = newAuthoring ? triages[i] : undefined;
    const ring = (field: TriageField) => (tri?.reasons.some((r) => r.field === field) ? CHECK_RING : "");
    const ringChoices = new Set(tri?.reasons.flatMap((r) => r.choiceIds ?? []) ?? []);
    const key = cardKey(i);
    const region = result?.regions?.[i] ?? null;
    if (newAuthoring && filter !== "all" && tri?.status !== filter && !inSet) return null;
    return (
                  <li
                    key={i}
                    id={newAuthoring ? `pdf-card-${key}` : undefined}
                    tabIndex={newAuthoring ? -1 : undefined}
                    aria-label={newAuthoring ? `Question ${i + 1}` : undefined}
                    className={`flex items-start justify-between gap-2 rounded border bg-background p-2 ${
                      newAuthoring && activeKey === key ? "border-primary ring-2 ring-primary/40" : "border-border"
                    }`}
                  >
                    <div className={isEditing ? "min-w-0 flex-1" : "min-w-0"}>
                      {tri ? (
                        <div className="mb-1 flex flex-wrap items-center gap-1.5 text-[11px]">
                          <span className="rounded bg-primary px-1.5 py-0.5 font-semibold text-primary-foreground">{i + 1}</span>
                          <span className={`rounded px-1.5 py-0.5 font-medium ${TRIAGE_BADGE[tri.status]}`}>
                            {TRIAGE_LABEL[tri.status]}
                          </span>
                          <button
                            type="button"
                            onClick={() => (region ? showInSource(key) : undefined)}
                            disabled={!region}
                            className="underline disabled:no-underline disabled:text-muted-foreground"
                          >
                            {region ? sourceLinkLabel(region) : `Not found in the ${srcNoun}`}
                          </button>
                        </div>
                      ) : null}
                      <span className={`text-xs text-muted-foreground ${ring("type")}`}>
                        {typeLabel(c)}
                        {candidateNeedsKey(c) ? (
                          <span className="ml-2 rounded bg-warning-foreground/10 px-1.5 py-0.5 text-[11px] text-warning-foreground">
                            Needs answer key
                          </span>
                        ) : null}
                      </span>
                      {/* Beta feedback 2026-10-07: the raw LaTeX source read
                          as a broken import, so the card renders math like the editor. */}
                      {/* FB slice 4: a marker reads as a gap on the card;
                          the posted stem keeps its [[b1]] markers. */}
                      {isEditing ? (
                        <div className={`mt-1 ${ring("stem")}`}>
                          <RichTextField
                            id={`pdf-stem-${key}`}
                            label={`Question ${i + 1}`}
                            placeholder="Type the question"
                            value={c.stem}
                            disabled={disabled || busy}
                            onChange={(stem) =>
                              updateCandidate(i, (x) => ({
                                ...x,
                                stem,
                                // As the editor does: blanks follow the stem's order.
                                ...(x.type === "fill_blank" ? { blanks: orderBlanksByStem(stem, x.blanks ?? []) } : {}),
                              }))
                            }
                            blanks={
                              c.type === "fill_blank"
                                ? {
                                    ids: (c.blanks ?? []).map((b) => b.id),
                                    canInsert: false,
                                    limitTitle: "Add blanks in the editor after Accept",
                                    onInsert: () => "",
                                  }
                                : undefined
                            }
                          />
                        </div>
                      ) : (
                        <RenderedText
                          text={c.type === "fill_blank" ? stemWithGaps(c.stem) : c.stem}
                          className={tri ? `block text-sm ${ring("stem")}` : "block truncate text-sm"}
                        />
                      )}
                      {isEditing && editsChoices(c.type) ? (
                        <fieldset className="mt-2 space-y-1">
                          <legend className="text-xs font-medium">
                            Choices — mark the {keyKind === "multi" ? "correct answers" : "correct answer"}
                          </legend>
                          {(c.choices ?? []).map((ch, ci) => (
                            <div key={ch.id} className={`flex items-start gap-1.5 ${ringChoices.has(ch.id) ? CHECK_RING : ""}`}>
                              <input
                                type={keyKind === "multi" ? "checkbox" : "radio"}
                                name={`pdf-key-${key}`}
                                aria-label={`Choice ${String.fromCharCode(65 + ci)} is correct`}
                                checked={c.correct_choice_ids?.includes(ch.id) ?? false}
                                disabled={disabled || busy}
                                onChange={() => updateCandidate(i, (x) => toggleKey(x, ch.id))}
                                className="mt-2"
                              />
                              <span className="mt-1.5 text-xs text-muted-foreground">{String.fromCharCode(65 + ci)}.</span>
                              <div className="min-w-0 flex-1">
                                <RichTextField
                                  singleLine
                                  label={`Choice ${String.fromCharCode(65 + ci)} text`}
                                  value={ch.text}
                                  disabled={disabled || busy}
                                  onChange={(text) => updateCandidate(i, (x) => setChoiceText(x, ch.id, text))}
                                />
                              </div>
                              <button
                                type="button"
                                onClick={() => updateCandidate(i, (x) => removeChoice(x, ch.id))}
                                disabled={disabled || busy || (c.choices ?? []).length <= 2}
                                title={(c.choices ?? []).length <= 2 ? "A question needs at least two choices" : undefined}
                                className="mt-1 text-[11px] underline disabled:no-underline disabled:opacity-40"
                              >
                                Remove
                              </button>
                            </div>
                          ))}
                          <button
                            type="button"
                            onClick={() => updateCandidate(i, addChoice)}
                            disabled={disabled || busy}
                            className="text-[11px] underline"
                          >
                            Add a choice
                          </button>
                        </fieldset>
                      ) : null}
                      {isEditing && keyKind === "answer" ? (
                        <label className="mt-2 block text-xs">
                          <span className="font-medium">Correct answer</span>
                          <input
                            value={c.correct_answer ?? ""}
                            disabled={disabled || busy}
                            onChange={(e) => updateCandidate(i, (x) => ({ ...x, correct_answer: e.target.value }))}
                            className="mt-1 w-full rounded-md border border-border bg-transparent px-2 py-1 text-sm"
                          />
                          <MathPreview text={c.correct_answer ?? ""} />
                        </label>
                      ) : null}
                      {isEditing && keyKind === null ? (
                        <p className="mt-1 text-[11px] text-muted-foreground">
                          Edit this question&apos;s answer key in the editor after Accept.
                        </p>
                      ) : null}
                      {tri && !isEditing && c.choices && c.choices.length > 0 ? (
                        <ul className="mt-1 space-y-0.5 text-xs">
                          {c.choices.map((ch, ci) => (
                            <li key={ch.id} className={ringChoices.has(ch.id) ? CHECK_RING : ""}>
                              <span className="text-muted-foreground">{String.fromCharCode(65 + ci)}.</span>{" "}
                              <RenderedText text={ch.text} className="inline" />
                              {c.correct_choice_ids?.includes(ch.id) ? (
                                <span className="ml-1 text-[11px] text-muted-foreground">(key)</span>
                              ) : null}
                            </li>
                          ))}
                        </ul>
                      ) : null}
                      {tri && c.columns && ring("columns") ? (
                        <p className={`mt-1 text-xs ${ring("columns")}`}>
                          Columns: {c.columns.map((col) => col.label).join(", ")}
                        </p>
                      ) : null}
                      {tri && tri.reasons.length > 0 ? (
                        <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[11px] text-warning-foreground">
                          {tri.reasons.map((r, ri) => (
                            <li key={ri}>{r.text}</li>
                          ))}
                        </ul>
                      ) : null}
                      {tri ? null : <ChangedFromPdf changes={result?.changes?.[i] ?? []} />}
                      {workTypeOptions(c.type).length > 0 && !added.has(i) ? (
                        <label className="mt-1 block text-xs text-muted-foreground">
                          Add as{" "}
                          <select
                            value={workTypes.get(i) ?? (c.type as WorkType)}
                            disabled={disabled || busy}
                            onChange={(e) =>
                              setWorkTypes((prev) =>
                                new Map(prev).set(i, e.target.value as WorkType),
                              )
                            }
                            className="rounded border border-border bg-background px-1 py-0.5 text-xs"
                          >
                            {workTypeOptions(c.type).map((t) => (
                              <option key={t} value={t}>
                                {WORK_TYPE_LABEL[t]}
                              </option>
                            ))}
                          </select>
                        </label>
                      ) : null}
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      {!inSet ? (
                        <button
                          onClick={() => add(i, c)}
                          disabled={disabled || busy || added.has(i)}
                          className="rounded-md border border-border px-2 py-1 text-xs disabled:opacity-40"
                        >
                          {added.has(i) ? (newAuthoring ? "Accepted" : "Added") : newAuthoring ? "Accept" : "Add"}
                        </button>
                      ) : added.has(i) ? (
                        <span className="text-[11px] text-muted-foreground">{newAuthoring ? "Accepted" : "Added"}</span>
                      ) : null}
                      {newAuthoring && !added.has(i) ? (
                        <button
                          type="button"
                          onClick={() => toggleEditing(i)}
                          disabled={disabled || busy}
                          aria-expanded={isEditing}
                          aria-controls={`pdf-card-${key}`}
                          className="text-[11px] underline"
                        >
                          {isEditing ? "Done editing" : "Edit"}
                        </button>
                      ) : null}
                      {newAuthoring && !inSet && !added.has(i) && aboveFree ? (
                        <button type="button" onClick={() => keepWithPrevious(i)} disabled={disabled || busy} className="text-[11px] underline">
                          {aboveSet && !isProposedPageGroup(aboveSet) ? "Add to the stimulus above" : "Same page as question above"}
                        </button>
                      ) : null}
                      {newAuthoring && !inSet && !added.has(i) && belowSet && !addedSets.has(belowSet.id) ? (
                        <button type="button" onClick={() => joinSetBelow(i)} disabled={disabled || busy} className="text-[11px] underline">
                          {isProposedPageGroup(belowSet) ? "Same page as question below" : "Add to the stimulus below"}
                        </button>
                      ) : null}
                      {newAuthoring && mySet && isProposedPageGroup(mySet) && mySet.item_indexes[0] !== i && !addedSets.has(mySet.id) && !added.has(i) ? (
                        <button type="button" onClick={() => startNewPage(mySet.id, i)} disabled={disabled || busy} className="text-[11px] underline">
                          Start a new page here
                        </button>
                      ) : null}
                      {!inSet && !added.has(i) && !prevInSet ? (
                        <button type="button" onClick={() => startSet(i)} disabled={disabled || busy} className="text-[11px] underline">
                          Add a stimulus
                        </button>
                      ) : null}
                    </div>
                  </li>
    );
  }
}

"use client";
import { needsAnswerKey } from "./readiness";

import { useState } from "react";

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
}

interface ExtractResult {
  page_count: number;
  extracted_chars: number;
  ocr_used: boolean;
  candidates: Candidate[];
  rejected: { index: number; errors: string[] }[];
  rejected_count: number;
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
}

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

function typeLabel(c: Candidate): string {
  if (c.type === "match") return `match · ${c.pairs?.length ?? 0} pairs`;
  if (c.type === "drawing_upload") return "drawing_upload · hand-scored";
  if (c.type === "table") return `table · ${c.columns?.length ?? 0} × ${c.rows?.length ?? 0} cells`;
  return c.type;
}

interface Props {
  assessmentId: string;
  /** E9 slice 2: the sibling drafts are named after this one ("… — Form 2"). */
  assessmentName: string;
  disabled: boolean;
  onImported: () => void;
}

export function PdfImportPanel({ assessmentId, assessmentName, disabled, onImported }: Props) {
  const [open, setOpen] = useState(false);
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

  const keyless = result ? result.candidates.filter((c) => needsAnswerKey(c)).length : 0;
  const needFigure = sets.filter((s) => s.needs_figure && !addedSets.has(s.id)).length;

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
            layout: s.layout ?? "inline",
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
    form.append("file", new File([blob], `figure-${n}.png`, { type: "image/png" }));
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
        const id = await postItem(i, result.candidates[i]!, targetId);
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
        body: JSON.stringify({ item_ids: postedIds, stimulus_text, sources, layout: set.layout }),
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
        if (!(await add(i, result.candidates[i]!))) failed += 1;
      } else {
        try {
          await postItem(i, result.candidates[i]!, targetId);
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

  async function addAll() {
    if (!result) return;
    // Review fix (2026-08-14): each add() clears the error banner, so a
    // mid-list failure used to vanish behind later successes. Tally and
    // report the aggregate instead. E5 slice 3: walk in document order so a
    // set's questions land next to each other. E9: "Form 1 only" leaves the
    // hidden groups out; "One assessment per form" sends form 1 here and
    // every other form to a new draft of its own.
    const visible = result.candidates.map((_, i) => i).filter((i) => !hidden.has(i));
    let failed = await addRange(visible, assessmentId);
    if (formChoice === "split" && formGroups) {
      setBusy(true);
      try {
        for (let k = 1; k < formGroups.length; k++) {
          const draft = await createSiblingDraft(k + 1);
          const group = formGroups[k]!;
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
  function discardFigure(id: string, n: number) {
    updateSet(id, (s) => ({ ...s, figures: s.figures.filter((f) => f !== n) }));
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
        layout: "inline",
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
        <span>Import items from PDF</span>
        <span aria-hidden>{open ? "−" : "+"}</span>
      </button>
      {open ? (
        <div className="space-y-3 border-t border-border p-4">
          <p className="text-xs text-muted-foreground">
            Upload a PDF. Proposed items appear below for review — add the
            ones you want, then edit them in place. Scanned/image PDFs are
            read by AI OCR (up to 30 pages).
          </p>
          <input
            type="file"
            accept="application/pdf,.pdf"
            disabled={disabled || busy}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void extract(f);
            }}
            className="block text-xs"
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

          {result ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>
                  {result.candidates.length} proposed · {result.page_count}{" "}
                  page(s)
                  {result.ocr_used ? " · scanned PDF, read by AI OCR" : ""}
                  {result.rejected_count > 0
                    ? ` · ${result.rejected_count} unparseable skipped`
                    : ""}
                  {result.truncated ? " · list truncated" : ""}
                  {keyless > 0 ? ` · ${keyless} need an answer key` : ""}
                  {result.forms ? ` · ${result.forms.count} forms` : ""}
                </span>
                {result.candidates.length > 0 ? (
                  <button
                    onClick={addAll}
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
                    This PDF looks like {result.forms.count} forms
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
                  This PDF numbers its questions up to {result.numbered_items};{" "}
                  {result.extracted_count} were extracted.
                  {result.missing_numbers && result.missing_numbers.length > 0
                    ? ` Not found: ${result.missing_numbers.join(", ")}.`
                    : ""}{" "}
                  Questions that are only an image or a table in the PDF need to
                  be added by hand.
                </p>
              ) : null}
              {result.figure_count > 0 ? (
                <details className="text-xs text-muted-foreground" open>
                  <summary className="cursor-pointer underline">
                    {result.figure_count} figure{result.figure_count === 1 ? "" : "s"} found in the PDF
                  </summary>
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
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
              {result.rejected.length > 0 ? (
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
                    <li key={set.id} className="rounded border border-primary/40 bg-primary/5 p-2">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                            Stimulus · items {set.item_indexes[0]! + 1}
                            {set.item_indexes.length > 1 ? `–${set.item_indexes[set.item_indexes.length - 1]! + 1}` : ""}
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
                          {setAdded ? "Added" : `Add ${rows.length === 1 ? "with stimulus" : `${rows.length} with stimulus`}`}
                        </button>
                      </div>
                      <ul className="mt-2 space-y-2 border-l-2 border-primary/30 pl-2">{rowsHtml}</ul>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );

  /** One candidate row — on its own in the list, or inside a set card. */
  function renderRow(i: number, c: Candidate) {
    const inSet = sets.some((s) => s.item_indexes.includes(i));
    const prevInSet = i > 0 && sets.some((s) => s.item_indexes.includes(i - 1));
    return (
                  <li
                    key={i}
                    className="flex items-start justify-between gap-2 rounded border border-border bg-background p-2"
                  >
                    <div className="min-w-0">
                      <span className="text-xs text-muted-foreground">
                        {typeLabel(c)}
                        {needsAnswerKey(c) ? (
                          <span className="ml-2 rounded bg-warning-foreground/10 px-1.5 py-0.5 text-[11px] text-warning-foreground">
                            Needs answer key
                          </span>
                        ) : null}
                      </span>
                      <p className="truncate text-sm">{c.stem}</p>
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
                          {added.has(i) ? "Added" : "Add"}
                        </button>
                      ) : added.has(i) ? (
                        <span className="text-[11px] text-muted-foreground">Added</span>
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

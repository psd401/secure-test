"use client";

import { useEffect, useId, useState } from "react";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FilePicker } from "@/components/app/FilePicker";
import {
  Dialog,
  DialogContent,
  DialogTrigger,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { StandardsTagInput } from "@/components/app/StandardsTagInput";
import { RenderedText as Rendered } from "@/components/app/RenderedText";
import { chipLabel, tagScheme } from "@/lib/standards/tags";
import { stemWithGaps } from "@/lib/items/fillBlankEditor";
import {
  describeAddError,
  BATCH_DIFFICULTIES,
  BATCH_DIFFICULTY_LABEL,
  BATCH_FILE_ACCEPT,
  BATCH_MAX_NOTES,
  BATCH_MAX_OBJECTIVE,
  BATCH_TYPES,
  BATCH_TYPE_LABEL,
  addAllSequentially,
  buildBatchFetchInit,
  describeGenerateError,
  emptyBatchForm,
  fillBlankOptionLines,
  keyText,
  matchColumns,
  needsKeyCheck,
  proposalHeader,
  typeCountSum,
  validateBatchForm,
  type BatchDifficulty,
  type BatchFormValues,
  type BatchProposal,
} from "@/lib/ai/batchForm";

// BG slice 4 (docs/batch-item-generation-design.md D-3…D-7): "Generate
// questions" on the Questions tab. The form posts to POST
// /api/ai/generate-items, which WRITES NOTHING; the proposals come back here
// and each Add posts through the ordinary items route (same body the PDF
// import's Add sends), carrying the batch's standards tags (D-5). The PDF
// import's cards are one-line previews with no edit, so this builds its own
// card (full stem, choices, key, tags, "Check the key" — D-6) and, like
// them, has no inline edit before Add: the teacher edits the saved question.

interface Card {
  id: string;
  proposal: BatchProposal;
}

type LookupEntry = { code: string; text: string } | null;

let cardSeq = 0;

export function GenerateQuestionsDialog({
  assessmentId,
  usedStandards,
  disabled,
  canOpen = true,
  onAdded,
}: {
  assessmentId: string;
  /** Tags already on the assessment — the picker offers them first. */
  usedStandards: string[];
  disabled?: boolean;
  /**
   * G-1: false while the assessment is locked. Only the trigger hides — an
   * open dialog stays mounted, so an Add all stopped by a Publish from another
   * tab still shows "Added N of M, then stopped" and the unadded cards.
   */
  canOpen?: boolean;
  /** Called after any Add so the editor's question list refreshes. */
  onAdded: () => void | Promise<void>;
}) {
  const uid = useId();
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<BatchFormValues>(emptyBatchForm);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cards, setCards] = useState<Card[] | null>(null);
  const [dropped, setDropped] = useState(0);
  const [reviewed, setReviewed] = useState<ReadonlySet<string>>(new Set());
  const [adding, setAdding] = useState<string | null>(null); // card id, or "all"
  const [entries, setEntries] = useState<Record<string, LookupEntry>>({});
  const [fileKey, setFileKey] = useState(0);

  const errors = validateBatchForm(values);
  const canGenerate = Object.keys(errors).length === 0;
  const locked = busy || adding !== null;

  // Chip text for the proposals' catalog tags: one lookup per set of tags.
  const wantedTags = cards
    ? [...new Set(cards.flatMap((c) => c.proposal.standards ?? []))].filter(
        (t) => tagScheme(t) !== null && !(t in entries),
      )
    : [];
  const wantedKey = wantedTags.join(",");
  useEffect(() => {
    if (!wantedKey) return;
    const tags = wantedKey.split(",").slice(0, 20);
    let cancelled = false;
    void fetch(`/api/standards/lookup?tags=${encodeURIComponent(tags.join(","))}`)
      .then((r) => (r.ok ? (r.json() as Promise<{ entries: Record<string, LookupEntry> }>) : null))
      .then((b) => {
        if (cancelled) return;
        setEntries((prev) => {
          const next = { ...prev };
          for (const t of tags) next[t] = b?.entries[t] ?? null;
          return next;
        });
      })
      .catch(() => {
        if (cancelled) return;
        setEntries((prev) => {
          const next = { ...prev };
          for (const t of tags) next[t] = null;
          return next;
        });
      });
    return () => {
      cancelled = true;
    };
  }, [wantedKey]);

  function patch(p: Partial<BatchFormValues>) {
    setValues((v) => ({ ...v, ...p }));
  }

  async function generate() {
    if (!canGenerate || locked) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/ai/generate-items", buildBatchFetchInit(assessmentId, values));
      const body = (await res.json().catch(() => null)) as {
        ok?: boolean;
        proposals?: BatchProposal[];
        dropped?: number;
        error?: string;
        detail?: string;
        hint?: string;
        note?: string;
      } | null;
      if (!res.ok || !body?.ok || !body.proposals) {
        setError(describeGenerateError(res.status, body));
        return;
      }
      setCards(body.proposals.map((proposal) => ({ id: `gq${++cardSeq}`, proposal })));
      setDropped(body.dropped ?? 0);
      setReviewed(new Set());
    } catch {
      setError(describeGenerateError(0, null));
    } finally {
      setBusy(false);
    }
  }

  async function postCard(card: Card): Promise<void> {
    const res = await fetch(`/api/assessments/${assessmentId}/items`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(card.proposal),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => null)) as { detail?: string; error?: string } | null;
      throw new Error(describeAddError(res.status, err));
    }
  }

  function dropCards(ids: readonly string[]) {
    const gone = new Set(ids);
    setCards((prev) => (prev ? prev.filter((c) => !gone.has(c.id)) : prev));
  }

  async function addOne(card: Card) {
    setAdding(card.id);
    setError(null);
    try {
      await postCard(card);
      dropCards([card.id]);
      await onAdded();
    } catch (e) {
      setError(`Could not add that question: ${(e as Error).message}`);
    } finally {
      setAdding(null);
    }
  }

  async function addAll() {
    if (!cards || cards.length === 0) return;
    setAdding("all");
    setError(null);
    const byId = new Map(cards.map((c) => [c.id, c]));
    const result = await addAllSequentially(
      cards.map((c) => c.id),
      (id) => postCard(byId.get(id)!),
    );
    dropCards(result.added);
    if (!result.ok) {
      setError(
        `Added ${result.added.length} of ${cards.length}, then stopped: ${result.message}`,
      );
    }
    if (result.added.length > 0) await onAdded();
    setAdding(null);
  }

  function discard(id: string) {
    dropCards([id]);
  }

  function discardAll() {
    setCards(null);
    setDropped(0);
    setError(null);
  }

  function generateAgain() {
    // Back to the form with the previous values kept.
    setCards(null);
    setDropped(0);
    setError(null);
  }

  function markReviewed(id: string) {
    setReviewed((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
  }

  const inList = cards !== null && cards.length > 0;
  // All proposals added or discarded: leave the empty list for the form.
  const showForm = cards === null || cards.length === 0;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (locked) return; // never close mid-generation or mid-Add
        setOpen(o);
      }}
    >
      {/* G-3: a DialogTrigger, so Radix returns focus to it on close. */}
      {canOpen ? (
        <DialogTrigger asChild>
          <Button type="button" variant="outline" size="sm" disabled={disabled}>
            <Sparkles aria-hidden />
            Generate questions
          </Button>
        </DialogTrigger>
      ) : null}
      <DialogContent
        className="max-h-[calc(100vh-2rem)] overflow-x-hidden overflow-y-auto sm:max-w-2xl"
        // Escape in the standards picker with its list open closes the list,
        // not the dialog: Radix listens on the document in the capture phase,
        // so the picker's own handler cannot stop it first.
        onEscapeKeyDown={(e) => {
          const el = document.activeElement;
          if (el?.getAttribute("role") === "combobox" && el.getAttribute("aria-expanded") === "true") {
            e.preventDefault();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>Generate questions</DialogTitle>
          <DialogDescription>
            The AI drafts questions from your standards, objective or source material.
            Nothing is saved until you add it, and you should check each answer key.
          </DialogDescription>
        </DialogHeader>

        {showForm ? (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              void generate();
            }}
            aria-busy={busy}
          >
            <fieldset disabled={busy} className="space-y-4 border-0 p-0">
              <div className="space-y-1">
                <label htmlFor={`${uid}-count`} className="block text-sm font-medium">
                  How many questions
                </label>
                <input
                  id={`${uid}-count`}
                  type="number"
                  min={1}
                  max={10}
                  inputMode="numeric"
                  value={values.count}
                  onChange={(e) => patch({ count: e.target.value })}
                  aria-invalid={errors.count ? true : undefined}
                  aria-describedby={errors.count ? `${uid}-count-err` : undefined}
                  className="w-24 rounded-md border border-border bg-transparent px-2 py-1 text-sm"
                />
                {errors.count ? (
                  <p id={`${uid}-count-err`} className="text-xs text-destructive">
                    {errors.count}
                  </p>
                ) : null}
              </div>

              <fieldset className="space-y-2 border-0 p-0">
                <legend className="text-sm font-medium">Question types</legend>
                <div className="flex flex-wrap gap-4 text-sm">
                  <label className="flex items-center gap-1.5">
                    <input
                      type="radio"
                      name={`${uid}-types`}
                      checked={values.typeMode === "mix"}
                      onChange={() => patch({ typeMode: "mix" })}
                    />
                    Mix
                  </label>
                  <label className="flex items-center gap-1.5">
                    <input
                      type="radio"
                      name={`${uid}-types`}
                      checked={values.typeMode === "counts"}
                      onChange={() => patch({ typeMode: "counts" })}
                    />
                    Choose how many of each
                  </label>
                </div>
                {values.typeMode === "counts" ? (
                  <div className="grid gap-2 sm:grid-cols-2">
                    {BATCH_TYPES.map((t) => (
                      <label key={t} className="flex items-center justify-between gap-2 text-sm">
                        <span>{BATCH_TYPE_LABEL[t]}</span>
                        <input
                          type="number"
                          min={0}
                          max={10}
                          inputMode="numeric"
                          value={values.typeCounts[t]}
                          placeholder="0"
                          onChange={(e) =>
                            patch({ typeCounts: { ...values.typeCounts, [t]: e.target.value } })
                          }
                          className="w-16 rounded-md border border-border bg-transparent px-2 py-1 text-sm"
                        />
                      </label>
                    ))}
                  </div>
                ) : null}
                {values.typeMode === "counts" ? (
                  <p className="text-xs text-muted-foreground">
                    Total: {typeCountSum(values)}
                  </p>
                ) : (
                  // BG slice 6 / FB slice 4: the route's "mix" never writes
                  // match or fill-in-the-blank items.
                  <p className="text-xs text-muted-foreground">
                    Mix uses multiple choice, short text and essay. For matching or fill in the
                    blank, choose how many of each.
                  </p>
                )}
                <p
                  role="status"
                  aria-live="polite"
                  className="min-h-4 text-xs text-destructive"
                >
                  {errors.types ?? ""}
                </p>
              </fieldset>

              <StandardsTagInput
                value={values.standards}
                onChange={(standards) => patch({ standards })}
                suggestions={usedStandards}
                disabled={busy}
              />

              <div className="space-y-1">
                <label htmlFor={`${uid}-objective`} className="block text-sm font-medium">
                  Objective <span className="font-normal text-muted-foreground">(optional)</span>
                </label>
                <input
                  id={`${uid}-objective`}
                  value={values.objective}
                  maxLength={BATCH_MAX_OBJECTIVE}
                  onChange={(e) => patch({ objective: e.target.value })}
                  placeholder="e.g. Students compare ratios in a table"
                  className="w-full rounded-md border border-border bg-transparent px-3 py-1.5 text-sm"
                />
              </div>

              <div className="space-y-2">
                <div className="text-sm font-medium">
                  Source material <span className="font-normal text-muted-foreground">(optional)</span>
                </div>
                <label className="block text-xs text-muted-foreground" htmlFor={`${uid}-file`}>
                  A PDF, Word (.docx), Markdown or text file, up to 5 MB — the questions are
                  drawn from it.
                </label>
                <FilePicker
                  key={fileKey}
                  id={`${uid}-file`}
                  accept={BATCH_FILE_ACCEPT}
                  onFile={(f) => patch({ file: f })}
                  aria-describedby={errors.file ? `${uid}-file-err` : undefined}
                />
                {values.file ? (
                  <button
                    type="button"
                    className="text-xs underline"
                    onClick={() => {
                      patch({ file: null });
                      setFileKey((k) => k + 1);
                    }}
                  >
                    Remove {values.file.name}
                  </button>
                ) : null}
                <Textarea
                  value={values.resourceText}
                  onChange={(e) => patch({ resourceText: e.target.value })}
                  rows={4}
                  placeholder="Or paste the text here"
                  aria-label="Paste source material"
                />
                <p role="status" aria-live="polite" className="min-h-4 text-xs text-destructive">
                  {errors.resource ?? ""}
                </p>
                {errors.file ? (
                  <p id={`${uid}-file-err`} className="text-xs text-destructive">
                    {errors.file}
                  </p>
                ) : null}
              </div>

              <div className="space-y-1">
                <label htmlFor={`${uid}-difficulty`} className="block text-sm font-medium">
                  Difficulty
                </label>
                <NativeSelect
                  id={`${uid}-difficulty`}
                  size="sm"
                  value={values.difficulty}
                  onChange={(e) => patch({ difficulty: e.target.value as BatchDifficulty })}
                >
                  {BATCH_DIFFICULTIES.map((d) => (
                    <NativeSelectOption key={d} value={d}>
                      {BATCH_DIFFICULTY_LABEL[d]}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </div>

              <div className="space-y-1">
                <label htmlFor={`${uid}-notes`} className="block text-sm font-medium">
                  Notes <span className="font-normal text-muted-foreground">(optional)</span>
                </label>
                <Textarea
                  id={`${uid}-notes`}
                  value={values.notes}
                  maxLength={BATCH_MAX_NOTES}
                  onChange={(e) => patch({ notes: e.target.value })}
                  rows={3}
                  placeholder="Anything else the AI should know"
                />
              </div>
            </fieldset>

            <p role="status" aria-live="polite" className="min-h-4 text-xs text-muted-foreground">
              {!canGenerate && errors.focus && !errors.count && !errors.types ? errors.focus : ""}
            </p>

            {busy ? (
              <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
                <span
                  aria-hidden
                  className="inline-block size-4 animate-spin rounded-full border-2 border-border border-t-foreground"
                />
                Generating questions…
              </p>
            ) : null}
            {error ? (
              <p role="alert" className="rounded border border-destructive/40 p-2 text-sm text-destructive">
                {error}
              </p>
            ) : null}

            <DialogFooter>
              <Button type="button" variant="outline" disabled={busy} onClick={() => setOpen(false)}>
                Close
              </Button>
              <Button type="submit" disabled={!canGenerate || busy}>
                {busy ? "Generating…" : "Generate"}
              </Button>
            </DialogFooter>
          </form>
        ) : null}

        {inList && cards ? (
          <div className="space-y-3">
            <p className="text-sm font-medium" role="status" aria-live="polite">
              {proposalHeader(cards.length, dropped)}
            </p>
            {error ? (
              <p role="alert" className="rounded border border-destructive/40 p-2 text-sm text-destructive">
                {error}
              </p>
            ) : null}
            <ul className="space-y-2">
              {cards.map((c) => (
                <ProposalCard
                  key={c.id}
                  card={c}
                  entries={entries}
                  checkKey={needsKeyCheck(c.proposal, reviewed, c.id)}
                  busy={adding !== null}
                  adding={adding === c.id}
                  onKeyOpened={() => markReviewed(c.id)}
                  onAdd={() => void addOne(c)}
                  onDiscard={() => discard(c.id)}
                />
              ))}
            </ul>
            <DialogFooter className="sm:justify-between">
              <Button type="button" variant="outline" disabled={adding !== null} onClick={generateAgain}>
                Generate again
              </Button>
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="outline" disabled={adding !== null} onClick={discardAll}>
                  Discard all
                </Button>
                <Button type="button" disabled={adding !== null} onClick={() => void addAll()}>
                  {adding === "all" ? "Adding…" : `Add all (${cards.length})`}
                </Button>
              </div>
            </DialogFooter>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function ProposalCard({
  card,
  entries,
  checkKey,
  busy,
  adding,
  onKeyOpened,
  onAdd,
  onDiscard,
}: {
  card: Card;
  entries: Record<string, LookupEntry>;
  checkKey: boolean;
  busy: boolean;
  adding: boolean;
  onKeyOpened: () => void;
  onAdd: () => void;
  onDiscard: () => void;
}) {
  const p = card.proposal;
  const tags = p.standards ?? [];
  const key = keyText(p);
  const correct = new Set(p.correct_choice_ids ?? []);
  return (
    <li className="space-y-2 rounded border border-border bg-background p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>{typeLabel(p.type)}</span>
            {checkKey ? (
              <span className="rounded bg-warning-foreground/10 px-1.5 py-0.5 text-[11px] text-warning-foreground">
                Check the key
              </span>
            ) : null}
          </div>
          {/* FB slice 4: a marker reads as a numbered gap; the key lines
              ("Blank n: …") use the same numbers. Add posts the markers. */}
          <Rendered
            text={p.type === "fill_blank" ? stemWithGaps(p.stem, { numbered: true }) : p.stem}
            className="block whitespace-pre-line text-sm"
          />
          {p.choices && p.choices.length > 0 ? (
            <ul className="space-y-0.5 text-sm">
              {p.choices.map((ch) => (
                <li key={ch.id} className="text-muted-foreground">
                  <Rendered text={ch.text} />
                  {/* The mark appears only once the key is opened, so the
                      "Check the key" badge means the teacher has not seen it. */}
                  {!checkKey && correct.has(ch.id) ? (
                    <span className="ml-2 text-xs font-medium text-foreground">(correct)</span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
          {p.type === "match" && p.pairs ? <MatchColumns proposal={p} /> : null}
          {p.type === "fill_blank" ? <FillBlankOptions proposal={p} /> : null}
          {tags.length > 0 ? (
            <ul className="flex flex-wrap gap-1.5" aria-label="Standards on this question">
              {tags.map((tag) => {
                const label = chipLabel(tag, tagScheme(tag) !== null ? entries[tag] : null);
                return (
                  <li
                    key={tag}
                    title={label.title}
                    className="inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-muted px-2 py-0.5 text-xs"
                  >
                    <span className="font-medium">{label.code}</span>
                    {label.text ? (
                      <span className="truncate text-muted-foreground">{label.text}</span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : null}
          {key.length > 0 ? (
            <details
              className="text-sm"
              onToggle={(e) => {
                if ((e.currentTarget as HTMLDetailsElement).open) onKeyOpened();
              }}
            >
              <summary className="cursor-pointer text-xs underline">Show the key</summary>
              {p.type === "match" && p.pairs ? (
                // BG slice 6: the pairing is the key — aligned only in here.
                <table className="mt-1 text-sm">
                  <tbody>
                    {p.pairs.map((pair) => (
                      <tr key={pair.id}>
                        <td className="py-0.5 pr-2 align-top">
                          <Rendered text={pair.left} />
                        </td>
                        <td aria-hidden className="py-0.5 pr-2 align-top text-muted-foreground">
                          →
                        </td>
                        <td className="py-0.5 align-top">
                          <Rendered text={pair.right} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <ul className="mt-1 list-disc pl-5">
                  {key.map((k, i) => (
                    <li key={i}>
                      <Rendered text={k} />
                    </li>
                  ))}
                </ul>
              )}
            </details>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <Button type="button" size="sm" variant="outline" disabled={busy} onClick={onAdd}>
            {adding ? "Adding…" : "Add"}
          </Button>
          <button
            type="button"
            className="text-[11px] underline disabled:opacity-40"
            disabled={busy}
            onClick={onDiscard}
          >
            Discard
          </button>
        </div>
      </div>
    </li>
  );
}

// BG slice 6: a match card's body shows the two columns apart (rights sorted,
// since their stored order is the key); the aligned pairs are in "Show the key".
export function MatchColumns({ proposal }: { proposal: BatchProposal }) {
  const { lefts, rights } = matchColumns(proposal);
  return (
    <div className="grid grid-cols-2 gap-3 text-sm text-muted-foreground">
      <ul aria-label="Left column" className="space-y-0.5">
        {lefts.map((text, i) => (
          <li key={i}>
            <Rendered text={text} />
          </li>
        ))}
      </ul>
      <ul aria-label="Right column (sorted)" className="space-y-0.5">
        {rights.map((text, i) => (
          <li key={i}>
            <Rendered text={text} />
          </li>
        ))}
      </ul>
    </div>
  );
}

// FB slice 4: each dropdown blank's options in the teacher's order (D-6),
// before the key — like a multiple-choice card's choices, with the correct one
// only under "Show the key".
export function FillBlankOptions({ proposal }: { proposal: BatchProposal }) {
  const lines = fillBlankOptionLines(proposal);
  if (lines.length === 0) return null;
  return (
    <ul aria-label="Options for each blank" className="space-y-0.5 text-sm text-muted-foreground">
      {lines.map((line) => (
        <li key={line.label}>
          <span className="text-xs font-medium text-foreground">{line.label}:</span>{" "}
          {line.options.map((text, i) => (
            <span key={i}>
              {i > 0 ? " · " : null}
              <Rendered text={text} />
            </span>
          ))}
        </li>
      ))}
    </ul>
  );
}

function typeLabel(type: string): string {
  return (BATCH_TYPE_LABEL as Record<string, string>)[type] ?? type;
}


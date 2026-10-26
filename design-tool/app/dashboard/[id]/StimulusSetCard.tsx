"use client";

import type { Dispatch, SetStateAction } from "react";
import { ArrowDown, ArrowUp, ListPlus, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { StatusLine, type SaveState } from "@/components/app/StatusLine";
import { MathPreview } from "./MathPreview";
import { ImagePicker } from "./ImagePicker";
import { MathTranslator } from "./MathTranslator";
import { EmphasisButtons } from "./EmphasisButtons";
import { SourcePicker, type SourceSummary } from "./SourcePicker";
import type { AssessmentView, StimulusSourceView, ItemSetView } from "./editorModel";

/** Phase 4 slice D: the stimulus card that opens a set's block in the
 * question list, moved unchanged out of AssessmentEditor.tsx. Every value
 * and handler is the editor's own. */
export interface StimulusSetCardProps {
  assessment: AssessmentView;
  set: ItemSetView;
  bounds: { first: number; last: number };
  setDirty: boolean;
  setState: SaveState | null;
  isLocked: boolean;
  isPending: boolean;
  updateSet: (setId: string, mut: (s: ItemSetView) => ItemSetView) => void;
  saveStimulus: (setId: string) => Promise<void>;
  removeStimulus: (setId: string) => Promise<void>;
  addSource: (setId: string) => void;
  updateSource: (setId: string, index: number, mut: (s: StimulusSourceView) => StimulusSourceView) => void;
  moveSource: (setId: string, index: number, delta: -1 | 1) => void;
  removeSource: (setId: string, index: number) => void;
  sourcePickerFor: string | null;
  setSourcePickerFor: Dispatch<SetStateAction<string | null>>;
  setSource: (setId: string, source: SourceSummary | null) => Promise<void>;
  setError: Dispatch<SetStateAction<string | null>>;
  describe: (e: unknown) => string;
}

export function StimulusSetCard(props: StimulusSetCardProps) {
  const {
    assessment,
    set,
    bounds,
    setDirty,
    setState,
    isLocked,
    isPending,
    updateSet,
    saveStimulus,
    removeStimulus,
    addSource,
    updateSource,
    moveSource,
    removeSource,
    sourcePickerFor,
    setSourcePickerFor,
    setSource,
    setError,
    describe,
  } = props;
  return (
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
  );
}

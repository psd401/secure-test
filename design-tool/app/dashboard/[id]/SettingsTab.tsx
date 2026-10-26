"use client";

import type { Dispatch, SetStateAction } from "react";
import { Button } from "@/components/ui/button";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { InstantFeedbackSettings } from "@/components/app/InstantFeedbackSettings";
import { plural } from "@/lib/ui/format";
import { StatusLine, type SaveState } from "@/components/app/StatusLine";
import { PRODUCT_NAME } from "@/lib/brand";
import { DuplicateAssessmentButton } from "../DuplicateAssessmentButton";
import type { ItemView, AssessmentView } from "./editorModel";

/** Phase 4 slice D: the Settings tab's panel, moved unchanged out of
 * AssessmentEditor.tsx. Every value and handler is the editor's own. */
export interface SettingsTabProps {
  assessment: AssessmentView;
  items: ItemView[];
  name: string;
  setName: Dispatch<SetStateAction<string>>;
  description: string;
  setDescription: Dispatch<SetStateAction<string>>;
  timeLimitMinutes: string;
  setTimeLimitMinutes: Dispatch<SetStateAction<string>>;
  allowLlm: boolean;
  setAllowLlm: Dispatch<SetStateAction<boolean>>;
  studentLayout: "scroll" | "paged";
  setStudentLayout: Dispatch<SetStateAction<"scroll" | "paged">>;
  calculatorMode: AssessmentView["calculator_mode"];
  setCalculatorMode: Dispatch<SetStateAction<AssessmentView["calculator_mode"]>>;
  calculatorPreset: AssessmentView["calculator_preset"];
  setCalculatorPreset: Dispatch<SetStateAction<AssessmentView["calculator_preset"]>>;
  settingsSave: SaveState;
  saveMetadata: () => Promise<void>;
  allowHighlighting: boolean;
  highlightSave: SaveState;
  saveHighlighting: (next: boolean) => Promise<void>;
  isLocked: boolean;
  isOwner: boolean;
  isPending: boolean;
  refresh: () => void;
  archivedAt: string | null;
  archiveBusy: boolean;
  archiveError: string | null;
  toggleArchive: () => Promise<void>;
  setDeleteDraftOpen: Dispatch<SetStateAction<boolean>>;
  setDeleteDraftError: Dispatch<SetStateAction<string | null>>;
}

export function SettingsTab(props: SettingsTabProps) {
  const {
    assessment,
    items,
    name,
    setName,
    description,
    setDescription,
    timeLimitMinutes,
    setTimeLimitMinutes,
    allowLlm,
    setAllowLlm,
    studentLayout,
    setStudentLayout,
    calculatorMode,
    setCalculatorMode,
    calculatorPreset,
    setCalculatorPreset,
    settingsSave,
    saveMetadata,
    allowHighlighting,
    highlightSave,
    saveHighlighting,
    isLocked,
    isOwner,
    isPending,
    refresh,
    archivedAt,
    archiveBusy,
    archiveError,
    toggleArchive,
    setDeleteDraftOpen,
    setDeleteDraftError,
  } = props;
  return (
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
      {/* Graphing calculator (docs/graphing-calculator-design.md D-7):
          every student gets it; part of what the test measures, so it is
          saved with the settings above and locked once Published. */}
      <label className="block">
        <span className="block text-sm font-medium">Calculator</span>
        <NativeSelect
          size="sm"
          value={calculatorMode}
          onChange={(e) => setCalculatorMode(e.target.value as AssessmentView["calculator_mode"])}
          disabled={isLocked}
          className="mt-1"
        >
          <NativeSelectOption value="none">No calculator</NativeSelectOption>
          <NativeSelectOption value="four_function">Four-function</NativeSelectOption>
          <NativeSelectOption value="scientific">Scientific</NativeSelectOption>
          <NativeSelectOption value="graphing">Graphing</NativeSelectOption>
        </NativeSelect>
        <span className="block text-xs text-muted-foreground">
          Every student gets this calculator during the test. Needs {PRODUCT_NAME} 2.0 or later;
          an older version is asked to update before the test opens.
        </span>
      </label>
      {calculatorMode !== "none" ? (
        <label className="block">
          <span className="block text-sm font-medium">Calculator setup</span>
          <NativeSelect
            size="sm"
            value={calculatorPreset}
            onChange={(e) => setCalculatorPreset(e.target.value as AssessmentView["calculator_preset"])}
            disabled={isLocked}
            className="mt-1"
          >
            <NativeSelectOption value="full">Everything on</NativeSelectOption>
            <NativeSelectOption value="state_wa">Like the Washington state test</NativeSelectOption>
          </NativeSelect>
          <span className="block text-xs text-muted-foreground">
            &ldquo;Like the Washington state test&rdquo; starts in degrees and turns off what the
            state test&rsquo;s calculator leaves out.
          </span>
        </label>
      ) : null}
      {calculatorMode !== "none" &&
      studentLayout === "scroll" &&
      items.some((i) => i.no_calculator === true) ? (
        <p className="text-xs text-amber-800" role="note">
          Some questions are marked &ldquo;No calculator on this question&rdquo;. That only takes effect
          when students see one question at a time.
        </p>
      ) : null}
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

      {/* Passage highlighting (docs/passage-highlighting-design.md): NOT
          gated by isLocked — it saves itself, and the server lets it
          through the publish lock alongside the feedback settings. */}
      <div className="border-t border-border pt-4">
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            checked={allowHighlighting}
            onChange={(e) => void saveHighlighting(e.target.checked)}
            disabled={highlightSave.kind === "saving"}
            className="mt-1"
          />
          <span className="text-sm">
            Let students highlight passages
            <span className="block text-xs text-muted-foreground">
              Students can mark text in passages and sources. Highlights are not saved and are
              not shown to you. Needs {PRODUCT_NAME} 2.0 or later.
            </span>
          </span>
        </label>
        <div className="mt-2 flex items-center gap-3">
          <StatusLine state={highlightSave} />
        </div>
      </div>

      {/* Instant feedback (docs/instant-feedback-design.md): NOT gated by
          isLocked — it saves itself, at once, and the server lets exactly
          these two settings through the publish lock. */}
      <InstantFeedbackSettings
        assessmentId={assessment.id}
        initialLevel={assessment.student_feedback}
        initialRelease={assessment.answers_release}
        initialReleasedAt={assessment.answers_released_at}
        onSaved={refresh}
      />

      {/* Access slice 3: Duplicate, Archive and Delete draft are all
          `own`-level routes (docs/access-model-design.md) — a co-teacher's
          `edit` grant does not reach them, so the three blocks below are
          the owner's alone. Publish / Unpublish stays unconditional above:
          that PATCH is `edit`, which a co-teacher does have. */}
      {isOwner ? (
        <>
          {/* Duplicate (2026-09-16): beside the backup download in spirit — the
              other "take a copy of this" action — but in the Settings tab's
              bordered-block pattern. NOT gated by isLocked or by archived_at:
              the copy is a fresh Draft, so nothing the publish lock protects is
              touched. */}
          <div className="border-t border-border pt-4">
            <DuplicateAssessmentButton id={assessment.id} size="default" align="start" />
            <p className="mt-1 text-xs text-muted-foreground">
              Makes a Draft copy named “{assessment.name} (copy)” with the same questions,
              sources, accommodations and settings. Results and test sessions are not copied.
            </p>
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
        </>
      ) : null}
    </section>
  );
}

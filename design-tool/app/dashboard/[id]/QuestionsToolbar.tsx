"use client";

import type { Dispatch, SetStateAction } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { PreviewFrame } from "@/components/app/PreviewFrame";
import { MathPreview } from "./MathPreview";
import { ImportItemsPanel } from "./ImportItemsPanel";
import { PdfImportPanel } from "./PdfImportPanel";
import type { ItemType } from "@/db/schema";
import { GenerateQuestionsDialog } from "@/components/app/GenerateQuestionsDialog";
import { SuggestStandardsDialog, type SuggestOutcome } from "@/components/app/SuggestStandardsDialog";
import { suggestionCount, type SuggestionMap } from "@/lib/ai/suggestForm";
import {
  type ItemView,
  type AssessmentView,
  type AiProposal,
  TYPE_LABEL,
  AI_GENERABLE_TYPES,
} from "./editorModel";

/** Phase 4 slice D: the top of the Questions tab (heading, preview, import
 * panels, add/AI toolbar, the AI proposal panel), moved unchanged out of
 * AssessmentEditor.tsx. Every value and handler is the editor's own. */
export interface QuestionsToolbarProps {
  assessment: AssessmentView;
  items: ItemView[];
  persistedSets: Record<string, string>;
  isLocked: boolean;
  isPending: boolean;
  newAuthoring: boolean;
  previewOpen: boolean;
  setPreviewOpen: Dispatch<SetStateAction<boolean>>;
  reloadFromServer: () => Promise<void>;
  addType: ItemType;
  setAddType: Dispatch<SetStateAction<ItemType>>;
  adding: boolean;
  addItem: () => Promise<void>;
  usedStandards: string[];
  suggestions: SuggestionMap;
  onSuggested: (outcome: SuggestOutcome) => void;
  suggestionNote: string | null;
  setSuggestionNote: Dispatch<SetStateAction<string | null>>;
  aiPanelOpen: boolean;
  setAiPanelOpen: Dispatch<SetStateAction<boolean>>;
  aiPrompt: string;
  setAiPrompt: Dispatch<SetStateAction<string>>;
  aiType: ItemType;
  setAiType: Dispatch<SetStateAction<ItemType>>;
  aiBusy: boolean;
  generateWithAi: () => Promise<void>;
  proposal: AiProposal | null;
  updateProposal: (mut: (p: AiProposal) => AiProposal) => void;
  saveProposal: () => Promise<void>;
  discardProposal: () => void;
}

export function QuestionsToolbar(props: QuestionsToolbarProps) {
  const {
    assessment,
    items,
    persistedSets,
    isLocked,
    isPending,
    newAuthoring,
    previewOpen,
    setPreviewOpen,
    reloadFromServer,
    addType,
    setAddType,
    adding,
    addItem,
    usedStandards,
    suggestions,
    onSuggested,
    suggestionNote,
    setSuggestionNote,
    aiPanelOpen,
    setAiPanelOpen,
    aiPrompt,
    setAiPrompt,
    aiType,
    setAiType,
    aiBusy,
    generateWithAi,
    proposal,
    updateProposal,
    saveProposal,
    discardProposal,
  } = props;
  return (
    <>
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

      {/* Phase 5 slice B: with the R-12 flag on, the button opens the
          interactive side-by-side preview instead (AssessmentEditor). */}
      {previewOpen && !newAuthoring ? (
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
        newAuthoring={newAuthoring}
      />

      <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-card px-4 py-3 empty:hidden">
        {/* R-6: the new editor adds questions where they go, with the "+"
            between questions and "Add question" at the end of the list. */}
        {newAuthoring ? null : (
        <>
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
          {(Object.keys(TYPE_LABEL) as ItemType[])
            .map((t) => (
              <NativeSelectOption key={t} value={t}>
                {TYPE_LABEL[t]}
              </NativeSelectOption>
            ))}
        </NativeSelect>
        <Button type="button" size="sm" onClick={addItem} disabled={isPending || isLocked || adding}>
          <Plus aria-hidden />
          {adding ? "Adding…" : "Add question"}
        </Button>
        </>
        )}
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
        {assessment.allow_llm_authoring ? (
          <GenerateQuestionsDialog
            assessmentId={assessment.id}
            usedStandards={usedStandards}
            canOpen={!isLocked}
            onAdded={reloadFromServer}
          />
        ) : null}
        {/* BG slice 5: NOT gated by isLocked — tags stay editable while Published (14.1). */}
        {assessment.allow_llm_authoring ? (
          <SuggestStandardsDialog
            assessmentId={assessment.id}
            disabled={items.length === 0}
            onSuggested={onSuggested}
          />
        ) : null}
      </div>
      {suggestionNote ? (
        <p role="status" className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          {suggestionNote}
          {suggestionCount(suggestions) > 0 ? ` ${suggestionCount(suggestions)} suggestion${suggestionCount(suggestions) === 1 ? "" : "s"} left.` : ""}
          <Button type="button" variant="ghost" size="sm" onClick={() => setSuggestionNote(null)}>
            Hide
          </Button>
        </p>
      ) : null}

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
    </>
  );
}

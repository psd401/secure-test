"use client";

import { assessmentAssetUrl } from "@/lib/assets/assessmentAssetUrl";
import { ArrowDown, ArrowUp, GripVertical, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MathPreview } from "./MathPreview";
import { DEFAULT_GRAPH_BOARD, GraphItemEditor } from "./GraphItemEditor";
import { ImagePicker } from "./ImagePicker";
import { MathTranslator } from "./MathTranslator";
import { EmphasisButtons } from "./EmphasisButtons";
import { RichTextField } from "./RichTextField";
import { RubricEditor } from "./RubricEditor";
import { nextChoiceId } from "@/lib/items/choiceIds";
import { ASSET_REF_ONE_RE } from "@/lib/items/extractAssetRefs";
import { usesRichTextField } from "@/lib/authoring/richTextTypes";
import { choiceLetter } from "@/lib/authoring/outline";
import { MoveAnnouncer, SortableRows, type DragBits } from "./SortableRows";
import { MatchPairsEditor } from "./MatchPairsEditor";
import { SequenceEditor } from "./SequenceEditor";
import { HotspotEditor } from "./HotspotEditor";
import { TableEditor } from "./TableEditor";
import { FillBlankEditor } from "./FillBlankEditor";
import type { Choice, ItemView, AssessmentView } from "./editorModel";

/** Phase 4 slice D: a question card's per-type editor (pairs, steps,
 * rubric, hotspots, table, graph, blanks, short answer, drawing, choices),
 * moved unchanged out of AssessmentEditor.tsx. Every value and handler is
 * the editor's own. */
export interface ItemTypeFieldsProps {
  assessment: AssessmentView;
  item: ItemView;
  isLocked: boolean;
  newAuthoring: boolean;
  updateItem: (itemId: string, mut: (item: ItemView) => ItemView) => void;
  choiceMessage: string;
  moveChoice: (itemId: string, from: number, to: number) => void;
}

export function ItemTypeFields(props: ItemTypeFieldsProps) {
  const {
    assessment,
    item,
    isLocked,
    newAuthoring,
    updateItem,
    choiceMessage,
    moveChoice,
  } = props;
  return (
    <>
      {item.type === "match" ? (
        <div className="mt-3">
          <MatchPairsEditor
            pairs={item.pairs ?? []}
            onChange={(pairs) =>
              updateItem(item.id, (i) => ({ ...i, pairs }))
            }
            disabled={isLocked}
            repairable={newAuthoring}
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
            draggable={newAuthoring}
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
                  src={assessmentAssetUrl(assessment.id, item.prompt_asset_id)}
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
      ) : item.type === "graph" ? (
        <div className="mt-3">
          <GraphItemEditor
            board={item.board ?? DEFAULT_GRAPH_BOARD}
            graphKey={item.graph_key ?? null}
            onChange={(patch) => updateItem(item.id, (i) => ({ ...i, ...patch }))}
            disabled={isLocked}
          />
        </div>
      ) : item.type === "fill_blank" ? (
        <div className="mt-3">
          <FillBlankEditor
            itemId={item.id}
            stem={item.stem}
            blanks={item.blanks ?? []}
            onChange={(patch) =>
              updateItem(item.id, (i) => ({ ...i, ...patch }))
            }
            disabled={isLocked}
            handScored={item.scoring_method === "human"}
          />
        </div>
      ) : item.type === "short_text" ? (
        <div className="mt-3 space-y-2">
          <label className="block">
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
            {/* Numeric equivalence (2026-09-15): say what the
                default does, so the checkbox below reads as the
                exception it is. */}
            <span className="mt-1 block text-xs text-muted-foreground">
              Equivalent numbers count: 1/2, 0.5 and 50/100 all
              match. Check this for tasks like &ldquo;in lowest
              terms&rdquo;.
            </span>
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={item.exact_form === true}
              onChange={(e) =>
                updateItem(item.id, (i) => ({
                  ...i,
                  exact_form: e.target.checked,
                }))
              }
              disabled={isLocked}
            />
            <span>Answer form matters (exact match only)</span>
          </label>
        </div>
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
          {/* U-22 (decisions 2.1 / 2.2): a per-essay switch, off by
              default. A maximum always shows its count, so with one
              set the box reads ticked and cannot be changed. */}
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={
                item.max_word_count != null || item.show_word_count === true
              }
              onChange={(e) =>
                updateItem(item.id, (i) => ({
                  ...i,
                  show_word_count: e.target.checked ? true : null,
                }))
              }
              disabled={isLocked || item.max_word_count != null}
            />
            <span>
              Show students a word count
              {item.max_word_count != null ? (
                <span className="text-muted-foreground">
                  {" "}
                  (always on with a maximum)
                </span>
              ) : null}
            </span>
          </label>
          {/* RT slice 1 (docs/rich-text-essay-design.md): D-1 a
              per-essay switch, off by default; D-2 / D-4 / D-9 the
              formatting it allows. Student-facing, so locked
              while Published like the other essay fields. */}
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={item.rich_text === true}
              onChange={(e) =>
                updateItem(item.id, (i) => ({
                  ...i,
                  rich_text: e.target.checked ? true : null,
                }))
              }
              disabled={isLocked}
            />
            <span>
              Let students format their answer (bold, italic,
              underline, lists, first-line indent)
            </span>
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
              onChange={(rubric, meta) =>
                updateItem(item.id, (i) => ({
                  ...i,
                  rubric,
                  // Applying a saved rubric attaches it; every
                  // hand edit arrives without meta and detaches.
                  rubric_id: meta?.rubric_id ?? null,
                }))
              }
              disabled={isLocked}
              assessmentId={assessment.id}
            />
          </div>
        </div>
      ) : (
        <div className="mt-3 space-y-2">
          <div className="text-sm font-medium">Choices</div>
          {(() => {
          // R-7: in the new editor a choice row drags by its handle
          // and has Move up / Move down; it is lettered by position,
          // as the preview letters it. The old editor's rows are as
          // before (no `drag`, lettered by id).
          const renderChoice = (c: Choice, ci: number, drag?: DragBits) => {
            const isMulti = item.type === "multiple_choice_multi";
            const checked = item.correct_choice_ids.includes(c.id);
            const letter = drag ? choiceLetter(ci) : c.id.toUpperCase();
            return (
              <div key={c.id} ref={drag?.setNodeRef} style={drag?.style} className={drag?.isDragging ? "rounded-md bg-card shadow" : undefined}>
                <div className="flex items-center gap-2">
                  {drag ? (
                    <button
                      type="button"
                      className="cursor-grab rounded p-0.5 text-muted-foreground hover:bg-accent disabled:cursor-default disabled:opacity-40"
                      aria-label={`Drag choice ${letter}`}
                      disabled={isLocked}
                      {...drag.handleProps}
                    >
                      <GripVertical className="size-4" aria-hidden />
                    </button>
                  ) : null}
                  <input
                    type={isMulti ? "checkbox" : "radio"}
                    name={`correct-${item.id}`}
                    checked={checked}
                    aria-label={`Mark choice ${letter} as correct`}
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
                    {letter}
                  </span>
                  {newAuthoring && usesRichTextField(item.type) ? (
                    <div className="min-w-0 flex-1 [&_.rt-field]:mt-0">
                      <RichTextField
                        singleLine
                        label={`Choice ${letter} text`}
                        placeholder={`Choice ${letter}`}
                        value={c.text}
                        disabled={isLocked}
                        onChange={(text) =>
                          updateItem(item.id, (i) => ({
                            ...i,
                            choices: i.choices.map((cc, cci) => (cci === ci ? { ...cc, text } : cc)),
                          }))
                        }
                      />
                    </div>
                  ) : (
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
                    aria-label={`Choice ${letter} text`}
                    placeholder={`Choice ${letter}`}
                  />
                  )}
                  {drag ? (
                    <>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => moveChoice(item.id, ci, ci - 1)}
                        disabled={ci === 0 || isLocked}
                        aria-label={`Move choice ${letter} up`}
                      >
                        <ArrowUp aria-hidden />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => moveChoice(item.id, ci, ci + 1)}
                        disabled={ci === item.choices.length - 1 || isLocked}
                        aria-label={`Move choice ${letter} down`}
                      >
                        <ArrowDown aria-hidden />
                      </Button>
                    </>
                  ) : null}
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
                    aria-label={`Remove choice ${letter}`}
                    title={item.choices.length <= 2 ? "Need at least 2 choices" : "Remove choice"}
                  >
                    <X aria-hidden />
                  </Button>
                </div>
                {newAuthoring && usesRichTextField(item.type) ? null : (
                <>
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
                </>
                )}
              </div>
            );
          };
          return newAuthoring && usesRichTextField(item.type) ? (
            <>
              <SortableRows
                ids={item.choices.map((c) => c.id)}
                onMove={(from, to) => moveChoice(item.id, from, to)}
                describe={(id) => `Choice ${choiceLetter(item.choices.findIndex((c) => c.id === id))}`}
                disabled={isLocked}
              >
                {(_id, ci, drag) => renderChoice(item.choices[ci]!, ci, drag)}
              </SortableRows>
              <MoveAnnouncer message={choiceMessage} />
            </>
          ) : (
            item.choices.map((c, ci) => renderChoice(c, ci))
          );
          })()}
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
    </>
  );
}

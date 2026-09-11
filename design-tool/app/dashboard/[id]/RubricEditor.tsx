"use client";

import { useState } from "react";
import type { Rubric, RubricCriterion, RubricLevel } from "@secure-test/schema";
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
import { RubricUploadDialog } from "./RubricUploadDialog";
import { SavedRubricsDialog } from "./SavedRubricsDialog";

// Slice 33: rubric authoring sub-form for essay items. One unified structure
// serves all three styles (analytic / holistic / single_point) as cardinality
// variants — the controls below adapt per style, and changing style normalizes
// the criteria/levels to satisfy that style's constraints (mirroring the Zod
// superRefine in @secure-test/schema). Storage is items.config.rubric; this
// component is purely the editor.

type RubricStyle = Rubric["style"];

const STYLE_LABEL: Record<RubricStyle, string> = {
  analytic: "Analytic (criteria × levels)",
  holistic: "Holistic (one overall scale)",
  single_point: "Single-point (one target per criterion)",
};

function newId(): string {
  return crypto.randomUUID();
}

function defaultLevel(label: string, points: number): RubricLevel {
  return { id: newId(), label, points };
}

// E19: every seeded name/label must be NON-EMPTY. RubricSchema requires
// min(1) on criterion.name and level.label, so seeding "" meant an untouched
// new rubric 400'd on save with a generic banner and no field hint — the
// teacher had no way to know which box was the problem. Placeholders are
// editable text, not magic values.
function defaultCriterion(name: string): RubricCriterion {
  return {
    id: newId(),
    name,
    levels: [defaultLevel("Does not meet", 0), defaultLevel("Meets", 1)],
  };
}

/** "Criterion 3" for the criterion being appended at index `count`. */
function nextCriterionName(count: number): string {
  return `Criterion ${count + 1}`;
}

/** "Level 3" for the level being appended at index `count`. */
function nextLevelLabel(count: number): string {
  return `Level ${count + 1}`;
}

export function defaultRubric(): Rubric {
  return {
    style: "analytic",
    criteria: [defaultCriterion(nextCriterionName(0))],
    student_visibility: { during_test: false, with_feedback: false },
  };
}

// Reshape an existing rubric so it satisfies the target style's cardinality.
function normalizeForStyle(rubric: Rubric, style: RubricStyle): Rubric {
  let criteria = rubric.criteria;
  if (style === "holistic") {
    // Exactly one criterion; keep the first, auto-name it.
    const first = criteria[0] ?? defaultCriterion("Overall");
    criteria = [{ ...first, name: first.name || "Overall" }];
  }
  if (style === "single_point") {
    // Exactly one level (the target) per criterion.
    // Review fix (2026-08-14): the target level defaults to 1 point, not 0 —
    // a rubric whose total max is 0 can never be finalized (max_points > 0
    // is a DB CHECK) and the write boundary now rejects it.
    criteria = criteria.map((c) => ({ ...c, levels: [c.levels[0] ?? defaultLevel("Target", 1)] }));
  } else {
    // analytic + holistic need a scale (>= 2 levels).
    criteria = criteria.map((c) =>
      c.levels.length >= 2
        ? c
        : {
            ...c,
            levels: [...c.levels, defaultLevel(nextLevelLabel(c.levels.length), 0)],
          },
    );
  }
  return { ...rubric, style, criteria };
}

// Rubric upload slice 2 (docs/rubric-upload-design.md §"The editor
// dialog"): whether `rubric` is still exactly the pristine shape
// `defaultRubric()` seeds — the ONE shape "Upload rubric…" can replace
// without a confirm. Anything a teacher typed into it (a renamed
// criterion, an added level, a changed point value…) makes it "authored"
// and worth protecting, the same posture as `criteriaAndLevelsLost` below.
export function isDefaultRubric(rubric: Rubric): boolean {
  if (rubric.style !== "analytic") return false;
  if (rubric.criteria.length !== 1) return false;
  const c = rubric.criteria[0]!;
  if (c.name !== "Criterion 1" || c.levels.length !== 2) return false;
  const [l0, l1] = c.levels;
  return (
    !!l0 &&
    !!l1 &&
    l0.label === "Does not meet" &&
    l0.points === 0 &&
    !l0.descriptor &&
    l1.label === "Meets" &&
    l1.points === 1 &&
    !l1.descriptor
  );
}

/** Rubric library slice 3 (D-4): where an applied rubric came from. Present
 * ONLY when the change is an apply of a library rubric — every hand edit
 * below calls `onChange` without it, which is the client-side half of the
 * detach rule the server enforces in `itemConfigForWrite`. */
export interface RubricChangeMeta {
  rubric_id?: string;
}

interface Props {
  value: Rubric | null;
  onChange: (rubric: Rubric | null, meta?: RubricChangeMeta) => void;
  disabled?: boolean;
  /** Rubric upload slice 2: the route the "Upload rubric…" dialog posts to
   * is per-assessment. */
  assessmentId: string;
}

export function RubricEditor({ value, onChange, disabled, assessmentId }: Props) {
  if (!value) {
    return (
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => onChange(defaultRubric())}
          disabled={disabled}
          className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-50"
        >
          + Add rubric
        </button>
        <RubricUploadDialog
          assessmentId={assessmentId}
          currentRubric={null}
          onApply={onChange}
          disabled={disabled}
        />
        <SavedRubricsDialog
          currentRubric={null}
          onApply={onChange}
          disabled={disabled}
        />
      </div>
    );
  }

  const rubric = value;
  const isHolistic = rubric.style === "holistic";
  const isSinglePoint = rubric.style === "single_point";

  function patch(next: Partial<Rubric>) {
    onChange({ ...rubric, ...next });
  }
  function patchCriterion(ci: number, next: Partial<RubricCriterion>) {
    patch({
      criteria: rubric.criteria.map((c, i) =>
        i === ci ? { ...c, ...next } : c,
      ),
    });
  }
  function patchLevel(ci: number, li: number, next: Partial<RubricLevel>) {
    patchCriterion(ci, {
      levels: rubric.criteria[ci]!.levels.map((l, i) =>
        i === li ? { ...l, ...next } : l,
      ),
    });
  }
  function setVisibility(key: "during_test" | "with_feedback", on: boolean) {
    patch({ student_visibility: { ...rubric.student_visibility, [key]: on } });
  }

  // E19 (related): switching style silently DESTROYED authored work —
  // holistic drops every criterion but the first, single_point drops every
  // level but the first, with no confirm and no undo. Count what would be lost
  // and ask first. Nothing is lost → no prompt.
  function criteriaAndLevelsLost(next: RubricStyle): number {
    const after = normalizeForStyle(rubric, next);
    const before =
      rubric.criteria.length +
      rubric.criteria.reduce((n, c) => n + c.levels.length, 0);
    const remaining =
      after.criteria.length +
      after.criteria.reduce((n, c) => n + c.levels.length, 0);
    return Math.max(0, before - remaining);
  }

  // UX pass 1, slice 9: the style switch that would discard authored
  // criteria asks in an AlertDialog instead of a native browser prompt.
  const [pendingStyle, setPendingStyle] = useState<RubricStyle | null>(null);
  const pendingLost = pendingStyle ? criteriaAndLevelsLost(pendingStyle) : 0;

  function changeStyle(next: RubricStyle) {
    if (next === rubric.style) return;
    if (criteriaAndLevelsLost(next) > 0) {
      setPendingStyle(next);
      return;
    }
    onChange(normalizeForStyle(rubric, next));
  }

  return (
    <div className="mt-2 space-y-3 rounded-md border border-border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label className="text-sm">
          Rubric style:
          <select
            value={rubric.style}
            onChange={(e) => changeStyle(e.target.value as RubricStyle)}
            disabled={disabled}
            className="ml-2 rounded-md border border-border bg-transparent px-2 py-1 text-sm"
          >
            {(Object.keys(STYLE_LABEL) as RubricStyle[]).map((s) => (
              <option key={s} value={s}>
                {STYLE_LABEL[s]}
              </option>
            ))}
          </select>
        </label>
        <div className="flex items-center gap-2">
          <RubricUploadDialog
            assessmentId={assessmentId}
            currentRubric={rubric}
            onApply={onChange}
            disabled={disabled}
          />
          <SavedRubricsDialog
            currentRubric={rubric}
            onApply={onChange}
            disabled={disabled}
          />
          <button
            type="button"
            onClick={() => onChange(null)}
            disabled={disabled}
            className="rounded border border-destructive/40 px-2 py-0.5 text-sm text-destructive disabled:opacity-30"
          >
            Remove rubric
          </button>
        </div>
      </div>

      <fieldset className="flex flex-wrap gap-4 text-sm">
        <legend className="text-xs font-medium text-muted-foreground">
          Show rubric to students
        </legend>
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={rubric.student_visibility?.during_test ?? false}
            onChange={(e) => setVisibility("during_test", e.target.checked)}
            disabled={disabled}
          />
          During the assessment
        </label>
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={rubric.student_visibility?.with_feedback ?? false}
            onChange={(e) => setVisibility("with_feedback", e.target.checked)}
            disabled={disabled}
          />
          With feedback (Phase 3)
        </label>
      </fieldset>

      <div className="space-y-3">
        {rubric.criteria.map((c, ci) => (
          <div
            key={c.id}
            className="space-y-2 rounded-md border border-border p-2"
          >
            <div className="flex items-center gap-2">
              <input
                value={c.name}
                placeholder={isHolistic ? "Overall" : `Criterion ${ci + 1}`}
                onChange={(e) => patchCriterion(ci, { name: e.target.value })}
                disabled={disabled}
                className="flex-1 rounded-md border border-border bg-transparent px-2 py-1 text-sm"
              />
              {!isHolistic ? (
                <button
                  type="button"
                  onClick={() =>
                    patch({
                      criteria: rubric.criteria.filter((_, i) => i !== ci),
                    })
                  }
                  disabled={disabled || rubric.criteria.length <= 1}
                  className="rounded border border-border px-2 py-0.5 text-sm disabled:opacity-30"
                  aria-label="Remove criterion"
                >
                  ✕
                </button>
              ) : null}
            </div>

            <div className="space-y-1.5">
              {c.levels.map((l, li) => (
                <div key={l.id} className="flex flex-wrap items-start gap-2">
                  <input
                    value={l.label}
                    placeholder={isSinglePoint ? "Target" : "Level label"}
                    onChange={(e) => patchLevel(ci, li, { label: e.target.value })}
                    disabled={disabled}
                    className="w-32 rounded-md border border-border bg-transparent px-2 py-1 text-sm"
                  />
                  <input
                    type="number"
                    min={0}
                    step="any"
                    value={l.points}
                    onChange={(e) =>
                      patchLevel(ci, li, {
                        points: Math.max(0, Number(e.target.value) || 0),
                      })
                    }
                    disabled={disabled}
                    className="w-20 rounded-md border border-border bg-transparent px-2 py-1 text-sm"
                    aria-label="Points"
                  />
                  <input
                    value={l.descriptor ?? ""}
                    placeholder="Descriptor (optional)"
                    onChange={(e) =>
                      patchLevel(ci, li, {
                        descriptor: e.target.value === "" ? undefined : e.target.value,
                      })
                    }
                    disabled={disabled}
                    className="min-w-[12rem] flex-1 rounded-md border border-border bg-transparent px-2 py-1 text-sm"
                  />
                  {!isSinglePoint ? (
                    <button
                      type="button"
                      onClick={() =>
                        patchCriterion(ci, {
                          levels: c.levels.filter((_, i) => i !== li),
                        })
                      }
                      disabled={disabled || c.levels.length <= 2}
                      className="rounded border border-border px-2 py-1 text-sm disabled:opacity-30"
                      aria-label="Remove level"
                    >
                      ✕
                    </button>
                  ) : null}
                </div>
              ))}
              {!isSinglePoint ? (
                <button
                  type="button"
                  onClick={() =>
                    patchCriterion(ci, {
                      levels: [
                        ...c.levels,
                        defaultLevel(nextLevelLabel(c.levels.length), 0),
                      ],
                    })
                  }
                  disabled={disabled}
                  className="rounded border border-border px-2 py-0.5 text-xs hover:bg-accent disabled:opacity-30"
                >
                  + Add level
                </button>
              ) : null}
            </div>
          </div>
        ))}

        {!isHolistic ? (
          <button
            type="button"
            onClick={() =>
              patch({
                criteria: [
                  ...rubric.criteria,
                  normalizeCriterionForStyle(
                    rubric.style,
                    nextCriterionName(rubric.criteria.length),
                  ),
                ],
              })
            }
            disabled={disabled}
            className="rounded-md border border-border px-3 py-1 text-sm hover:bg-accent disabled:opacity-30"
          >
            + Add criterion
          </button>
        ) : null}
      </div>

      <AlertDialog
        open={pendingStyle !== null}
        onOpenChange={(open) => {
          if (!open) setPendingStyle(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Switch to {pendingStyle ? STYLE_LABEL[pendingStyle] : ""}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingLost} criterion or level entr{pendingLost === 1 ? "y" : "ies"} you have written
              will be discarded. This can&apos;t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep the current style</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingStyle) onChange(normalizeForStyle(rubric, pendingStyle));
                setPendingStyle(null);
              }}
            >
              Switch and discard
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// A fresh criterion shaped for the current style (single_point → one level).
function normalizeCriterionForStyle(
  style: RubricStyle,
  name: string,
): RubricCriterion {
  const c = defaultCriterion(name);
  // Review fix (2026-08-14): the single target level must carry points > 0
  // (levels[0] was the 0-point "Does not meet" — an unscorable rubric).
  if (style === "single_point")
    return { ...c, levels: [defaultLevel("Target", 1)] };
  return c;
}

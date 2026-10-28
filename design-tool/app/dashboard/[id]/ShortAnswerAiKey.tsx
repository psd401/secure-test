"use client";

import type { Rubric } from "@secure-test/schema";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  addPartialLevel,
  creditLevels,
  removeLevel,
  shortAnswerMax,
  updateLevel,
} from "@/lib/authoring/shortAnswerAi";

/**
 * AI short answer (2026-10-27): what earns credit, level by level, with the
 * points for each (the teacher sets them; partial credit is a level below
 * full). Stored as the item's holistic rubric.
 */
export function ShortAnswerAiKey({
  rubric,
  onChange,
  disabled,
}: {
  rubric: Rubric;
  onChange: (rubric: Rubric) => void;
  disabled: boolean;
}) {
  const levels = creditLevels(rubric);
  return (
    <fieldset className="space-y-3" disabled={disabled}>
      <legend className="text-sm font-medium">
        What earns credit{" "}
        <span className="font-normal text-muted-foreground">
          (out of {shortAnswerMax(rubric)} {shortAnswerMax(rubric) === 1 ? "point" : "points"})
        </span>
      </legend>
      <p className="text-xs text-muted-foreground">
        The AI scores each answer against these. Say what an answer must contain; list the answers you would
        accept. Anything less earns no credit.
      </p>
      {levels.map((level) => (
        <div key={level.id} className="rounded-md border border-border p-3">
          <div className="flex items-center gap-3">
            <span className="text-sm font-medium">{level.label}</span>
            <label className="flex items-center gap-1 text-sm">
              <input
                type="number"
                min={1}
                max={100}
                step={1}
                value={level.points}
                onChange={(e) => {
                  const n = Math.round(Number(e.target.value));
                  if (Number.isFinite(n) && n >= 1 && n <= 100) onChange(updateLevel(rubric, level.id, { points: n }));
                }}
                className="w-16 rounded-md border border-border bg-transparent px-2 py-1 text-sm"
                aria-label={`${level.label} points`}
              />
              <span>{level.points === 1 ? "point" : "points"}</span>
            </label>
            {levels.length > 1 ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="ml-auto"
                onClick={() => onChange(removeLevel(rubric, level.id))}
                aria-label={`Remove this ${level.label.toLowerCase()} level`}
              >
                <X className="size-4" aria-hidden />
              </Button>
            ) : null}
          </div>
          <textarea
            value={level.descriptor ?? ""}
            onChange={(e) => onChange(updateLevel(rubric, level.id, { descriptor: e.target.value }))}
            maxLength={2000}
            rows={2}
            placeholder="e.g. The number of births per 1,000 people in a year."
            className="mt-2 w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm"
            aria-label={`What earns ${level.label.toLowerCase()}`}
          />
        </div>
      ))}
      <Button type="button" variant="outline" size="sm" onClick={() => onChange(addPartialLevel(rubric))}>
        <Plus className="mr-1 size-4" aria-hidden />
        Add a partial-credit level
      </Button>
    </fieldset>
  );
}

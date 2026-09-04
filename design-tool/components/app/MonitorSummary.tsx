"use client";

import type { StudentState } from "@/components/app/StatusBadge";
import { cn } from "@/lib/utils";

/**
 * UX pass 1, slice 7 (SM-10): five tiles that say where the room is, in the
 * triage order a teacher scans them, and double as filters for the table.
 */
export const SUMMARY_ORDER: StudentState[] = [
  "needs_attention",
  "idle",
  "in_progress",
  "not_joined",
  "handed_in",
];

const LABEL: Record<StudentState, string> = {
  needs_attention: "Needs attention",
  idle: "Idle",
  in_progress: "In progress",
  not_joined: "Not joined",
  handed_in: "Handed in",
};

const TONE: Record<StudentState, string> = {
  needs_attention: "text-danger-foreground",
  idle: "text-warning-foreground",
  in_progress: "text-info-foreground",
  not_joined: "text-neutral-foreground",
  handed_in: "text-success-foreground",
};

export function MonitorSummary({
  counts,
  active,
  onSelect,
}: {
  counts: Record<StudentState, number>;
  active: StudentState | null;
  onSelect: (state: StudentState | null) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-5" role="group" aria-label="Students by status">
      {SUMMARY_ORDER.map((state) => {
        const pressed = active === state;
        return (
          <button
            key={state}
            type="button"
            aria-pressed={pressed}
            aria-label={`: `}
            onClick={() => onSelect(pressed ? null : state)}
            className={cn(
              "rounded-lg border bg-card px-3 py-2 text-left transition-colors hover:bg-accent focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
              pressed && "border-ring bg-accent",
            )}
          >
            <span className={cn("block font-heading text-2xl font-bold leading-none tabular-nums", TONE[state])}>
              {counts[state]}
            </span>
            <span className="mt-1 block text-xs text-muted-foreground">{LABEL[state]}</span>
          </button>
        );
      })}
    </div>
  );
}

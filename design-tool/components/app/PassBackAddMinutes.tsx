"use client";

import { MAX_ADD_MINUTES, parseAddMinutes } from "@/components/app/ExtendTimeControl";

/**
 * Working-time clock (docs/working-time-clock-design.md, D4): the pass-back
 * dialogs' optional "+N minutes". The clock resumes where it stopped, so a
 * pass back needs no end time on a working-time test; a student who had used
 * all their time needs some added, or they cannot get back in.
 *
 * What the field adds to the request: nothing when blank, `add_minutes` when
 * a valid number, or null when the value is not one (the caller says so).
 * Pure for the tests.
 */
export function passBackAddMinutesBody(
  value: string,
): { add_minutes?: number } | null {
  if (value.trim() === "") return {};
  const minutes = parseAddMinutes(value);
  return minutes === null ? null : { add_minutes: minutes };
}

export const PASS_BACK_ADD_MINUTES_ERROR = `Enter a whole number of minutes, 1 to ${MAX_ADD_MINUTES}, or leave it blank.`;

export function PassBackAddMinutes({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  return (
    <label className="text-sm">
      <span className="block text-xs text-muted-foreground">Add minutes (optional)</span>
      <input
        type="number"
        min={1}
        max={MAX_ADD_MINUTES}
        step={1}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        aria-label="Minutes to add"
        className="mt-0.5 w-24 rounded-md border border-border bg-transparent px-2 py-1 text-sm"
      />
      <span className="mt-1 block text-xs text-muted-foreground">
        The test clock picks up where it stopped. Add minutes if they had used all their time.
      </span>
    </label>
  );
}

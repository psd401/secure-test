"use client";

/**
 * Corrections mode in a pass-back dialog (docs/bulk-pass-back-and-corrections-design.md,
 * slice 3, D-8 / D-21): the two choices every pass-back dialog offers — the
 * one-student dialog, "Pass back everyone" and "Pass back a class". Both
 * default off; the dialog resets them each time it opens.
 */
export interface CorrectionsChoice {
  show_marks: boolean;
  lock_correct: boolean;
}

export const NO_CORRECTIONS: CorrectionsChoice = { show_marks: false, lock_correct: false };

/** The request-body fields for a choice — none when both are off, so a plain
 * pass back sends exactly what it sent before slice 3. */
export function correctionsBody(c: CorrectionsChoice): Partial<CorrectionsChoice> {
  return c.show_marks || c.lock_correct ? { ...c } : {};
}

export function CorrectionsOptions({
  value,
  onChange,
  disabled,
}: {
  value: CorrectionsChoice;
  onChange: (next: CorrectionsChoice) => void;
  disabled: boolean;
}) {
  return (
    <fieldset className="space-y-1.5 text-sm">
      <legend className="text-xs text-muted-foreground">For another try</legend>
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={value.show_marks}
          disabled={disabled}
          onChange={(e) => onChange({ ...value, show_marks: e.target.checked })}
        />
        <span>
          Show right/wrong
          <span className="block text-xs text-muted-foreground">
            Each question shows whether it was right, partly right or wrong — never the answer.
          </span>
        </span>
      </label>
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={value.lock_correct}
          disabled={disabled}
          onChange={(e) => onChange({ ...value, lock_correct: e.target.checked })}
        />
        <span>
          Lock correct answers
          <span className="block text-xs text-muted-foreground">
            Questions with full credit can&apos;t be changed.
          </span>
        </span>
      </label>
    </fieldset>
  );
}

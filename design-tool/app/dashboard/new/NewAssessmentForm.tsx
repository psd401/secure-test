"use client";

import Link from "next/link";
import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { StartChoice } from "@/lib/authoring/startScreen";
import { createAssessment } from "./actions";
import { EMPTY_STATE } from "./state";

function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} role="alert" className="text-sm text-destructive">
      {message}
    </p>
  );
}

/** Editor redesign Phase 8: the start screen's submit label for each choice. */
const START_SUBMIT: Record<StartChoice, { label: string; pending: string }> = {
  blank: { label: "Create", pending: "Creating…" },
  import: { label: "Create and import", pending: "Creating…" },
  ai: { label: "Create and draft with AI", pending: "Creating…" },
};

/**
 * `start` is set only by the start screen (R-12 flag on, editor redesign
 * Phase 8). Without it this is today's New assessment form, unchanged.
 */
export function NewAssessmentForm({ start }: { start?: StartChoice } = {}) {
  const [state, formAction, pending] = useActionState(createAssessment, EMPTY_STATE);
  const e = state.fieldErrors;

  return (
    <form action={formAction} noValidate className={start ? "space-y-5" : "mt-8 space-y-5"}>
      {start ? <input type="hidden" name="start" value={start} /> : null}
      <div className="space-y-2">
        <Label htmlFor="name">Name</Label>
        <Input
          id="name"
          name="name"
          required
          maxLength={200}
          defaultValue={state.values.name}
          placeholder="e.g. 5th grade math benchmark"
          aria-invalid={e.name ? true : undefined}
          aria-describedby={e.name ? "name-error" : undefined}
        />
        <FieldError id="name-error" message={e.name} />
      </div>

      <div className="space-y-2">
        <Label htmlFor="description">Description</Label>
        <Textarea
          id="description"
          name="description"
          rows={3}
          maxLength={2000}
          defaultValue={state.values.description}
          placeholder="Optional"
          aria-invalid={e.description ? true : undefined}
          aria-describedby={e.description ? "description-error" : undefined}
        />
        <FieldError id="description-error" message={e.description} />
      </div>

      <div className="space-y-2">
        <Label htmlFor="time_limit_minutes">Time limit (minutes)</Label>
        <div className="flex items-center gap-3">
          <Input
            id="time_limit_minutes"
            name="time_limit_minutes"
            type="number"
            inputMode="numeric"
            min={1}
            step={1}
            defaultValue={state.values.time_limit_minutes}
            placeholder="(none)"
            className="w-32"
            aria-invalid={e.time_limit_minutes ? true : undefined}
            aria-describedby={e.time_limit_minutes ? "time-error" : "time-help"}
          />
          <span id="time-help" className="text-xs text-muted-foreground">
            Leave blank for untimed
          </span>
        </div>
        <FieldError id="time-error" message={e.time_limit_minutes} />
      </div>

      {start === "blank" ? (
        <label className="flex items-start gap-2">
          <input type="checkbox" name="with_example" defaultChecked className="mt-1" />
          <span className="text-sm">
            Start with an example question
            <span className="block text-xs text-muted-foreground">
              One sample multiple-choice question to change or delete.
            </span>
          </span>
        </label>
      ) : null}

      {/* The AI draft's gate is today's: the assessment's "Allow AI help"
          setting, off unless the teacher ticks it here (lib/authoring/startScreen.ts). */}
      {start === "ai" ? (
        <div className="space-y-2">
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              name="allow_llm_authoring"
              className="mt-1"
              aria-invalid={e.allow_llm_authoring ? true : undefined}
              aria-describedby={e.allow_llm_authoring ? "llm-error" : undefined}
            />
            <span className="text-sm">
              Allow AI help when writing questions
              <span className="block text-xs text-muted-foreground">
                Needed to draft with AI. You review every question before it is added, and you can
                turn this off later in Settings.
              </span>
            </span>
          </label>
          <FieldError id="llm-error" message={e.allow_llm_authoring} />
        </div>
      ) : null}

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {start
            ? pending
              ? START_SUBMIT[start].pending
              : START_SUBMIT[start].label
            : pending
              ? "Creating…"
              : "Create"}
        </Button>
        <Button asChild variant="ghost">
          <Link href="/dashboard">Cancel</Link>
        </Button>
      </div>
    </form>
  );
}

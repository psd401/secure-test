"use client";

import Link from "next/link";
import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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

export function NewAssessmentForm() {
  const [state, formAction, pending] = useActionState(createAssessment, EMPTY_STATE);
  const e = state.fieldErrors;

  return (
    <form action={formAction} noValidate className="mt-8 space-y-5">
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

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? "Creating…" : "Create"}
        </Button>
        <Button asChild variant="ghost">
          <Link href="/dashboard">Cancel</Link>
        </Button>
      </div>
    </form>
  );
}

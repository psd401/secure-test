"use client";

import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { StatusLine, type SaveState } from "@/components/app/StatusLine";
import {
  FEEDBACK_OFFLINE_MESSAGE,
  TEACHER_FEEDBACK_ADMIN_HINT,
  TEACHER_FEEDBACK_HINT,
  TEACHER_FEEDBACK_MAX,
  feedbackFailureMessage,
  feedbackIsDirty,
  feedbackRequest,
} from "@/lib/teacherFeedback/limits";

/**
 * Teacher feedback (docs/feedback-release-design.md, D-1 / D-4 / D-12): one
 * comment box — per question in the scoring queue and on the per-student
 * page, and once per student overall. Labelled by source (D-1).
 *
 * An explicit Save, not autosave, so each save is one `feedback_edited` line
 * on the timeline. An empty box clears the comment (DELETE). The box keeps
 * its own state, so a parent's refetch does not reset a draft; "Not saved"
 * shows while the text differs from what the server last accepted — on the
 * queue a card leaves the list once it is scored, taking any unsaved draft
 * with it, so the hint matters there.
 *
 * `readOnly`: a non-impersonating admin on the queue sees the box grayed out
 * (the routes refuse the write, SEC-03), not a box whose save fails.
 */
export function TeacherFeedbackBox({
  endpoint,
  initialText,
  label = "Teacher feedback",
  hint,
  readOnly = false,
}: {
  /** `/api/responses/<id>/feedback` or `/api/attempts/<id>/feedback`. */
  endpoint: string;
  initialText: string;
  label?: string;
  hint?: string;
  readOnly?: boolean;
}) {
  const id = useId();
  const [text, setText] = useState(initialText);
  const [saved, setSaved] = useState(initialText);
  const [save, setSave] = useState<SaveState>({ kind: "idle" });

  const dirty = feedbackIsDirty(text, saved);
  const saving = save.kind === "saving";

  async function persist() {
    const req = feedbackRequest(text);
    setSave({ kind: "saving" });
    try {
      const res = await fetch(endpoint, {
        method: req.method,
        ...(req.method === "PUT"
          ? {
              headers: { "content-type": "application/json" },
              body: JSON.stringify(req.body),
            }
          : {}),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
        const error = typeof body?.error === "string" ? body.error : undefined;
        setSave({ kind: "failed", message: feedbackFailureMessage(res.status, error) });
        return;
      }
      const next = req.method === "PUT" ? req.body.text : "";
      setSaved(next);
      setText(next);
      setSave({ kind: "saved", at: new Date() });
    } catch {
      setSave({ kind: "failed", message: FEEDBACK_OFFLINE_MESSAGE });
    }
  }

  return (
    <div className="mt-3 border-t border-border pt-3" data-teacher-feedback>
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
      </label>
      <p className="text-xs text-muted-foreground">
        {hint ?? (readOnly ? TEACHER_FEEDBACK_ADMIN_HINT : TEACHER_FEEDBACK_HINT)}
      </p>
      <Textarea
        id={id}
        value={text}
        maxLength={TEACHER_FEEDBACK_MAX}
        disabled={saving || readOnly}
        onChange={(e) => {
          setText(e.target.value);
          if (save.kind === "saved" || save.kind === "failed") setSave({ kind: "idle" });
        }}
        className="mt-1"
        rows={3}
      />
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={saving || !dirty || readOnly}
          onClick={() => void persist()}
        >
          {text.trim() === "" && saved !== "" ? "Clear feedback" : "Save feedback"}
        </Button>
        <StatusLine state={save} />
        {dirty && !saving && save.kind !== "failed" ? (
          <span className="text-xs text-muted-foreground">Not saved</span>
        ) : null}
      </div>
    </div>
  );
}

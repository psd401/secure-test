"use client";

import { useState } from "react";
import type { Rubric } from "@secure-test/schema";
import type { RubricWarning } from "@/lib/ai/rubricExtractor/extractCore";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { isDefaultRubric } from "./RubricEditor";

// Rubric upload slice 2 (docs/rubric-upload-design.md §"The editor dialog"):
// the "Upload rubric…" dialog RubricEditor mounts beside the style select
// (and beside "+ Add rubric" when no rubric exists yet). Extraction WRITES
// NOTHING — slice 1's route only proposes; "Use this rubric" is the one
// place this dialog changes the editor's state, same propose-then-apply
// posture as PDF import.

/** A file wins over pasted text when both are present (extract() below). */
export function canExtract(file: File | null, text: string): boolean {
  return file !== null || text.trim().length > 0;
}

/** The proposal never carries `student_visibility` (extractCore.ts's
 * candidate object has no such field) — keep whatever the editor already
 * had, defaulting to the proposal's (i.e. none) only when there was no
 * prior rubric to preserve it from. */
export function mergeRubricProposal(current: Rubric | null, proposal: Rubric): Rubric {
  const student_visibility = current?.student_visibility ?? proposal.student_visibility;
  return student_visibility ? { ...proposal, student_visibility } : proposal;
}

interface ExtractErrorBody {
  ok?: boolean;
  error?: string;
  hint?: string;
  issues?: string[];
}

/** Maps a non-2xx response to what the dialog shows. 413 and 409 get fixed
 * copy (the route's own body carries no teacher-facing hint for either);
 * everything else — including 415 — uses the route's `hint`, falling back
 * to a generic message when a body couldn't be read at all. */
export function describeExtractError(
  status: number,
  body: ExtractErrorBody | null,
): { message: string; issues?: string[] } {
  if (status === 413) return { message: "The file is over 5 MB." };
  if (status === 409) return { message: "Unpublish the assessment to change rubrics." };
  return {
    message: body?.hint ?? "Could not read the rubric.",
    ...(body?.issues && body.issues.length > 0 ? { issues: body.issues } : {}),
  };
}

export type RubricExtractOutcome =
  | { ok: true; rubric: Rubric; warnings: RubricWarning[] }
  | { ok: false; message: string; issues?: string[] };

/** Calls the slice-1 route: multipart when a file was chosen (it wins over
 * pasted text), else the JSON `{ text }` path. */
export async function runRubricExtract(
  assessmentId: string,
  input: { file: File | null; text: string },
): Promise<RubricExtractOutcome> {
  const url = `/api/assessments/${assessmentId}/rubrics/extract`;
  let res: Response;
  if (input.file) {
    const form = new FormData();
    form.append("file", input.file);
    res = await fetch(url, { method: "POST", body: form });
  } else {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: input.text }),
    });
  }
  const body = (await res.json().catch(() => null)) as
    | (ExtractErrorBody & { rubric?: Rubric; warnings?: RubricWarning[] })
    | null;
  if (!res.ok || !body?.ok) {
    return { ok: false, ...describeExtractError(res.status, body) };
  }
  return { ok: true, rubric: body.rubric as Rubric, warnings: body.warnings ?? [] };
}

interface RubricProposalViewProps {
  rubric: Rubric;
  warnings: RubricWarning[];
}

/** The proposed rubric, read-only — the same criterion→levels shape
 * `renderRubric` (lib/preview/renderHtml.ts) draws for the student preview,
 * as React instead of an HTML string. A single_point level's label always
 * reads "Target", matching the editor's own placeholder for that style. */
export function RubricProposalView({ rubric, warnings }: RubricProposalViewProps) {
  return (
    <div className="space-y-3">
      {warnings.length > 0 ? (
        <ul className="space-y-1" aria-label="Warnings">
          {warnings.map((w, i) => (
            <li
              key={i}
              className="rounded border border-warning-foreground/30 bg-warning-foreground/5 p-2 text-xs text-warning-foreground"
            >
              {w.message}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="space-y-3 rounded-md border border-border p-3" aria-label="Proposed rubric">
        {rubric.criteria.map((c) => (
          <div key={c.id} className="space-y-1">
            <p className="text-sm font-medium">{c.name}</p>
            <table className="w-full text-xs">
              <tbody>
                {c.levels.map((l) => (
                  <tr key={l.id} className="border-t border-border">
                    <th
                      scope="row"
                      className="py-1 pr-2 text-left align-top font-medium whitespace-nowrap"
                    >
                      {rubric.style === "single_point" ? "Target" : l.label}{" "}
                      <span className="font-normal text-muted-foreground">
                        ({l.points} pt{l.points === 1 ? "" : "s"})
                      </span>
                    </th>
                    <td className="py-1 text-muted-foreground">{l.descriptor ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Rubric library slice 3 (D-4): the file name without its extension is the
 * teacher's own word for the rubric, so it is the best default title.
 * Falls back to "Rubric" for the paste path (no file) or a nameless one. */
export function defaultRubricTitle(file: File | null): string {
  const base = (file?.name ?? "").replace(/\.[^.]+$/, "").trim();
  return base.length > 0 ? base.slice(0, 200) : "Rubric";
}

export type SaveRubricOutcome =
  | { ok: true; id: string }
  | { ok: false; message: string };

/** Rubric library slice 3: POST the proposal to the teacher's library. The
 * dialog stays on the proposal pane afterwards — saving and using are
 * independent, and a teacher who saves usually wants to use it too. */
export async function saveRubricToLibrary(
  title: string,
  rubric: Rubric,
): Promise<SaveRubricOutcome> {
  const res = await fetch("/api/rubrics", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title, rubric, source: "upload" }),
  });
  const body = (await res.json().catch(() => null)) as
    | { rubric?: { id?: string }; hint?: string }
    | null;
  if (!res.ok || !body?.rubric?.id) {
    return { ok: false, message: body?.hint ?? "Could not save the rubric." };
  }
  return { ok: true, id: body.rubric.id };
}

interface Props {
  assessmentId: string;
  /** The editor's current rubric, if any — merged into the proposal
   * (student_visibility) and checked for authored content before a
   * confirm. */
  currentRubric: Rubric | null;
  /** `meta.rubric_id` is set only when the proposal was saved to the library
   * first — applying then records where the item's copy came from. */
  onApply: (rubric: Rubric, meta?: { rubric_id?: string }) => void;
  disabled?: boolean;
}

export function RubricUploadDialog({ assessmentId, currentRubric, onApply, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; issues?: string[] } | null>(null);
  const [proposal, setProposal] = useState<{ rubric: Rubric; warnings: RubricWarning[] } | null>(
    null,
  );
  const [confirmOpen, setConfirmOpen] = useState(false);
  // Rubric library slice 3: the proposal pane's second action. `savedId` is
  // the library row once saved — applying afterwards carries it as the
  // item's `rubric_id`.
  const [title, setTitle] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  function reset() {
    setFile(null);
    setText("");
    setBusy(false);
    setError(null);
    setProposal(null);
    setConfirmOpen(false);
    setTitle("");
    setSaving(false);
    setSavedId(null);
    setSaveError(null);
  }

  function closeAndReset() {
    setOpen(false);
    reset();
  }

  function apply(rubric: Rubric) {
    onApply(
      mergeRubricProposal(currentRubric, rubric),
      savedId ? { rubric_id: savedId } : undefined,
    );
    closeAndReset();
  }

  async function save() {
    if (!proposal) return;
    setSaving(true);
    setSaveError(null);
    const outcome = await saveRubricToLibrary(title.trim(), proposal.rubric);
    setSaving(false);
    if (!outcome.ok) {
      setSaveError(outcome.message);
      return;
    }
    setSavedId(outcome.id);
  }

  // E19-style guard (RubricEditor's criteriaAndLevelsLost): only a rubric
  // the teacher has actually authored something into asks for confirm — the
  // pristine "+ Add rubric" default has nothing worth protecting.
  function handleUse() {
    if (!proposal) return;
    if (currentRubric && !isDefaultRubric(currentRubric)) {
      setConfirmOpen(true);
      return;
    }
    apply(proposal.rubric);
  }

  async function extract() {
    setBusy(true);
    setError(null);
    const outcome = await runRubricExtract(assessmentId, { file, text });
    setBusy(false);
    if (!outcome.ok) {
      setError({ message: outcome.message, issues: outcome.issues });
      return;
    }
    setProposal({ rubric: outcome.rubric, warnings: outcome.warnings });
    setTitle(defaultRubricTitle(file));
  }

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        Upload rubric…
      </Button>

      <Dialog
        open={open}
        onOpenChange={(o) => {
          if (busy) return;
          if (!o) {
            closeAndReset();
          } else {
            setOpen(true);
          }
        }}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Upload a rubric</DialogTitle>
            <DialogDescription>
              PDF, Word (.docx), Markdown or plain text. A Google Doc: download
              as .docx or .pdf, or paste it here.
            </DialogDescription>
          </DialogHeader>

          {!proposal ? (
            <div className="space-y-3">
              <input
                type="file"
                accept=".pdf,.docx,.md,.txt"
                disabled={busy}
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                aria-label="Rubric file"
                className="block text-sm"
              />
              <Textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                disabled={busy}
                rows={6}
                placeholder="Or paste the rubric text here"
                aria-label="Paste rubric text"
              />
              {busy ? (
                <p className="text-sm text-muted-foreground">Reading the rubric…</p>
              ) : null}
              {error ? (
                <div className="rounded border border-destructive/40 p-2 text-sm text-destructive">
                  <p>{error.message}</p>
                  {error.issues && error.issues.length > 0 ? (
                    <ul className="mt-1 list-disc pl-4 text-xs">
                      {error.issues.map((issue, i) => (
                        <li key={i}>{issue}</li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}
              <DialogFooter>
                <Button type="button" variant="outline" onClick={closeAndReset} disabled={busy}>
                  Cancel
                </Button>
                <Button
                  type="button"
                  onClick={extract}
                  disabled={busy || !canExtract(file, text)}
                >
                  Extract
                </Button>
              </DialogFooter>
            </div>
          ) : (
            <div className="space-y-3">
              <RubricProposalView rubric={proposal.rubric} warnings={proposal.warnings} />
              <div className="flex flex-wrap items-end gap-2 border-t border-border pt-3">
                <label className="text-sm">
                  <span className="block text-xs text-muted-foreground">
                    Rubric name
                  </span>
                  <input
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    disabled={saving || savedId !== null}
                    aria-label="Rubric name"
                    className="mt-0.5 w-56 rounded-md border border-border bg-transparent px-2 py-1 text-sm"
                  />
                </label>
                <Button
                  type="button"
                  variant="outline"
                  onClick={save}
                  disabled={saving || savedId !== null || title.trim().length === 0}
                >
                  {savedId ? "Saved" : saving ? "Saving…" : "Save to my rubrics"}
                </Button>
                {saveError ? (
                  <p className="text-sm text-destructive">{saveError}</p>
                ) : null}
              </div>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={closeAndReset}>
                  Cancel
                </Button>
                <Button type="button" onClick={handleUse}>
                  Use this rubric
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={confirmOpen}
        onOpenChange={(o) => {
          if (!o) setConfirmOpen(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Replace the current rubric?</AlertDialogTitle>
            <AlertDialogDescription>
              The criteria and levels you have written will be discarded and
              replaced with the uploaded rubric. This can&apos;t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep the current rubric</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (proposal) apply(proposal.rubric);
              }}
            >
              Replace it
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

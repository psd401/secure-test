"use client";

import { useState } from "react";
import type { Rubric } from "@secure-test/schema";
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
import { isDefaultRubric } from "./RubricEditor";

// Rubric library slice 3 (docs/rubric-upload-design.md §"Rubric library and
// reuse", D-4): "Use a saved rubric…" — the teacher's own shelf, picked from
// inside the item editor. Applying COPIES: the editor's state becomes a deep
// copy with fresh ids, and the item records `rubric_id` as provenance only.
// Nothing here writes; the item's own Save persists the copy.

export interface SavedRubricSummary {
  id: string;
  title: string;
  style: Rubric["style"];
  criteria_count: number;
  max_points: number;
  source: string;
  updated_at: string;
}

const STYLE_SHORT: Record<Rubric["style"], string> = {
  analytic: "Analytic",
  holistic: "Holistic",
  single_point: "Single-point",
};

/** "Analytic · 4 criteria · 12 pts" — the one line each row shows under its
 * title. */
export function describeSavedRubric(r: SavedRubricSummary): string {
  const criteria = `${r.criteria_count} criteri${r.criteria_count === 1 ? "on" : "a"}`;
  return `${STYLE_SHORT[r.style]} · ${criteria} · ${r.max_points} pt${r.max_points === 1 ? "" : "s"}`;
}

/**
 * A deep copy of a library rubric for the editor: FRESH `c1…` / `l1…` ids
 * (the same scheme the extractor assigns, unique across the rubric) so the
 * item's copy shares no identity with the library row, and the editor's
 * current `student_visibility` is kept — visibility is a property of this
 * assessment, not of the saved rubric.
 */
export function copyRubricForEditor(
  saved: Rubric,
  current: Rubric | null,
): Rubric {
  let levelSeq = 0;
  const copy: Rubric = {
    style: saved.style,
    criteria: saved.criteria.map((c, ci) => ({
      id: `c${ci + 1}`,
      name: c.name,
      levels: c.levels.map((l) => ({
        id: `l${(levelSeq += 1)}`,
        label: l.label,
        points: l.points,
        ...(l.descriptor ? { descriptor: l.descriptor } : {}),
      })),
    })),
  };
  const student_visibility = current?.student_visibility ?? saved.student_visibility;
  return student_visibility ? { ...copy, student_visibility } : copy;
}

export type SavedRubricListOutcome =
  | { ok: true; rubrics: SavedRubricSummary[] }
  | { ok: false; message: string };

export async function fetchSavedRubrics(): Promise<SavedRubricListOutcome> {
  const res = await fetch("/api/rubrics");
  const body = (await res.json().catch(() => null)) as
    | { rubrics?: SavedRubricSummary[] }
    | null;
  if (!res.ok || !body?.rubrics) {
    return { ok: false, message: "Could not load your saved rubrics." };
  }
  return { ok: true, rubrics: body.rubrics };
}

export type SavedRubricFetchOutcome =
  | { ok: true; rubric: Rubric }
  | { ok: false; message: string };

/** The picker lists summaries; the full rubric is fetched only for the one
 * the teacher actually applies. */
export async function fetchSavedRubric(id: string): Promise<SavedRubricFetchOutcome> {
  const res = await fetch(`/api/rubrics/${id}`);
  const body = (await res.json().catch(() => null)) as
    | { rubric?: { rubric?: Rubric } }
    | null;
  const rubric = body?.rubric?.rubric;
  if (!res.ok || !rubric) {
    return { ok: false, message: "Could not open that rubric." };
  }
  return { ok: true, rubric };
}

interface Props {
  /** The editor's current rubric: its student_visibility is kept, and a
   * rubric the teacher has authored asks for a confirm first. */
  currentRubric: Rubric | null;
  onApply: (rubric: Rubric, meta?: { rubric_id?: string }) => void;
  disabled?: boolean;
}

export function SavedRubricsDialog({ currentRubric, onApply, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [list, setList] = useState<SavedRubricSummary[] | null>(null);
  const [pending, setPending] = useState<{ id: string; rubric: Rubric } | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  function closeAndReset() {
    setOpen(false);
    setBusy(false);
    setError(null);
    setList(null);
    setPending(null);
    setConfirmOpen(false);
  }

  async function openAndLoad() {
    setOpen(true);
    setBusy(true);
    setError(null);
    const outcome = await fetchSavedRubrics();
    setBusy(false);
    if (!outcome.ok) {
      setError(outcome.message);
      return;
    }
    setList(outcome.rubrics);
  }

  function apply(id: string, rubric: Rubric) {
    onApply(copyRubricForEditor(rubric, currentRubric), { rubric_id: id });
    closeAndReset();
  }

  async function pick(id: string) {
    setBusy(true);
    setError(null);
    const outcome = await fetchSavedRubric(id);
    setBusy(false);
    if (!outcome.ok) {
      setError(outcome.message);
      return;
    }
    // Same guard as the upload dialog: only a rubric the teacher authored
    // something into is worth a confirm.
    if (currentRubric && !isDefaultRubric(currentRubric)) {
      setPending({ id, rubric: outcome.rubric });
      setConfirmOpen(true);
      return;
    }
    apply(id, outcome.rubric);
  }

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled}
        onClick={openAndLoad}
      >
        Use a saved rubric…
      </Button>

      <Dialog
        open={open}
        onOpenChange={(o) => {
          if (busy) return;
          if (!o) closeAndReset();
          else setOpen(true);
        }}
      >
        <DialogContent className="max-h-[calc(100vh-2rem)] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Your saved rubrics</DialogTitle>
            <DialogDescription>
              Picking one copies it into this question. Later edits to the
              saved rubric do not change this copy.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            {busy ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
            {error ? (
              <p className="rounded border border-destructive/40 p-2 text-sm text-destructive">
                {error}
              </p>
            ) : null}
            {list && list.length === 0 && !busy ? (
              <p className="text-sm text-muted-foreground">
                You have not saved any rubrics yet. Upload one and choose
                &ldquo;Save to my rubrics&rdquo;.
              </p>
            ) : null}
            {list && list.length > 0 ? (
              <ul className="max-h-[60vh] space-y-2 overflow-y-auto" aria-label="Saved rubrics">
                {list.map((r) => (
                  <li key={r.id}>
                    <button
                      type="button"
                      onClick={() => pick(r.id)}
                      disabled={busy}
                      className="w-full rounded-md border border-border p-2 text-left hover:bg-accent disabled:opacity-50"
                    >
                      <span className="block text-sm font-medium">{r.title}</span>
                      <span className="block text-xs text-muted-foreground">
                        {describeSavedRubric(r)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={closeAndReset} disabled={busy}>
              Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={confirmOpen}
        onOpenChange={(o) => {
          if (!o) {
            setConfirmOpen(false);
            setPending(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Replace the current rubric?</AlertDialogTitle>
            <AlertDialogDescription>
              The criteria and levels you have written will be discarded and
              replaced with the saved rubric. This can&apos;t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep the current rubric</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pending) apply(pending.id, pending.rubric);
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

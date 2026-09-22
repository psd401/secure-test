"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ApiError, passBackErrorCopy } from "@/lib/ui/errorCopy";
import {
  defaultExtendValue,
  toIsoInstant,
} from "@/components/app/ExtendTimeControl";

async function readError(res: Response): Promise<ApiError> {
  let code = `http_${res.status}`;
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === "string") code = body.error;
  } catch {
    // not JSON
  }
  return new ApiError(code, res.status);
}

function describe(e: unknown): string {
  const code = e instanceof ApiError ? e.code : "network";
  return passBackErrorCopy(code).message;
}

/**
 * The dialog body copy (docs/pass-back-design.md, D-1/D-2): "Their answers
 * stay…" plus how many scores are kept as a record — or, with none, the
 * simpler line the note calls for. Pure, and exported for the same reason
 * `handInConfirmCopy` / `handInAllDialogCopy` are: Radix's Dialog content
 * sits behind a Portal unmounted while closed, so a static-markup test can't
 * reach it through the component tree.
 */
export function passBackCopy(studentName: string, scoreCount: number): string {
  const kept =
    scoreCount > 0
      ? `Their ${scoreCount === 1 ? "1 score is" : `${scoreCount} scores are`} kept as a record ` +
        "and the test is scored again on the next hand-in."
      : "The test is scored on the next hand-in.";
  return `Their answers stay; they can change them and hand in again. ${kept}`;
}

/**
 * Whether the dialog needs a new deadline before it can submit — true for a
 * timed assessment (or an attempt already carrying an override), because the
 * old deadline is already past the moment the attempt is passed back
 * (D-1, the route's `ends_at_required`).
 */
export function passBackNeedsDeadline(timed: boolean): boolean {
  return timed;
}

/**
 * "Pass back" (docs/pass-back-design.md): a handed-in attempt goes back to
 * in progress with its answers intact, its final scores kept as a record
 * (`superseded`), and — on a timed assessment — a new deadline. Same shape
 * as `ExtendTimeControl`: the caller decides where it sits, what `timed` and
 * `scoreCount` are, and what happens after (`onPassedBack`); the deadline
 * picker reuses `defaultExtendValue` / `toIsoInstant` so "tomorrow 23:59" is
 * one definition across both dialogs.
 */
export function PassBackControl({
  attemptId,
  studentName,
  scoreCount,
  timed,
  onPassedBack,
  disabledReason,
  size = "sm",
}: {
  attemptId: string;
  studentName: string;
  /** k in "Their k scores are kept as a record…". */
  scoreCount: number;
  timed: boolean;
  onPassedBack: () => void;
  disabledReason?: string;
  size?: "xs" | "sm" | "default";
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const needsDeadline = passBackNeedsDeadline(timed);

  function openDialog() {
    setError(null);
    setValue(defaultExtendValue());
    setOpen(true);
  }

  async function confirmPassBack() {
    let endsAt: string | null = null;
    if (needsDeadline) {
      endsAt = toIsoInstant(value);
      if (!endsAt) {
        setError("Pick a time in the future.");
        return;
      }
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/attempts/${attemptId}/pass-back`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(endsAt ? { ends_at: endsAt } : {}),
      });
      if (!res.ok) throw await readError(res);
      setOpen(false);
      onPassedBack();
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size={size}
        disabled={disabledReason !== undefined}
        title={disabledReason}
        onClick={openDialog}
      >
        Pass back
      </Button>
      <Dialog
        open={open}
        onOpenChange={(o) => {
          if (!o && !busy) setOpen(false);
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Pass back to {studentName}?</DialogTitle>
            <DialogDescription>
              {passBackCopy(studentName, scoreCount)}
            </DialogDescription>
          </DialogHeader>
          {needsDeadline ? (
            <label className="text-sm">
              <span className="block text-xs text-muted-foreground">
                New deadline
              </span>
              <input
                type="datetime-local"
                value={value}
                disabled={busy}
                onChange={(e) => setValue(e.target.value)}
                aria-label="New deadline"
                className="mt-0.5 w-full rounded-md border border-border bg-transparent px-2 py-1 text-sm"
              />
              <span className="mt-1 block text-xs text-muted-foreground">
                This attempt has a deadline — pick when it ends now.
              </span>
            </label>
          ) : null}
          {error ? (
            <p role="alert" className="text-sm text-danger-foreground">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => void confirmPassBack()}
              disabled={busy}
            >
              {busy ? "Passing back…" : "Pass back"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

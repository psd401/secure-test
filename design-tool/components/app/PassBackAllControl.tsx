"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  CorrectionsOptions,
  NO_CORRECTIONS,
  correctionsBody,
  type CorrectionsChoice,
} from "@/components/app/CorrectionsOptions";
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
  const copy = passBackErrorCopy(code);
  return copy.showCode ? `${copy.message} ${code}` : copy.message;
}

/**
 * The dialog body (docs/bulk-pass-back-and-corrections-design.md, slice 1).
 * Pure and exported for the reason `passBackCopy` / `handInAllDialogCopy`
 * are: the dialog content sits behind a Portal unmounted while closed.
 * `scope` names the class ("Period 3", "this test session"), or null for
 * every row the page shows.
 */
export function passBackAllCopy(count: number, scope: string | null): string {
  const who = `${count} student${count === 1 ? "" : "s"}`;
  const where = scope ? ` in ${scope}` : "";
  return (
    `Pass back ${who}${where}? Their answers stay; they can change them and ` +
    "hand in again. Their scores are kept as a record and each test is scored " +
    "again on the next hand-in."
  );
}

/**
 * "Pass back everyone" — the per-attempt pass back applied to the handed-in
 * attempts a page shows (POST /api/assessments/[id]/pass-back). Results sends
 * its section-filtered rows; Monitor and the Test sessions list send a
 * sitting's. Same shape as `PassBackControl`: the caller decides where it
 * sits, which ids, whether any is `timed` (then the dialog asks for one new
 * deadline), and what happens after (`onPassedBack`).
 *
 * Disabled with no ids rather than hidden, so the button's place is stable
 * and its title says why.
 */
export function PassBackAllControl({
  assessmentId,
  attemptIds,
  timed,
  scope,
  onPassedBack,
  label = "Pass back everyone",
  disabledReason,
  size = "sm",
  variant = "outline",
}: {
  assessmentId: string;
  /** The handed-in attempts to pass back, as the caller's rows say. */
  attemptIds: string[];
  /** True when any of them has a deadline (`attemptIsTimed`). */
  timed: boolean;
  scope: string | null;
  onPassedBack: () => void;
  label?: string;
  disabledReason?: string;
  size?: "xs" | "sm" | "default";
  variant?: "outline" | "ghost";
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [corrections, setCorrections] = useState<CorrectionsChoice>(NO_CORRECTIONS);

  const reason =
    disabledReason ?? (attemptIds.length === 0 ? "No handed-in tests to pass back." : undefined);

  async function confirmPassBackAll() {
    let endsAt: string | null = null;
    if (timed) {
      endsAt = toIsoInstant(value);
      if (!endsAt) {
        setError("Pick a time in the future.");
        return;
      }
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/assessments/${assessmentId}/pass-back`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          attempt_ids: attemptIds,
          ...(endsAt ? { ends_at: endsAt } : {}),
          ...correctionsBody(corrections),
        }),
      });
      if (!res.ok) throw await readError(res);
      const body = (await res.json()) as { passed_back?: number };
      setStatus(`Passed back ${body.passed_back ?? 0}.`);
      setOpen(false);
      onPassedBack();
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (o) {
          setError(null);
          setStatus(null);
          setValue(defaultExtendValue());
          setCorrections(NO_CORRECTIONS);
          setOpen(true);
        } else if (!busy) setOpen(false);
      }}
    >
      <span className="inline-flex flex-col items-end gap-1">
        <DialogTrigger asChild>
          <Button
            type="button"
            variant={variant}
            size={size}
            disabled={reason !== undefined}
            title={reason}
          >
            {label}
          </Button>
        </DialogTrigger>
        {status ? (
          <span role="status" className="text-xs text-muted-foreground">
            {status}
          </span>
        ) : null}
      </span>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Pass back everyone?</DialogTitle>
          <DialogDescription>{passBackAllCopy(attemptIds.length, scope)}</DialogDescription>
        </DialogHeader>
        {timed ? (
          <label className="text-sm">
            <span className="block text-xs text-muted-foreground">New deadline</span>
            <input
              type="datetime-local"
              value={value}
              disabled={busy}
              onChange={(e) => setValue(e.target.value)}
              aria-label="New deadline"
              className="mt-0.5 w-full rounded-md border border-border bg-transparent px-2 py-1 text-sm"
            />
            <span className="mt-1 block text-xs text-muted-foreground">
              This test has a time limit — pick when it ends now, for everyone.
            </span>
          </label>
        ) : null}
        <CorrectionsOptions value={corrections} onChange={setCorrections} disabled={busy} />
        {error ? (
          <p role="alert" className="text-sm text-danger-foreground">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={busy}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void confirmPassBackAll()} disabled={busy}>
            {busy ? "Passing back…" : "Pass back"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

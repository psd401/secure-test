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
import { NO_SECTION } from "@/lib/scoring/sectionFilter";
import { passBackAllCopy } from "@/components/app/PassBackAllControl";
import {
  defaultExtendValue,
  toIsoInstant,
} from "@/components/app/ExtendTimeControl";

export interface PassBackSectionOption {
  section: string;
  handed_in: number;
  timed: boolean;
}

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

/** A picker option's text: "Period 3 — 24 handed in". Pure for the tests. */
export function sectionOptionLabel(o: PassBackSectionOption): string {
  const name = o.section === NO_SECTION ? "No section" : o.section;
  return `${name} — ${o.handed_in} handed in`;
}

/**
 * "Pass back a class…" on the Test sessions list
 * (docs/bulk-pass-back-and-corrections-design.md, slice 1, 4.1): choose a
 * section, then pass back everyone in it who handed in. The sections and
 * counts come from GET /api/assessments/[id]/pass-back when the dialog opens
 * (the Results filter's own sections, so the two surfaces agree), and the
 * POST sends the section, not ids — the server resolves it again.
 */
export function PassBackSectionControl({
  assessmentId,
  onPassedBack,
  size = "sm",
}: {
  assessmentId: string;
  onPassedBack: () => void;
  size?: "xs" | "sm" | "default";
}) {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<PassBackSectionOption[] | null>(null);
  const [section, setSection] = useState("");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [corrections, setCorrections] = useState<CorrectionsChoice>(NO_CORRECTIONS);

  const chosen = options?.find((o) => o.section === section) ?? null;

  async function loadOptions() {
    setOptions(null);
    try {
      const res = await fetch(`/api/assessments/${assessmentId}/pass-back`);
      if (!res.ok) throw await readError(res);
      const body = (await res.json()) as { sections: PassBackSectionOption[] };
      setOptions(body.sections);
      setSection(body.sections[0]?.section ?? "");
    } catch (err) {
      setOptions([]);
      setError(describe(err));
    }
  }

  async function confirm() {
    if (!chosen) return;
    let endsAt: string | null = null;
    if (chosen.timed) {
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
          section: chosen.section,
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
          void loadOptions();
        } else if (!busy) setOpen(false);
      }}
    >
      <span className="inline-flex flex-col items-end gap-1">
        <DialogTrigger asChild>
          <Button type="button" variant="outline" size={size}>
            Pass back a class…
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
          <DialogTitle>Pass back a class</DialogTitle>
          <DialogDescription>
            {chosen
              ? passBackAllCopy(
                  chosen.handed_in,
                  chosen.section === NO_SECTION ? "no section" : chosen.section,
                )
              : "Choose a class section. Everyone in it who handed in gets their test back."}
          </DialogDescription>
        </DialogHeader>
        {options === null ? (
          <p className="text-sm text-muted-foreground">Loading sections…</p>
        ) : options.length === 0 ? (
          error ? null : (
            <p className="text-sm text-muted-foreground">No handed-in tests to pass back.</p>
          )
        ) : (
          <label className="text-sm">
            <span className="block text-xs text-muted-foreground">Section</span>
            <select
              value={section}
              disabled={busy}
              onChange={(e) => setSection(e.target.value)}
              aria-label="Section"
              className="mt-0.5 w-full rounded-md border border-border bg-transparent px-2 py-1 text-sm"
            >
              {options.map((o) => (
                <option key={o.section} value={o.section}>
                  {sectionOptionLabel(o)}
                </option>
              ))}
            </select>
          </label>
        )}
        {chosen?.timed ? (
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
        {chosen ? (
          <CorrectionsOptions value={corrections} onChange={setCorrections} disabled={busy} />
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-danger-foreground">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={busy}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void confirm()} disabled={busy || !chosen}>
            {busy ? "Passing back…" : "Pass back"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

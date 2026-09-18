"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatDate } from "@/lib/ui/format";
import { ApiError, coTeachErrorCopy } from "@/lib/ui/errorCopy";

interface ShareRow {
  id: string;
  recipient_email: string;
  created_at: string;
  accepted_at: string | null;
}

interface GrantRow {
  id: string;
  grantee_email: string;
  level: "view" | "run" | "edit" | "own";
  note: string | null;
  created_at: string;
}

interface CoTeachSection {
  course_name: string;
  period_expression: string;
}

interface Suggestion {
  email: string;
  sections: CoTeachSection[];
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

/** "Algebra 1 · 3(A)", or the bare course name when the roster has no period
 * (blank `period_expression`). Exported for a direct pure-function test. */
export function sectionLabel(s: CoTeachSection): string {
  return s.period_expression ? `${s.course_name} · ${s.period_expression}` : s.course_name;
}

/**
 * Slice C (2026-09-01) gave this dialog its "Send a copy" mode: the
 * colleague gets their own copy to edit and run, nothing here changes who
 * owns this assessment. Access slice 3 (docs/access-model-design.md, D-4
 * (b)) adds a second mode, Co-teach: an `edit`-level `access_grants` row on
 * THIS assessment, so the colleague edits and runs it in place rather than
 * getting a copy. Only the owner opens this dialog (the caller gates the
 * Share button on `own`), so nothing here gates itself a second time.
 */
export function ShareDialog({
  assessmentId,
  open,
  onOpenChange,
}: {
  assessmentId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const base = `/api/assessments/${assessmentId}/shares`;
  const grantsBase = `/api/assessments/${assessmentId}/grants`;
  const [email, setEmail] = useState("");
  const [shares, setShares] = useState<ShareRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [coTeachers, setCoTeachers] = useState<GrantRow[]>([]);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [coTeachEmail, setCoTeachEmail] = useState("");
  const [coTeachBusy, setCoTeachBusy] = useState<string | null>(null); // the email in flight, or "manual"
  const [coTeachError, setCoTeachError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setError(null);
    fetch(base)
      .then(async (res) => {
        const body = (await res.json().catch(() => null)) as { shares?: ShareRow[] } | null;
        if (!res.ok || !body?.shares) throw new Error(`HTTP ${res.status}`);
        if (!cancelled) setShares(body.shares);
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [open, base]);

  async function loadCoTeaching() {
    setCoTeachError(null);
    try {
      const [grantsRes, suggestionsRes] = await Promise.all([
        fetch(grantsBase),
        fetch(`${grantsBase}/suggestions`),
      ]);
      if (!grantsRes.ok) throw await readError(grantsRes);
      if (!suggestionsRes.ok) throw await readError(suggestionsRes);
      const grantsBody = (await grantsRes.json()) as { grants: GrantRow[] };
      const suggestionsBody = (await suggestionsRes.json()) as { suggestions: Suggestion[] };
      // Co-teach only ever writes `edit`; `view` / `run` grants belong to a
      // different feature (substitute / principal) with no UI here yet.
      setCoTeachers(grantsBody.grants.filter((g) => g.level === "edit" || g.level === "own"));
      setSuggestions(suggestionsBody.suggestions);
    } catch (e) {
      setCoTeachError(coTeachErrorCopy(e instanceof ApiError ? e.code : "network").message);
    }
  }

  useEffect(() => {
    if (!open) return;
    void loadCoTeaching();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, grantsBase]);

  async function share() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(base, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const body = (await res.json().catch(() => null)) as
        | { ok: boolean; share?: ShareRow; hint?: string; error?: string }
        | null;
      if (!res.ok || !body?.ok || !body.share) {
        throw new Error(body?.hint ?? body?.error ?? `HTTP ${res.status}`);
      }
      setShares((prev) => [body.share!, ...prev]);
      setEmail("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${base}/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setShares((prev) => prev.filter((s) => s.id !== id));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function coTeach(grantee: string, key: string) {
    const target = grantee.trim().toLowerCase();
    if (!target) return;
    setCoTeachBusy(key);
    setCoTeachError(null);
    try {
      const res = await fetch(grantsBase, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ grantee_email: target, level: "edit", note: "co-teacher" }),
      });
      if (!res.ok) throw await readError(res);
      await loadCoTeaching();
      if (key === "manual") setCoTeachEmail("");
    } catch (e) {
      setCoTeachError(coTeachErrorCopy(e instanceof ApiError ? e.code : "network").message);
    } finally {
      setCoTeachBusy(null);
    }
  }

  async function removeCoTeacher(id: string) {
    setCoTeachBusy(id);
    setCoTeachError(null);
    try {
      const res = await fetch(`${grantsBase}/${id}`, { method: "DELETE" });
      if (!res.ok) throw await readError(res);
      await loadCoTeaching();
    } catch (e) {
      setCoTeachError(coTeachErrorCopy(e instanceof ApiError ? e.code : "network").message);
    } finally {
      setCoTeachBusy(null);
    }
  }

  const coTeacherEmails = new Set(coTeachers.map((g) => g.grantee_email));
  const openSuggestions = suggestions.filter((s) => !coTeacherEmails.has(s.email));

  return (
    <Dialog open={open} onOpenChange={(o) => (!busy && !coTeachBusy ? onOpenChange(o) : null)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Share this assessment</DialogTitle>
        </DialogHeader>

        <section className="space-y-3">
          <div>
            <h3 className="text-sm font-semibold">Send a copy</h3>
            <DialogDescription>
              They get their own copy to edit and run. Your assessment stays yours; later
              changes are not synced.
            </DialogDescription>
          </div>
          <form
            className="flex items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (email.trim().length > 0) void share();
            }}
          >
            <div className="flex-1">
              <Label htmlFor="share-email">Colleague&apos;s district email</Label>
              <Input
                id="share-email"
                type="email"
                autoComplete="off"
                placeholder="name@psd401.net"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={busy}
              />
            </div>
            <Button type="submit" disabled={busy || email.trim().length === 0}>
              Share
            </Button>
          </form>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          {shares.length > 0 ? (
            <ul className="divide-y rounded-md border text-sm">
              {shares.map((s) => (
                <li key={s.id} className="flex items-center justify-between gap-3 px-3 py-2">
                  <div className="min-w-0">
                    <div className="truncate font-medium">{s.recipient_email}</div>
                    <div className="text-xs text-muted-foreground">
                      {s.accepted_at
                        ? `Added their copy ${formatDate(s.accepted_at)}`
                        : `Shared ${formatDate(s.created_at)} · not added yet`}
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => void revoke(s.id)}
                    disabled={busy}
                  >
                    {s.accepted_at ? "Remove" : "Withdraw"}
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">Not shared with anyone yet.</p>
          )}
        </section>

        <section className="space-y-3 border-t border-border pt-4">
          <div>
            <h3 className="text-sm font-semibold">Co-teach</h3>
            <DialogDescription>
              A co-teacher edits this assessment with you, runs test sessions on their own
              sections, and sees every result. You stay the owner.
            </DialogDescription>
          </div>

          {openSuggestions.length > 0 ? (
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground">From your roster</p>
              <ul className="divide-y rounded-md border text-sm">
                {openSuggestions.map((s) => (
                  <li key={s.email} className="flex items-center justify-between gap-3 px-3 py-2">
                    <div className="min-w-0">
                      <div className="truncate font-medium">{s.email}</div>
                      <div className="truncate text-xs text-muted-foreground">
                        {s.sections.map(sectionLabel).join(" · ")}
                      </div>
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => void coTeach(s.email, s.email)}
                      disabled={coTeachBusy !== null}
                    >
                      {coTeachBusy === s.email ? "Adding…" : "Co-teach"}
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <form
            className="flex items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (coTeachEmail.trim().length > 0) void coTeach(coTeachEmail, "manual");
            }}
          >
            <div className="flex-1">
              <Label htmlFor="co-teach-email">Or enter a staff email</Label>
              <Input
                id="co-teach-email"
                type="email"
                autoComplete="off"
                placeholder="name@psd401.net"
                value={coTeachEmail}
                onChange={(e) => setCoTeachEmail(e.target.value)}
                disabled={coTeachBusy !== null}
              />
            </div>
            <Button
              type="submit"
              variant="outline"
              disabled={coTeachBusy !== null || coTeachEmail.trim().length === 0}
            >
              {coTeachBusy === "manual" ? "Adding…" : "Co-teach"}
            </Button>
          </form>

          {coTeachError ? <p className="text-sm text-destructive">{coTeachError}</p> : null}

          {coTeachers.length > 0 ? (
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground">Current co-teachers</p>
              <ul className="divide-y rounded-md border text-sm">
                {coTeachers.map((g) => (
                  <li key={g.id} className="flex items-center justify-between gap-3 px-3 py-2">
                    <div className="min-w-0 truncate font-medium">{g.grantee_email}</div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => void removeCoTeacher(g.id)}
                      disabled={coTeachBusy !== null}
                    >
                      {coTeachBusy === g.id ? "Removing…" : "Remove"}
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No co-teachers yet.</p>
          )}
        </section>

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={busy || coTeachBusy !== null}
          >
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

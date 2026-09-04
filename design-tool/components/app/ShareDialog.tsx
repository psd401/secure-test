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

interface ShareRow {
  id: string;
  recipient_email: string;
  created_at: string;
  accepted_at: string | null;
}

/**
 * Slice C (2026-09-01): share an assessment with a colleague. The colleague
 * gets an offer on their dashboard and adds their own copy; nothing here
 * changes who owns this assessment.
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
  const [email, setEmail] = useState("");
  const [shares, setShares] = useState<ShareRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  return (
    <Dialog open={open} onOpenChange={(o) => (!busy ? onOpenChange(o) : null)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Share with a colleague</DialogTitle>
          <DialogDescription>
            They get their own copy to edit and run. Your assessment stays yours; later
            changes are not synced.
          </DialogDescription>
        </DialogHeader>
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
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { DialogDescription } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatDate } from "@/lib/ui/format";
import { ApiError, coTeachErrorCopy } from "@/lib/ui/errorCopy";

interface ScorerGrant {
  id: string;
  grantee_email: string;
  level: string;
  ends_at: string | null;
}

/**
 * The end of the chosen day in the browser's time zone, as an ISO instant —
 * a scorer picked "through Friday" keeps access all of Friday. Null when the
 * input is empty or not a date. Exported for a direct pure-function test.
 */
export function scoringEndsAt(day: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const end = new Date(`${day}T23:59:59`);
  return Number.isNaN(end.getTime()) ? null : end.toISOString();
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

/**
 * Scorers on a competency assessment (docs/competency-assessment-design.md,
 * slice 5b, D-12): Assessment gives a content-area teacher a `score` grant —
 * the review queue and the scoring actions, not the items or settings — for
 * one scoring window. The window is required: a scorer's access ends on its
 * own, like a substitute's. Shown only on a district assessment, inside the
 * owner-only Share dialog, so nothing here gates itself again.
 */
export function ScorersSection({ assessmentId }: { assessmentId: string }) {
  const grantsBase = `/api/assessments/${assessmentId}/grants`;
  const [scorers, setScorers] = useState<ScorerGrant[]>([]);
  const [email, setEmail] = useState("");
  const [until, setUntil] = useState("");
  const [busy, setBusy] = useState<string | null>(null); // grant id in flight, or "add"
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      const res = await fetch(grantsBase);
      if (!res.ok) throw await readError(res);
      const body = (await res.json()) as { grants: ScorerGrant[] };
      setScorers(body.grants.filter((g) => g.level === "score"));
    } catch (e) {
      setError(coTeachErrorCopy(e instanceof ApiError ? e.code : "network").message);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grantsBase]);

  async function add() {
    const target = email.trim().toLowerCase();
    const endsAt = scoringEndsAt(until);
    if (!target || !endsAt) return;
    setBusy("add");
    setError(null);
    try {
      const res = await fetch(grantsBase, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ grantee_email: target, level: "score", ends_at: endsAt, note: "scorer" }),
      });
      if (!res.ok) throw await readError(res);
      await load();
      setEmail("");
      setUntil("");
    } catch (e) {
      setError(coTeachErrorCopy(e instanceof ApiError ? e.code : "network").message);
    } finally {
      setBusy(null);
    }
  }

  async function remove(id: string) {
    setBusy(id);
    setError(null);
    try {
      const res = await fetch(`${grantsBase}/${id}`, { method: "DELETE" });
      if (!res.ok) throw await readError(res);
      await load();
    } catch (e) {
      setError(coTeachErrorCopy(e instanceof ApiError ? e.code : "network").message);
    } finally {
      setBusy(null);
    }
  }

  const canAdd = email.trim().length > 0 && scoringEndsAt(until) !== null;

  return (
    <section className="space-y-3 border-t border-border pt-4">
      <div>
        <h3 className="text-sm font-semibold">Scorers</h3>
        <DialogDescription>
          A scorer reads and scores the responses until the date you pick. They cannot change the
          questions or settings, or pass work back.
        </DialogDescription>
      </div>

      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (canAdd) void add();
        }}
      >
        <div className="min-w-48 flex-1">
          <Label htmlFor="scorer-email">Staff email</Label>
          <Input
            id="scorer-email"
            type="email"
            autoComplete="off"
            placeholder="name@psd401.net"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={busy !== null}
          />
        </div>
        <div>
          <Label htmlFor="scorer-until">Scoring through</Label>
          <Input
            id="scorer-until"
            type="date"
            value={until}
            onChange={(e) => setUntil(e.target.value)}
            disabled={busy !== null}
          />
        </div>
        <Button type="submit" variant="outline" disabled={busy !== null || !canAdd}>
          {busy === "add" ? "Adding…" : "Add scorer"}
        </Button>
      </form>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {scorers.length > 0 ? (
        <ul className="divide-y rounded-md border text-sm">
          {scorers.map((g) => (
            <li key={g.id} className="flex items-center justify-between gap-3 px-3 py-2">
              <div className="min-w-0">
                <div className="truncate font-medium">{g.grantee_email}</div>
                {g.ends_at ? (
                  <div className="text-xs text-muted-foreground">Through {formatDate(g.ends_at)}</div>
                ) : null}
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => void remove(g.id)}
                disabled={busy !== null}
              >
                {busy === g.id ? "Removing…" : "Remove"}
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">No scorers yet.</p>
      )}
    </section>
  );
}

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
import {
  REASON_MAX,
  changeScoreErrorMessage,
  nowLine,
  parsePoints,
  pointsStep,
} from "@/lib/scoring/changeScoreDialog";

export interface ChangeScoreRubric {
  criteria: Array<{
    id: string;
    name: string;
    levels: Array<{
      id: string;
      label: string;
      points: number;
      descriptor?: string;
    }>;
  }>;
}

/**
 * "Change" beside a final score (docs/change-score-design.md, slice 2): opens
 * a dialog with the current score, a points input (or, for a rubric item, the
 * criterion pickers — the same shape the review queue posts), an optional
 * reason, and Save → `POST /api/responses/[id]/change-score`. The caller says
 * what happens on success (`onChanged`). `rubric` is the item's SCORING view
 * (single-point rubrics already expanded to below / meets / exceeds ids).
 */
export function ChangeScoreControl({
  responseId,
  questionLabel,
  score,
  maxPoints,
  rubric,
  initialPicks,
  onChanged,
}: {
  responseId: string;
  questionLabel: string;
  score: { points: number; max_points: number; method: string };
  maxPoints: number;
  rubric: ChangeScoreRubric | null;
  initialPicks?: Record<string, string>;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [raw, setRaw] = useState("");
  const [picks, setPicks] = useState<Record<string, string>>({});
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function openDialog() {
    setError(null);
    setReason("");
    setRaw(String(score.points));
    setPicks(initialPicks ?? {});
    setOpen(true);
  }

  const rubricComplete =
    rubric !== null && rubric.criteria.every((c) => picks[c.id]);
  const rubricTotal = rubric
    ? rubric.criteria.reduce(
        (sum, c) =>
          sum + (c.levels.find((l) => l.id === picks[c.id])?.points ?? 0),
        0,
      )
    : 0;

  async function save() {
    let body: Record<string, unknown>;
    if (rubric) {
      if (!rubricComplete) {
        setError("Pick a level for every criterion.");
        return;
      }
      body = {
        points: rubricTotal,
        max_points: maxPoints,
        criterion_scores: rubric.criteria.map((c) => {
          const level = c.levels.find((l) => l.id === picks[c.id])!;
          return {
            criterion_id: c.id,
            level_id: level.id,
            points: level.points,
            rationale: "",
          };
        }),
      };
    } else {
      const parsed = parsePoints(raw, maxPoints);
      if (!parsed.ok) {
        setError(parsed.error);
        return;
      }
      body = { points: parsed.points, max_points: maxPoints };
    }
    const trimmedReason = reason.trim();
    if (trimmedReason) body.reason = trimmedReason;

    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/responses/${responseId}/change-score`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        let code = `http_${res.status}`;
        try {
          const j = (await res.json()) as { error?: unknown };
          if (typeof j.error === "string") code = j.error;
        } catch {
          // not JSON
        }
        setError(changeScoreErrorMessage(res.status === 404 ? "not_found" : code));
        return;
      }
      setOpen(false);
      onChanged();
    } catch {
      setError(changeScoreErrorMessage("network"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button type="button" variant="outline" size="xs" onClick={openDialog}>
        Change
      </Button>
      <Dialog
        open={open}
        onOpenChange={(o) => {
          if (!o && !busy) setOpen(false);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Change {questionLabel} score</DialogTitle>
            <DialogDescription>{nowLine(score)}</DialogDescription>
          </DialogHeader>
          {rubric ? (
            <div className="space-y-2">
              {rubric.criteria.map((c) => (
                <div key={c.id}>
                  <span className="text-xs font-medium">{c.name}</span>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {c.levels.map((l) => (
                      <button
                        key={l.id}
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          setPicks((prev) => ({ ...prev, [c.id]: l.id }))
                        }
                        className={`rounded border px-2 py-1 text-xs ${
                          picks[c.id] === l.id
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-border hover:bg-accent"
                        }`}
                        title={l.descriptor ?? ""}
                      >
                        {l.label} ({l.points})
                      </button>
                    ))}
                  </div>
                </div>
              ))}
              <p className="text-xs text-muted-foreground">
                Total: {rubricTotal} / {maxPoints}
              </p>
            </div>
          ) : (
            <label className="text-sm">
              <span className="block text-xs text-muted-foreground">
                Points (of {maxPoints})
              </span>
              <input
                type="number"
                min={0}
                max={maxPoints}
                step={pointsStep(maxPoints)}
                value={raw}
                disabled={busy}
                onChange={(e) => setRaw(e.target.value)}
                aria-label="Points"
                className="mt-0.5 w-24 rounded-md border border-border bg-transparent px-2 py-1 text-sm"
              />
            </label>
          )}
          <label className="text-sm">
            <span className="block text-xs text-muted-foreground">Reason</span>
            <input
              type="text"
              value={reason}
              maxLength={REASON_MAX}
              disabled={busy}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Optional — e.g. rubric misread"
              aria-label="Reason"
              className="mt-0.5 w-full rounded-md border border-border bg-transparent px-2 py-1 text-sm"
            />
          </label>
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
            <Button type="button" onClick={() => void save()} disabled={busy}>
              {busy ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

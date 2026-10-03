"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ClaimCitations } from "@/components/app/ClaimCitations";
import { ClassInsightsChat } from "@/components/app/ClassInsightsChat";
import { Textarea } from "@/components/ui/textarea";
import {
  INTRO_LINE,
  SECTION_HEADINGS,
  SECTION_ORDER,
  WRITTEN_BY_AI,
  insightsErrorCopy,
  ratingMessage,
  reportCopyText,
  sectionParam,
  type PanelReport,
} from "@/lib/insights/panelCopy";

type Load =
  | { kind: "loading" }
  | { kind: "none" }
  | { kind: "report"; report: PanelReport }
  | { kind: "failed"; message: string };

interface Payload {
  ok?: boolean;
  error?: string;
  sections?: PanelReport["sections"];
  stale?: boolean;
  note?: string | null;
  created_at?: string;
  prompt_version?: string;
}

function toReport(p: Payload): PanelReport | null {
  if (!p.ok || !p.sections) return null;
  return {
    sections: p.sections,
    stale: !!p.stale,
    note: p.note ?? null,
    created_at: p.created_at ?? "",
    prompt_version: p.prompt_version ?? "",
  };
}

/**
 * Class insights slice 3 (docs/class-insights-design.md): the report on the
 * results page for the page's current section filter. `view` reads the stored
 * report; `edit` can also write / regenerate it. Names arrive already swapped
 * in by the route; Q labels link to the matrix column, names to the
 * per-student page.
 */
export function ClassInsightsPanel({
  assessmentId,
  section,
  canGenerate,
}: {
  assessmentId: string;
  /** The page's `?section=` value; "" = all sections. */
  section: string;
  canGenerate: boolean;
}) {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endpoint = `/api/assessments/${assessmentId}/class-insights`;

  useEffect(() => {
    let live = true;
    setLoad({ kind: "loading" });
    fetch(`${endpoint}?section=${encodeURIComponent(sectionParam(section))}`)
      .then(async (res) => {
        const body = (await res.json().catch(() => null)) as Payload | null;
        if (!live) return;
        const report = body ? toReport(body) : null;
        if (report) setLoad({ kind: "report", report });
        else if (res.status === 404) setLoad({ kind: "none" });
        else setLoad({ kind: "failed", message: insightsErrorCopy(body?.error ?? "") });
      })
      .catch(() => live && setLoad({ kind: "failed", message: insightsErrorCopy("network") }));
    return () => {
      live = false;
    };
  }, [endpoint, section]);

  async function generate() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ section: sectionParam(section) }),
      });
      const body = (await res.json().catch(() => null)) as Payload | null;
      const report = body ? toReport(body) : null;
      if (report) setLoad({ kind: "report", report });
      else setError(insightsErrorCopy(body?.error ?? `http_${res.status}`));
    } catch {
      setError(insightsErrorCopy("network"));
    } finally {
      setBusy(false);
    }
  }

  const generateButton = (label: string) =>
    canGenerate ? (
      <Button type="button" size="sm" onClick={() => void generate()} disabled={busy}>
        {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
        {busy ? "Writing…" : label}
      </Button>
    ) : null;

  return (
    <section className="mt-12" aria-labelledby="class-insights">
      <h2 id="class-insights" className="text-lg font-semibold">
        Class insights
      </h2>

      {load.kind === "loading" ? (
        <p className="mt-2 text-sm text-muted-foreground" role="status">
          Loading…
        </p>
      ) : null}

      {load.kind === "failed" ? (
        <p className="mt-2 text-sm text-destructive" role="alert">
          {load.message}
        </p>
      ) : null}

      {load.kind === "none" ? (
        <div className="mt-2 space-y-3">
          {canGenerate ? (
            <>
              <p className="text-sm text-muted-foreground">{INTRO_LINE}</p>
              {generateButton("Write class insights")}
            </>
          ) : (
            <p className="text-sm text-muted-foreground">No class insights yet.</p>
          )}
        </div>
      ) : null}

      {load.kind === "report" ? (
        <ReportView
          assessmentId={assessmentId}
          report={load.report}
          action={
            <>
              {load.report.stale ? (
                <p className="text-sm">
                  Results have changed since this was written
                  {canGenerate ? " — Regenerate." : "."}
                </p>
              ) : null}
              {generateButton("Regenerate")}
            </>
          }
        />
      ) : null}

      {error ? (
        <p className="mt-2 text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}

      {/* The chat works without a report (it reads the same scores), so it
          shows whenever the viewer is at edit and the page has rows; keyed by
          section so a filter change starts that section's thread fresh. */}
      {canGenerate ? (
        <ClassInsightsChat key={section} assessmentId={assessmentId} section={section} />
      ) : null}
    </section>
  );
}

function ReportView({
  assessmentId,
  report,
  action,
}: {
  assessmentId: string;
  report: PanelReport;
  action: React.ReactNode;
}) {
  const [copied, setCopied] = useState<"idle" | "ok" | "failed">("idle");
  const written = report.created_at ? new Date(report.created_at).toLocaleString() : "";

  // A regenerate replaces the report; a copy confirmation about the old one
  // would be stale.
  useEffect(() => setCopied("idle"), [report.created_at]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(reportCopyText(report.sections));
      setCopied("ok");
    } catch {
      setCopied("failed");
    }
  }

  return (
    <div className="mt-2 space-y-4">
      <p className="text-xs text-muted-foreground">
        {WRITTEN_BY_AI}
        {written ? ` Written ${written}.` : ""}
      </p>
      {report.note ? <p className="text-sm">{report.note}</p> : null}
      <div className="flex flex-wrap items-center gap-3">
        {action}
        <Button type="button" variant="outline" size="sm" onClick={() => void copy()}>
          Copy
        </Button>
        <span role="status" aria-live="polite" className="text-sm text-muted-foreground">
          {copied === "ok"
            ? "Copied"
            : copied === "failed"
              ? "Could not copy. Select the text and copy it by hand."
              : ""}
        </span>
      </div>
      {SECTION_ORDER.map((s) =>
        report.sections[s].length === 0 ? null : (
          <div key={s}>
            <h3 className="text-sm font-semibold">{SECTION_HEADINGS[s]}</h3>
            <ul className="mt-1 list-disc space-y-2 pl-5 text-sm">
              {report.sections[s].map((claim, i) => (
                <li key={i}>
                  {claim.text}
                  <ClaimCitations assessmentId={assessmentId} claim={claim} />
                </li>
              ))}
            </ul>
          </div>
        ),
      )}
      <Rating assessmentId={assessmentId} promptVersion={report.prompt_version} />
    </div>
  );
}

function Rating({ assessmentId, promptVersion }: { assessmentId: string; promptVersion: string }) {
  const [comment, setComment] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "failed">("idle");

  async function send(helpful: boolean) {
    setState("sending");
    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: ratingMessage({ helpful, assessmentId, promptVersion, comment }),
          path: `/dashboard/${assessmentId}/results`,
          // No email per click; a rating with a comment is worth one.
          quiet: comment.trim() === "",
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setState("sent");
    } catch {
      setState("failed");
    }
  }

  if (state === "sent") {
    return <p className="text-sm text-muted-foreground">Thanks for the rating.</p>;
  }
  return (
    <div className="space-y-2 border-t border-border pt-3">
      <label htmlFor="insights-rating-comment" className="text-sm">
        Was this report helpful?
      </label>
      <Textarea
        id="insights-rating-comment"
        value={comment}
        maxLength={1500}
        onChange={(e) => setComment(e.target.value)}
        placeholder="Optional: what was useful or wrong?"
        rows={2}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" disabled={state === "sending"} onClick={() => void send(true)}>
          Helpful
        </Button>
        <Button type="button" variant="outline" size="sm" disabled={state === "sending"} onClick={() => void send(false)}>
          Not helpful
        </Button>
        {state === "failed" ? (
          <span role="alert" className="text-sm text-destructive">
            Could not send. Try again.
          </span>
        ) : null}
      </div>
    </div>
  );
}

"use client";

import { useEffect, useState } from "react";
import type { AccommodationsPreview } from "@/lib/accommodations/preview";
import { othersLine, previewRows } from "@/lib/accommodations/previewView";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * U-16 slice 2: "Who gets what" under the Allowed checklist. Worked out on the
 * server by the delivery route's own rule. `savedKey` changes when an
 * autosave lands, which re-fetches — so a ticked box shows its effect after
 * the save, never before it.
 */
export function WhoGetsWhat({ assessmentId, savedKey }: { assessmentId: string; savedKey: string }) {
  const [preview, setPreview] = useState<AccommodationsPreview | null>(null);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError(false);
    fetch(`/api/assessments/${assessmentId}/accommodations-preview`)
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        return (await res.json()) as AccommodationsPreview;
      })
      .then((body) => {
        if (!cancelled) setPreview(body);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [assessmentId, savedKey, retry]);

  return (
    <section className="space-y-2" aria-labelledby="who-gets-what">
      <h3 id="who-gets-what" className="font-semibold">
        Who gets what
      </h3>
      <p className="text-xs text-muted-foreground">
        What each student will actually get on this test: their Students page record (and their
        co-teachers&apos;), narrowed to the tools ticked above, plus any exceptions. Updates after each save.
      </p>
      {error ? (
        <Alert variant="destructive">
          <AlertTitle>Couldn&apos;t work out who gets what.</AlertTitle>
          <AlertDescription>
            <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => setRetry((n) => n + 1)}>
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      ) : preview === null ? (
        <Skeleton className="h-16 w-full" />
      ) : (
        <PreviewList preview={preview} />
      )}
    </section>
  );
}

function PreviewList({ preview }: { preview: AccommodationsPreview }) {
  const rows = previewRows(preview);
  return (
    <div className="space-y-2">
      {rows.length === 0 ? (
        <p className="text-sm">No student gets an accommodation on this test.</p>
      ) : (
        <ul className="divide-y rounded-lg border bg-card">
          {rows.map((row) => (
            <li key={row.studentId} className="space-y-1 px-3 py-2 text-sm">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="font-medium">{row.heading}</span>
                {row.tools.length === 0 ? (
                  <span className="text-muted-foreground">Gets none</span>
                ) : (
                  row.tools.map((tool) => (
                    <span key={tool.text} className="inline-flex flex-wrap items-center gap-1">
                      <Badge variant="outline">{tool.text}</Badge>
                      {tool.exception ? <Badge variant="info">Exception</Badge> : null}
                      {tool.fromRecordOf ? (
                        <Badge variant="neutral">From {tool.fromRecordOf}&apos;s record</Badge>
                      ) : null}
                      {tool.constructAltering ? <Badge variant="warning">Changes what&apos;s measured</Badge> : null}
                    </span>
                  ))
                )}
              </div>
              {row.removedLine ? <p className="text-xs text-muted-foreground">{row.removedLine}</p> : null}
              {row.notAllowedLine ? <p className="text-xs text-muted-foreground">{row.notAllowedLine}</p> : null}
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-muted-foreground">{othersLine(preview)}</p>
    </div>
  );
}

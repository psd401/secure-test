"use client";

import { useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertTitle } from "@/components/ui/alert";

/**
 * UX pass 1, slice 4 (A-02): the student-view iframe with a skeleton until
 * it has painted and a fallback if it never does. `refreshKey` remounts the
 * frame when a save has landed (the caller derives it from persisted state,
 * never from unsaved local state — cleanup #7).
 */
export function PreviewFrame({
  src,
  refreshKey,
  title,
}: {
  src: string;
  refreshKey: string;
  title: string;
}) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);

  return (
    <div className="relative">
      {!loaded && !failed ? (
        <Skeleton className="absolute inset-0 rounded-md" aria-hidden />
      ) : null}
      {failed ? (
        <Alert variant="destructive" className="mb-3">
          <AlertTitle>The preview couldn&apos;t load. Save again or reload the page.</AlertTitle>
        </Alert>
      ) : null}
      <iframe
        key={refreshKey}
        src={src}
        sandbox="allow-same-origin"
        referrerPolicy="no-referrer"
        title={title}
        onLoad={() => setLoaded(true)}
        onError={() => setFailed(true)}
        className="h-[420px] w-full rounded-md border bg-white"
      />
    </div>
  );
}

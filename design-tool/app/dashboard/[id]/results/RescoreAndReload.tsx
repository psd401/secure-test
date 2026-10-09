"use client";

import { RescoreControl } from "@/components/app/RescoreControl";

/**
 * The results page's "Rescore with current key": reload after a rescore so
 * the server-rendered matrix shows the new scores — same reasoning as
 * `ReleaseAnswersAndReload`. The result line survives the reload through
 * sessionStorage (see `RescoreControl`).
 */
export function RescoreAndReload({
  assessmentId,
  studentsChanged,
}: {
  assessmentId: string;
  studentsChanged: number;
}) {
  return (
    <RescoreControl
      assessmentId={assessmentId}
      studentsChanged={studentsChanged}
      onDone={() => {
        window.location.reload();
      }}
    />
  );
}

"use client";

import { ReleaseAnswersControl } from "@/components/app/ReleaseAnswersControl";

/**
 * The results page's "Release answers": reload once released so the page
 * (server-rendered) picks up the stamp — same reasoning as
 * `SendToGradebookAndReload`.
 */
export function ReleaseAnswersAndReload({
  assessmentId,
  releasedAt,
}: {
  assessmentId: string;
  releasedAt: string | null;
}) {
  return (
    <ReleaseAnswersControl
      assessmentId={assessmentId}
      releasedAt={releasedAt}
      onReleased={() => {
        window.location.reload();
      }}
    />
  );
}

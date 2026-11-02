"use client";

import { PassBackAllControl } from "@/components/app/PassBackAllControl";

/**
 * The Results page's "Pass back all handed in" (roadmap U-25 slice 1): on
 * success, reload — same reasoning as `HandInInProgressAndReload` (the page is
 * server-rendered and also rendered headlessly with no router mounted).
 */
export function PassBackAllAndReload(props: {
  assessmentId: string;
  attemptIds: string[];
  timed: boolean;
  sectionLabel: string | null;
}) {
  return (
    <PassBackAllControl
      assessmentId={props.assessmentId}
      attemptIds={props.attemptIds}
      timed={props.timed}
      scope={props.sectionLabel}
      label="Pass back all handed in"
      onPassedBack={() => {
        window.location.reload();
      }}
    />
  );
}

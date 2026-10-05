"use client";

import { HandInInProgressControl } from "@/components/app/HandInInProgressControl";

/**
 * The Results page's "Hand in all in progress" (roadmap U-14): on success,
 * reload — the page is server-rendered and also rendered headlessly by
 * test/reporting-views.test.tsx with no router mounted, so a full
 * `window.location.reload()` as `HandInAttemptAndReload` does.
 */
export function HandInInProgressAndReload(props: {
  assessmentId: string;
  readyAttemptIds: string[];
  heldCount: number;
  sectionLabel: string | null;
}) {
  return (
    <HandInInProgressControl
      {...props}
      onHandedIn={() => {
        window.location.reload();
      }}
    />
  );
}

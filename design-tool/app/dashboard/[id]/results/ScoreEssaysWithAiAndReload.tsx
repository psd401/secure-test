"use client";

import { ScoreEssaysWithAiControl } from "@/components/app/ScoreEssaysWithAiControl";

/**
 * The Results page's "Score essays with AI" (roadmap U-24): when the teacher
 * closes the summary, reload — the page is server-rendered and also rendered
 * headlessly by test/reporting-views.test.tsx with no router mounted, so a
 * full `window.location.reload()` as `HandInInProgressAndReload` does.
 */
export function ScoreEssaysWithAiAndReload(props: {
  attemptIds: string[];
  essayCount: number;
  sectionLabel: string | null;
}) {
  return (
    <ScoreEssaysWithAiControl
      {...props}
      onFinished={() => {
        window.location.reload();
      }}
    />
  );
}

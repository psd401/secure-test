"use client";

import { SendToGradebookControl } from "@/components/app/SendToGradebookControl";
import type { SendDialogSection } from "@/lib/gradebook/sendDialog";

/**
 * The results page's "Send to gradebook": reload once the summary is
 * dismissed — same reasoning as `PassBackAndReload` (a full reload, not the
 * app router, so the button label picks up the new "Sent to PowerSchool").
 */
export function SendToGradebookAndReload({
  assessmentId,
  assessmentName,
  sections,
}: {
  assessmentId: string;
  assessmentName: string;
  sections: SendDialogSection[];
}) {
  return (
    <SendToGradebookControl
      assessmentId={assessmentId}
      assessmentName={assessmentName}
      sections={sections}
      onDone={() => {
        window.location.reload();
      }}
    />
  );
}

"use client";

import { HandInAttemptControl } from "@/components/app/HandInAttemptControl";

/**
 * The results matrix's and the per-student page's "Hand in": on success,
 * reload — both are server-rendered and must re-read the DB, and (like
 * `DeleteAttemptAndReturn`) the matrix page is also rendered headlessly by
 * test/reporting-views.test.tsx where no router is mounted, so a full
 * `window.location.reload()` rather than the app router.
 */
export function HandInAttemptAndReload({
  attemptId,
  studentName,
  answeredCount,
  disabledReason,
  size,
}: {
  attemptId: string;
  studentName: string;
  answeredCount: number;
  disabledReason?: string;
  size?: "sm" | "default";
}) {
  return (
    <HandInAttemptControl
      attemptId={attemptId}
      studentName={studentName}
      answeredCount={answeredCount}
      disabledReason={disabledReason}
      size={size}
      onHandedIn={() => {
        window.location.reload();
      }}
    />
  );
}

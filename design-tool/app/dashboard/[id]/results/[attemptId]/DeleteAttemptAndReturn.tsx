"use client";

import { DeleteAttemptControl } from "@/components/app/DeleteAttemptControl";

/**
 * The per-student page's Delete attempt: on success, back to the matrix. A
 * full navigation rather than the app router — the matrix is
 * server-rendered and must re-read the DB, and the page is also rendered
 * headlessly by test/reporting-views.test.tsx where no router is mounted.
 */
export function DeleteAttemptAndReturn({
  attemptId,
  assessmentId,
  studentName,
  disabledReason,
}: {
  attemptId: string;
  assessmentId: string;
  studentName: string;
  disabledReason?: string;
}) {
  return (
    <DeleteAttemptControl
      attemptId={attemptId}
      studentName={studentName}
      disabledReason={disabledReason}
      onDeleted={() => {
        window.location.assign(`/dashboard/${assessmentId}/results`);
      }}
    />
  );
}

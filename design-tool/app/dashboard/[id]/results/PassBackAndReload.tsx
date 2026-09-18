"use client";

import { PassBackControl } from "@/components/app/PassBackControl";

/**
 * The per-student page's and the Monitor's "Pass back": on success, reload —
 * same reasoning as `HandInAttemptAndReload` / `ExtendTimeAndReload`, both
 * of which this page and its headless render in test/reporting-views.test.tsx
 * need a full `window.location.reload()` rather than the app router for.
 */
export function PassBackAndReload({
  attemptId,
  studentName,
  scoreCount,
  timed,
  disabledReason,
  size,
}: {
  attemptId: string;
  studentName: string;
  scoreCount: number;
  timed: boolean;
  disabledReason?: string;
  size?: "xs" | "sm" | "default";
}) {
  return (
    <PassBackControl
      attemptId={attemptId}
      studentName={studentName}
      scoreCount={scoreCount}
      timed={timed}
      disabledReason={disabledReason}
      size={size}
      onPassedBack={() => {
        window.location.reload();
      }}
    />
  );
}

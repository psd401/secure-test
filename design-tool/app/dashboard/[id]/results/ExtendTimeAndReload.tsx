"use client";

import { ExtendTimeControl } from "@/components/app/ExtendTimeControl";

/**
 * The per-student page's "Extend time": on success, reload — same reasoning
 * as `HandInAttemptAndReload`, this server-rendered page (and its headless
 * render in test/reporting-views.test.tsx, where no router is mounted) needs
 * a full `window.location.reload()` rather than the app router.
 */
export function ExtendTimeAndReload({
  attemptId,
  deadlineAt,
}: {
  attemptId: string;
  deadlineAt?: string | Date | null;
}) {
  return (
    <ExtendTimeControl
      target={{ kind: "attempt", attemptId }}
      currentDeadlines={[deadlineAt]}
      onExtended={() => {
        window.location.reload();
      }}
    />
  );
}

"use client";

import {
  ChangeScoreControl,
  type ChangeScoreRubric,
} from "@/components/app/ChangeScoreControl";

/**
 * The per-student page's "Change" beside a final score: on success, reload —
 * the same reasoning as `PassBackAndReload` (a server-rendered page, and its
 * headless render in test/reporting-views.test.tsx, want a full reload rather
 * than the app router).
 */
export function ChangeScoreAndReload(props: {
  responseId: string;
  questionLabel: string;
  score: { points: number; max_points: number; method: string };
  maxPoints: number;
  rubric: ChangeScoreRubric | null;
  initialPicks?: Record<string, string>;
}) {
  return (
    <ChangeScoreControl
      {...props}
      onChanged={() => {
        window.location.reload();
      }}
    />
  );
}

// Plain words for competency case statuses and results
// (docs/competency-assessment-design.md). Kept out of the client components
// so server pages (the counselor list) can read them too.

export const STATUS_LABEL: Record<string, string> = {
  assigned: "Assigned",
  in_progress: "In progress",
  handed_in: "Handed in",
  scored: "Scored",
  released: "Released",
  withdrawn: "Withdrawn",
};

/** OSPI's terms. */
export const RESULT_LABEL: Record<string, string> = {
  pass: "Pass",
  needs_revision: "Needs revision",
  no_score: "No score",
};

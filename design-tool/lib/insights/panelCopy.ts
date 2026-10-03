// Class insights slice 3 (docs/class-insights-design.md): the pure, client-safe
// pieces behind the results page's "Class insights" panel — headings, error
// copy, the Copy text (D-8), the rating message. No server imports (this file
// ships to the browser), so the rendered-report shape is declared structurally.

export const SECTION_ORDER = ["strengths", "growth", "celebrations", "next_steps"] as const;
export type PanelSection = (typeof SECTION_ORDER)[number];

export const SECTION_HEADINGS: Record<PanelSection, string> = {
  strengths: "Strengths",
  growth: "Areas for growth",
  celebrations: "Celebrations",
  next_steps: "Next steps for the whole class",
};

export interface PanelClaim {
  text: string;
  citations: {
    items: Array<{ label: string; item_id: string | null }>;
    tags: Array<{ tag: string; code: string; text: string | null }>;
    students: Array<{ pseudonym: string; attempt_id: string | null; name: string }>;
  };
}

export type PanelSections = Record<PanelSection, PanelClaim[]>;

export interface PanelReport {
  sections: PanelSections;
  stale: boolean;
  note: string | null;
  created_at: string;
  prompt_version: string;
}

export const TEACHER_ONLY_LINE = "Teacher-only: names students; not for families.";
export const WRITTEN_BY_AI = "Written by AI — check it before you act on it.";
export const INTRO_LINE =
  "The AI reads this class's scores and writes strengths, areas for growth, celebrations and next steps. Check it before you act on it.";

/** The `section` the route expects for the page's `?section=` value. "" = all. */
export function sectionParam(selected: string): string {
  return selected === "" ? "__all__" : selected;
}

/** Plain-language message for a route error code. */
export function insightsErrorCopy(code: string): string {
  switch (code) {
    case "nothing_to_report":
      return "No student has a scored answer yet.";
    case "guardrail_blocked":
      return "The report was withheld by content safeguards. Try again.";
    case "provider_failed":
      return "The AI could not write a report. Try again.";
    case "network":
      return "Could not reach the server. Try again.";
    default:
      return "Something went wrong. Try again.";
  }
}

/** Anchor id of a results-matrix column header, `Q<n>`'s link target. */
export function questionAnchor(label: string): string {
  return `col-${label.toLowerCase()}`;
}

/**
 * D-8: the clipboard text — the teacher-only line, then each non-empty
 * section as a heading and "- " claims. Names are in; this never reaches a
 * page a family sees. An empty section is left out.
 */
export function reportCopyText(sections: PanelSections): string {
  const lines: string[] = [TEACHER_ONLY_LINE];
  for (const s of SECTION_ORDER) {
    const claims = sections[s] ?? [];
    if (claims.length === 0) continue;
    lines.push("", SECTION_HEADINGS[s]);
    for (const c of claims) lines.push(`- ${c.text}`);
  }
  return lines.join("\n");
}

/** The stored feedback message for a rating (rides `feedback`, no migration). */
export function ratingMessage(input: {
  helpful: boolean;
  assessmentId: string;
  promptVersion: string;
  comment: string;
}): string {
  const head =
    `class-insights rating: ${input.helpful ? "helpful" : "not helpful"}` +
    ` | assessment ${input.assessmentId} | prompt ${input.promptVersion}`;
  const comment = input.comment.trim();
  return comment ? `${head}\n${comment}` : head;
}

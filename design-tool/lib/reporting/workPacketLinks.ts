import { NO_SECTION } from "@/lib/scoring/sectionFilter";

/**
 * Batch print 9.3 (docs/batch-print-design.md): the results page's "Print
 * student work" carries its section filter, so a teacher reading one class
 * lands on that class's packet. "All sections" and "No section" land on the
 * chooser — the packet prints by section, and no-section work is in none.
 */
export function workPacketHref(assessmentId: string, resultsSection: string): string {
  const base = `/dashboard/${assessmentId}/results/work`;
  if (resultsSection === "" || resultsSection === NO_SECTION) return base;
  return `${base}?section=${encodeURIComponent(resultsSection)}`;
}

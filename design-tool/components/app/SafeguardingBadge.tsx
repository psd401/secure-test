import { AlertTriangle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { badgeLabel } from "@/lib/safeguarding/alertView";

/**
 * Safeguarding alerts slice 2 (docs/safeguarding-alerts-design.md): the red
 * "Needs attention" marker on a results row, a Monitor row, a queue card and
 * an assessment on the home list. The `danger` tint and the warning icon are
 * the ones the Monitor's own "Needs attention" state already uses — one
 * meaning, one look — and the icon + word mean colour never carries it alone.
 *
 * Renders nothing for a count of 0, so callers can pass the number through
 * without a guard. `title` is the fuller wording for a hover / screen reader.
 */
export function SafeguardingBadge({
  count,
  title = "A safeguarding check flagged an answer. Open the student's results to read it.",
}: {
  count: number;
  title?: string;
}) {
  const label = badgeLabel(count);
  if (!label) return null;
  return (
    <Badge variant="danger" title={title} data-safeguarding-badge="">
      <AlertTriangle aria-hidden />
      {label}
    </Badge>
  );
}

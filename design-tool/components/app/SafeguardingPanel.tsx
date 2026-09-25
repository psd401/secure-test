import { AlertTriangle } from "lucide-react";
import { AcknowledgeAlertButton } from "@/components/app/AcknowledgeAlertButton";
import { ALERT_DISCLAIMER, alertHeading, isOpenAlert } from "@/lib/safeguarding/alertView";
import { formatDateTime } from "@/lib/ui/format";

/** One alert as the per-student panel draws it. */
export interface PanelAlert {
  id: string;
  category: string;
  evidence: string;
  created_at: string | Date;
  acknowledged_at: string | Date | null;
  acknowledged_by_email: string | null;
  /** 0-based item position, or null when the item has since been removed. */
  item_position: number | null;
  /** The page anchor of that answer, or null when there is none to link to. */
  answer_anchor: string | null;
}

/**
 * Safeguarding alerts slice 2 (docs/safeguarding-alerts-design.md): the panel
 * at the top of a student's results page, one card per alert — open ones
 * with Acknowledge, acknowledged ones saying who and when. The evidence is
 * the one sentence the check quoted; the whole answer is a link away, on the
 * same page, so the teacher reads it in context rather than on the card.
 *
 * Renders nothing when there are no alerts. `canAcknowledge` is false only
 * for a system admin reading another teacher's page: the admin sees the
 * alert, the teacher keeps the decision (access-model D-6).
 */
export function SafeguardingPanel({
  alerts,
  canAcknowledge = true,
}: {
  alerts: PanelAlert[];
  /** False for a system admin reading another teacher's page (access-model D-6). */
  canAcknowledge?: boolean;
}) {
  if (alerts.length === 0) return null;
  return (
    <section
      aria-labelledby="safeguarding"
      className="space-y-3 rounded-lg border border-danger-foreground/40 bg-danger p-4"
    >
      <h2
        id="safeguarding"
        className="flex items-center gap-2 text-lg font-semibold text-danger-foreground"
      >
        <AlertTriangle aria-hidden className="size-5" />
        Needs attention
      </h2>
      <ul className="space-y-3">
        {alerts.map((alert) => {
          const question =
            alert.item_position === null ? null : `Q${alert.item_position + 1}`;
          return (
            <li key={alert.id} className="rounded-md border border-border bg-background p-3">
              <h3 className="text-sm font-semibold">{alertHeading(alert.category)}</h3>
              {alert.evidence ? (
                <blockquote className="mt-2 whitespace-pre-wrap rounded bg-muted p-2 text-sm">
                  {alert.evidence}
                </blockquote>
              ) : null}
              <p className="mt-2 text-xs text-muted-foreground">
                {question ? (
                  <>
                    From{" "}
                    {alert.answer_anchor ? (
                      <a href={`#${alert.answer_anchor}`} className="underline">
                        {question}
                      </a>
                    ) : (
                      question
                    )}{" "}
                    ·{" "}
                  </>
                ) : null}
                Flagged automatically on {formatDateTime(alert.created_at)}
              </p>
              <div className="mt-2">
                {isOpenAlert(alert) ? (
                  canAcknowledge ? (
                    <AcknowledgeAlertButton alertId={alert.id} />
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      Not acknowledged yet by the teacher.
                    </p>
                  )
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Acknowledged by {alert.acknowledged_by_email ?? "a teacher"} on{" "}
                    {formatDateTime(alert.acknowledged_at!)}
                  </p>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      <p className="text-xs text-muted-foreground">{ALERT_DISCLAIMER}</p>
    </section>
  );
}

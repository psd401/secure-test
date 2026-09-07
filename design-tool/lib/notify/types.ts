// NotifyPublisher is the contract for the outbound-notification channel
// (docs/observability-design.md, D-2/D-9: one SNS topic, feedback + alarms,
// James filters by subject). Mirrors lib/storage's provider shape: one small
// interface, one id per implementation, selected by env.

export interface NotifyPublisher {
  /** Stable identifier, mostly useful in logs/tests. */
  readonly id: string;
  /** subject ≤ 100 chars (SNS's own limit); body is plain text. */
  publish(subject: string, body: string): Promise<void>;
}

// EmailSender is the contract for mail to a named person (docs/share-notifications-design.md).
// lib/notify is the maintainer's SNS topic; this is the other channel — one
// recipient per message, which SNS cannot do without a confirmed subscription.
// Same provider shape as lib/notify and lib/storage: one interface, one id per
// implementation, selected by env.

export interface EmailMessage {
  /** One address, or several on one message (a safeguarding alert's teachers). */
  to: string | string[];
  /** Copied recipients (the maintainer on safeguarding alerts during the pilot). */
  cc?: string[];
  /** Where a reply goes — the teacher who acted, not the no-reply sender (D-3). */
  replyTo?: string;
  subject: string;
  /** Plain text. */
  text: string;
}

export interface EmailSender {
  readonly id: string;
  send(message: EmailMessage): Promise<void>;
}

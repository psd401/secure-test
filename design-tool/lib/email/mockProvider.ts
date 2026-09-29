import type { EmailMessage, EmailSender } from "./types";

/** Test/dev default (EMAIL_PROVIDER unset or "mock"). Records every call. */
export const sentEmails: EmailMessage[] = [];

export const mockEmailProvider: EmailSender = {
  id: "mock",
  async send(message) {
    sentEmails.push(message);
  },
};

/** Test seam: clears recorded calls between tests. */
export function resetMockEmails(): void {
  sentEmails.length = 0;
}

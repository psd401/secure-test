import { mockEmailProvider } from "./mockProvider";
import { sesProvider } from "./sesProvider";
import type { EmailSender } from "./types";

// getEmailSender() returns the active sender, selected by EMAIL_PROVIDER
// (default "mock" — the same default-off shape as lib/notify/provider.ts).
// "ses" waits on a verified sending domain (docs/share-notifications-design.md).
export function getEmailSender(): EmailSender {
  return getEmailSenderById(process.env.EMAIL_PROVIDER ?? "mock");
}

export function getEmailSenderById(id: string): EmailSender {
  if (id === "mock") return mockEmailProvider;
  if (id === "ses") return sesProvider;
  throw new Error(
    `email provider "${id}" is not implemented. Supported: "mock", "ses". ` +
      `See docs/share-notifications-design.md.`,
  );
}

export { mockEmailProvider, sesProvider };
export type { EmailMessage, EmailSender } from "./types";

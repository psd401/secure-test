import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import type { EmailSender } from "./types";

// SES-backed email (docs/share-notifications-design.md, slice 3 turns it on).
// Mirrors lib/notify/snsProvider.ts: a cached client, region from
// EMAIL_REGION || AWS_REGION || us-west-2, credentials from the standard AWS
// chain (the task role when deployed). EMAIL_FROM is the verified no-reply
// sender; SES verifies only the From identity, so Reply-To can be any address.

const DEFAULT_REGION = "us-west-2";

let cachedClient: SESv2Client | null = null;
function sesClient(): SESv2Client {
  if (cachedClient) return cachedClient;
  cachedClient = new SESv2Client({
    region: process.env.EMAIL_REGION || process.env.AWS_REGION || DEFAULT_REGION,
  });
  return cachedClient;
}

function fromAddress(): string {
  const from = process.env.EMAIL_FROM;
  if (!from) {
    throw new Error(
      "EMAIL_FROM is not set but the ses email provider was selected. " +
        "See docs/share-notifications-design.md.",
    );
  }
  return from;
}

export const sesProvider: EmailSender = {
  id: "ses",
  async send(message) {
    await sesClient().send(
      new SendEmailCommand({
        FromEmailAddress: fromAddress(),
        Destination: { ToAddresses: [message.to] },
        ReplyToAddresses: message.replyTo ? [message.replyTo] : undefined,
        Content: {
          Simple: {
            Subject: { Data: message.subject.replace(/[\r\n]+/g, " "), Charset: "UTF-8" },
            Body: { Text: { Data: message.text, Charset: "UTF-8" } },
          },
        },
      }),
    );
  },
};

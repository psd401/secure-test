// The two share emails (docs/share-notifications-design.md, D-2 / D-3).
// Content is the sharer, the assessment's name and a link — no student data,
// no assessment content. Sending is best effort: a failure is logged and never
// fails the share or grant that triggered it.
import { log, truncate } from "@/lib/log";
import { PRODUCT_NAME } from "@/lib/brand";
import { getEmailSender } from "./provider";
import type { EmailMessage } from "./types";

export interface ShareEmailInput {
  kind: "share" | "co_teach";
  to: string;
  sharerEmail: string;
  assessmentName: string;
  /** Absolute URL the email links to. */
  link: string;
}

/** Pure: the message for one share or co-teach grant. */
export function buildShareEmail(input: ShareEmailInput): EmailMessage {
  const name = input.assessmentName.replace(/[\r\n]+/g, " ").trim() || "an assessment";
  const who = input.sharerEmail;
  if (input.kind === "share") {
    return {
      to: input.to,
      replyTo: who,
      subject: `${who} shared "${name}" with you`,
      text: [
        `${who} shared the assessment "${name}" with you in ${PRODUCT_NAME}.`,
        "",
        "Adding it gives you your own copy to edit; it does not change theirs.",
        `Open ${PRODUCT_NAME} to add it: ${input.link}`,
        "",
        `Reply to this email to reach ${who}.`,
      ].join("\n"),
    };
  }
  return {
    to: input.to,
    replyTo: who,
    subject: `${who} added you as a co-teacher on "${name}"`,
    text: [
      `${who} added you as a co-teacher on the assessment "${name}" in ${PRODUCT_NAME}.`,
      "",
      "You can edit it with them, run test sessions for your own sections, and see every result.",
      `Open it: ${input.link}`,
      "",
      `Reply to this email to reach ${who}.`,
    ].join("\n"),
  };
}

/** Best effort: never throws. */
export async function sendShareEmail(input: ShareEmailInput): Promise<void> {
  try {
    await getEmailSender().send(buildShareEmail(input));
  } catch (err) {
    log.warn("share_email_failed", {
      kind: input.kind,
      message: truncate(err instanceof Error ? err.message : String(err)),
    });
  }
}

// The safeguarding alert email (docs/safeguarding-alerts-design.md, slice 4).
// Sent when the screening pass writes a new alert row: one email per flagged
// answer, to the assessment's owner and the teacher who ran the sitting the
// attempt came from (D-1, 6.2), the maintainer CC'd while the pilot lasts
// (SAFEGUARDING_CC_EMAILS, set from the `notifyEmail` context key).
//
// Content: the assessment's name, the kind of concern, a link to the
// per-student results page, the in-app disclaimer. Never a student's name and
// never a word of their answer. Sending is best effort: a failure is logged at
// error level (it trips the server-error alarm) and never touches the alert.
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { assessments, attempts, test_sessions, type SafeguardingAlertKind } from "@/db/schema";
import { log, truncate } from "@/lib/log";
import { ALERT_DISCLAIMER } from "@/lib/safeguarding/alertView";
import { assessmentOwner } from "@/lib/scoring/results";
import { PRODUCT_NAME } from "@/lib/brand";
import { getEmailSender } from "./provider";
import type { EmailMessage } from "./types";

type Db = ReturnType<typeof getDb>;

export interface SafeguardingEmailInput {
  to: string[];
  cc: string[];
  assessmentName: string;
  kinds: SafeguardingAlertKind[];
  /** Absolute URL of the per-student results page. */
  link: string;
}

const KIND_LINES: Record<SafeguardingAlertKind, string> = {
  wellbeing:
    "A possible wellbeing concern: the answer may describe suicidal thoughts, self-harm or abuse.",
  prompt_injection:
    "A possible attempt to steer AI scoring. AI scoring is held for this answer until you choose Score with AI anyway.",
};

/** Pure: the message for one flagged answer. */
export function buildSafeguardingEmail(input: SafeguardingEmailInput): EmailMessage {
  const name = input.assessmentName.replace(/[\r\n]+/g, " ").trim() || "an assessment";
  const kinds = (["wellbeing", "prompt_injection"] as const).filter((k) =>
    input.kinds.includes(k),
  );
  return {
    to: input.to,
    cc: input.cc.length > 0 ? input.cc : undefined,
    subject: `A response on "${name}" needs your attention`,
    text: [
      `A student's answer on "${name}" in ${PRODUCT_NAME} was flagged by the automated check:`,
      "",
      ...kinds.map((k) => `- ${KIND_LINES[k]}`),
      "",
      `Open the student's results to read it: ${input.link}`,
      "",
      ALERT_DISCLAIMER,
      "",
      "This message comes from a no-reply address.",
    ].join("\n"),
  };
}

function splitEmails(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.length > 0);
}

// The screening pass runs after the response (and in the hourly retry), so
// there is no request to read an origin from. OIDC_REDIRECT_URI is the
// explicit origin everywhere it matters (lib/auth/appOrigin.ts).
function origin(): string {
  const fromEnv = process.env.OIDC_REDIRECT_URI;
  return fromEnv ? new URL(fromEnv).origin : "http://localhost:3000";
}

/**
 * Email the teachers of one flagged answer. Never throws. With no teacher
 * address on record the CC list is used as the To, so the maintainer still
 * hears; with neither, nothing is sent and a warning is logged.
 */
export async function sendSafeguardingEmail(
  db: Db,
  alert: { attemptId: string; assessmentId: string; responseId: string; kinds: SafeguardingAlertKind[] },
): Promise<void> {
  try {
    const owner = await assessmentOwner(db, alert.assessmentId);
    const [row] = await db
      .select({ name: assessments.name, sittingEmail: test_sessions.owner_email })
      .from(attempts)
      .innerJoin(assessments, eq(assessments.id, attempts.assessment_id))
      .leftJoin(test_sessions, eq(test_sessions.id, attempts.test_session_id))
      .where(eq(attempts.id, alert.attemptId))
      .limit(1);
    const teachers = [
      ...new Set(
        [owner.ownerEmail, row?.sittingEmail]
          .filter((e): e is string => !!e)
          .map((e) => e.trim().toLowerCase()),
      ),
    ];
    const cc = splitEmails(process.env.SAFEGUARDING_CC_EMAILS).filter((e) => !teachers.includes(e));
    const to = teachers.length > 0 ? teachers : cc;
    if (to.length === 0) {
      log.warn("safeguarding_email_no_recipient", {
        response_id: alert.responseId,
        attempt_id: alert.attemptId,
      });
      return;
    }
    await getEmailSender().send(
      buildSafeguardingEmail({
        to,
        cc: teachers.length > 0 ? cc : [],
        assessmentName: row?.name ?? "",
        kinds: alert.kinds,
        link: `${origin()}/dashboard/${alert.assessmentId}/results/${alert.attemptId}`,
      }),
    );
  } catch (err) {
    log.error("safeguarding_email_failed", {
      response_id: alert.responseId,
      attempt_id: alert.attemptId,
      message: truncate(err instanceof Error ? err.message : String(err)),
    });
  }
}

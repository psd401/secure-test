import { PublishCommand, SNSClient } from "@aws-sdk/client-sns";
import type { NotifyPublisher } from "./types";

// SNS-backed notification (docs/observability-design.md, D-2/D-9). Mirrors
// the S3/Bedrock client conventions (lib/storage/s3Provider.ts): a cached
// client, region from NOTIFY_REGION || AWS_REGION || us-west-2, credentials
// resolved through the standard AWS chain (env keys, AWS_PROFILE, SSO, or the
// task role when deployed) — no env pre-check, so failures surface at call
// time. The topic comes from NOTIFY_TOPIC_ARN (slice 1's infra); alarms
// publish to the same topic, so the subject is the only thing that tells them
// apart in James's inbox.

const DEFAULT_REGION = "us-west-2";

let cachedClient: SNSClient | null = null;
function snsClient(): SNSClient {
  if (cachedClient) return cachedClient;
  cachedClient = new SNSClient({
    region: process.env.NOTIFY_REGION || process.env.AWS_REGION || DEFAULT_REGION,
  });
  return cachedClient;
}

function topicArn(): string {
  const arn = process.env.NOTIFY_TOPIC_ARN;
  if (!arn) {
    throw new Error(
      "NOTIFY_TOPIC_ARN is not set but the sns notify provider was selected. " +
        "Set NOTIFY_TOPIC_ARN (and optionally NOTIFY_REGION). See " +
        "docs/observability-design.md.",
    );
  }
  return arn;
}

export const snsProvider: NotifyPublisher = {
  id: "sns",
  async publish(subject, body) {
    await snsClient().send(
      new PublishCommand({
        TopicArn: topicArn(),
        // SNS caps a Subject at 100 chars and rejects newlines in it.
        Subject: subject.replace(/[\r\n]+/g, " ").slice(0, 100),
        Message: body,
      }),
    );
  },
};

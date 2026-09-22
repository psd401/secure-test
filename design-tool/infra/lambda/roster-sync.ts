// Slice 76 (ADR 0017): the roster-sync Lambda entry point.
//
// Bundled by aws-cdk-lib/aws-lambda-nodejs (esbuild) from lib/roster-sync.ts
// in the CDK stack. Deliberately thin: env → source → handleS3Event. The
// logic and its tests live in design-tool/lib/roster/syncHandler.ts.
//
// Environment:
//   ROSTER_BUCKET     the extract bucket (set by the stack)
//   ROSTER_PREFIX     key prefix, default "roster/"
//   ASSET_BUCKET      the design-tool asset bucket (set by the stack, D-7);
//                     when present, the practice sweep also deletes a swept
//                     attempt's stored upload bytes under `responses/*` —
//                     the only key shape the importer's grant allows.
//   DATABASE_URL      used directly when present (local runs), else
//   DB_SECRET_ARN     the cluster's Secrets Manager secret, read once per
//                     cold start. Never both in a deployed function.
import { S3Client } from "@aws-sdk/client-s3";
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import type { S3Event } from "aws-lambda";
import { sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import {
  DEFAULT_PREFIX,
  S3SnapshotSource,
  databaseUrlFromSecret,
  handleS3Event,
  waitForDatabase,
} from "@/lib/roster/syncHandler";
import { createS3UploadDeleter } from "./deleteStoredUpload";

let databaseUrlReady: Promise<void> | null = null;

async function ensureDatabaseUrl(): Promise<void> {
  if (process.env.DATABASE_URL) return;
  const arn = process.env.DB_SECRET_ARN;
  if (!arn) throw new Error("neither DATABASE_URL nor DB_SECRET_ARN is set");
  const sm = new SecretsManagerClient({});
  const out = await sm.send(new GetSecretValueCommand({ SecretId: arn }));
  if (!out.SecretString) throw new Error("database secret has no SecretString");
  process.env.DATABASE_URL = databaseUrlFromSecret(out.SecretString);
}

export async function handler(event: S3Event) {
  const bucket = process.env.ROSTER_BUCKET;
  if (!bucket) throw new Error("ROSTER_BUCKET is not set");
  const prefix = process.env.ROSTER_PREFIX ?? DEFAULT_PREFIX;

  databaseUrlReady ??= ensureDatabaseUrl();
  await databaseUrlReady;

  const s3 = new S3Client({});
  const source = new S3SnapshotSource(s3, bucket, prefix);
  const db = getDb();
  // 9.1: the paused (0 ACU) cluster resumes on this first connection and
  // may not answer inside one connect window — wait for it, then import.
  await waitForDatabase(() => db.execute(sql`select 1`));

  // D-7: only wired when the stack granted this function DeleteObject on the
  // asset bucket (ASSET_BUCKET set) — a stack without that grant, or a local
  // run, keeps the DB-only practice sweep.
  const assetBucket = process.env.ASSET_BUCKET;
  const deleteStored = assetBucket ? createS3UploadDeleter(s3, assetBucket) : undefined;

  return handleS3Event(db, source, event, prefix, undefined, deleteStored);
}

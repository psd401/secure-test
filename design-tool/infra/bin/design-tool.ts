#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { DesignToolStack } from "../lib/design-tool-stack";

const app = new cdk.App();

// No ingress CIDR context any more (infra slice, 2026-09-01): the cluster
// SG admits only the importer Lambda and the Fargate service, SG→SG.
// Migrations run inside the VPC — README "Migrating Aurora".

// Environment suffix for the per-env asset bucket (default "dev"). Pass via:
//   bunx cdk deploy --context env=prod
const envName = (app.node.tryGetContext("env") as string | undefined) ?? "dev";

// ECS slice 3: OAuth client ids for the task env. Public identifiers (the
// web id is in every Google login redirect, the native id ships in the app
// bundle; the secret is OIDC_CLIENT_SECRET in Secrets Manager), so a plain
// `cdk deploy` needs them present in context — CDK never persists
// --context flags between runs, and a deploy without them would ship
// sign-in unconfigured (OIDC_CLIENT_ID / OIDC_AUDIENCE unset). Since the
// public-release scrub (2026-09-04) they live in `cdk.context.json`
// (gitignored — see `cdk.context.json.example`) rather than the tracked
// `cdk.json`; `--context oidcWebClientId=…` still overrides for a one-off
// (a prod pair, a rename). The former OIDC_WEB_CLIENT_ID /
// OIDC_NATIVE_CLIENT_ID env-var fallback is gone — with context always
// supplying a value it could never apply.
const oidcWebClientId = app.node.tryGetContext("oidcWebClientId") as string | undefined;
const oidcNativeClientId = app.node.tryGetContext("oidcNativeClientId") as string | undefined;

// Slice 90: the warehouse DAG's execution role, per env (the data
// engineer's team, 2026-08-27). The bucket name is a runtime parameter on
// their side. Configured via context (`mwaaProducerRoleArn` — see
// `cdk.context.json.example`) rather than hardcoded, so the account id and
// role name aren't in tracked source; applies to whichever env is
// currently being deployed. A prod twin gets its own value when it exists
// (override with `--context mwaaProducerRoleArn=…` for that deploy).
const mwaaProducerRoleArn = app.node.tryGetContext("mwaaProducerRoleArn") as
  | string
  | undefined;
const producerRoleArns = mwaaProducerRoleArn ? [mwaaProducerRoleArn] : [];

new DesignToolStack(app, "SecureTestDesignTool", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? "us-west-2",
  },
  description:
    "Design tool — Aurora Postgres Serverless v2 cluster (Slice 24), S3 asset bucket (Slice 31), roster sync (Slice 76), Fargate app service (ADR 0014).",
  envName,
  producerRoleArns,
  oidcWebClientId,
  oidcNativeClientId,
  // Public origin host — required, no default is committed to source (see
  // DesignToolStack's constructor and cdk.context.json.example). Set
  // `domainName` in cdk.context.json, or override with `--context
  // domainName=…` for a one-off (e.g. a prod pair, a rename).
  domainName: app.node.tryGetContext("domainName") as string | undefined,
  // Bedrock guardrail id (ADR 0011) — a district resource id, read from
  // context like the others; the stack refuses to synth without it.
  guardrailId: app.node.tryGetContext("guardrailId") as string | undefined,
});

#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { DesignToolStack } from "../lib/design-tool-stack";

const app = new cdk.App();

// No ingress CIDR context any more (infra slice, 2026-09-01): the cluster
// SG admits only the importer Lambda and the Fargate service, SG→SG.
// Migrations run inside the VPC — README "Migrating Aurora".

// Which ONE stack this app builds (renderer slice 2, D-7 —
// docs/server-delivered-renderer-design.md).
//
// No `env` context = production: the stack `SecureTestDesignTool`, whose
// resources carry the historical suffix "dev" (the bucket, the app secret,
// the log group). That default is unchanged, so `deploy.sh` and every script
// that names the stack behave exactly as before.
//
// `--context env=staging` = the separate `SecureTestDesignToolStaging` stack:
// its own VPC, Aurora, buckets, secret, log group and topic, a fictional
// roster only. Its per-env values come from the `staging` object in
// cdk.context.json (see cdk.context.json.example).
//
// Any other value is refused. Before this slice the stack id was fixed, so
// `--context env=<anything>` re-targeted the PRODUCTION stack and renamed its
// buckets and secret in place.
const envName = (app.node.tryGetContext("env") as string | undefined) ?? "dev";
if (envName !== "dev" && envName !== "staging") {
  throw new Error(
    `Unknown env "${envName}". Omit --context env for production (the "dev" ` +
      `stack), or pass --context env=staging.`,
  );
}
const isStaging = envName === "staging";

// Staging's own values. Anything it leaves out falls back to the
// production value from the top level of cdk.context.json.
interface StagingContext {
  domainName?: string;
  notifyEmail?: string;
  adminEmails?: string;
}
const staging = (app.node.tryGetContext("staging") as StagingContext | undefined) ?? {};
if (isStaging && !staging.domainName) {
  throw new Error(
    "env=staging requires staging.domainName in cdk.context.json — see " +
      "cdk.context.json.example. It must differ from the production domainName.",
  );
}
if (isStaging && staging.domainName === app.node.tryGetContext("domainName")) {
  throw new Error("staging.domainName must differ from the production domainName.");
}
const contextValue = (key: keyof StagingContext): string | undefined =>
  (isStaging ? staging[key] : undefined) ??
  (app.node.tryGetContext(key) as string | undefined);

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
// Staging never receives the warehouse feed: no producer role on its
// roster bucket (its roster is the fictional demo one).
const producerRoleArns = mwaaProducerRoleArn && !isStaging ? [mwaaProducerRoleArn] : [];

new DesignToolStack(app, isStaging ? "SecureTestDesignToolStaging" : "SecureTestDesignTool", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? "us-west-2",
  },
  description:
    isStaging
      ? "Design tool STAGING — no student data; renderer slice 2 (docs/server-delivered-renderer-design.md, D-7)."
      : "Design tool — Aurora Postgres Serverless v2 cluster (Slice 24), S3 asset bucket (Slice 31), roster sync (Slice 76), Fargate app service (ADR 0014).",
  envName,
  staging: isStaging,
  producerRoleArns,
  oidcWebClientId,
  oidcNativeClientId,
  // Public origin host — required, no default is committed to source (see
  // DesignToolStack's constructor and cdk.context.json.example). Set
  // `domainName` in cdk.context.json, or override with `--context
  // domainName=…` for a one-off (e.g. a prod pair, a rename).
  domainName: contextValue("domainName"),
  // Bedrock guardrail id (ADR 0011) — a district resource id, read from
  // context like the others; the stack refuses to synth without it.
  guardrailId: app.node.tryGetContext("guardrailId") as string | undefined,
  // Observability slice 1 (docs/observability-design.md, D-9): the address
  // that gets alarm + feedback email. A personal address, so it lives in
  // context rather than tracked source; the stack refuses to synth without
  // it — see cdk.context.json.example.
  notifyEmail: contextValue("notifyEmail"),
  // Access slice 2 (docs/access-model-design.md, D-1): the system-admin list,
  // comma-separated. Personal addresses, so context rather than tracked source
  // — but UNLIKE domainName / guardrailId / notifyEmail the stack does NOT
  // require it: an empty list is the correct default (nobody is an admin), and
  // a deploy that forgets it is degraded, not broken.
  adminEmails: contextValue("adminEmails") ?? "",
});

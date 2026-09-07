# design-tool infra (Slices 24, 31, 76)

CDK stack `SecureTestDesignTool` provisioning an Aurora Postgres Serverless v2 cluster + an S3 asset bucket for the design tool, and (slice 76) the roster-extract bucket + importer Lambda.

## What it stands up

- VPC: 2 AZs, no NAT. Public subnets (the cluster) plus isolated subnets (the roster importer Lambda) with an S3 gateway endpoint (free) and a Secrets Manager interface endpoint (`privateDnsEnabled`) so the isolated side reaches both services without NAT.
- Aurora Postgres Serverless v2 (Postgres 16.6), min **0 ACU** (scale-to-zero) / max **1 ACU**.
- One writer instance, publicly accessible.
- Security group with **SG→SG ingress only** on 5432: the roster importer Lambda and the Fargate app service. No CIDR rules since 2026-09-01 — laptop access is a temporary hand-added rule (below), never a standing one; the district's egress IP is the WSIPC/K-20 NAT shared by the whole network.
- Master credentials in Secrets Manager (auto-generated 30-char password).
- Default database: `secure_test_design_tool`.
- S3 asset bucket `secure-test-design-tool-<env>` (Slice 31, ADR 0008): SSE-S3 encryption, public access blocked, abort-incomplete-multipart lifecycle, no versioning. dev auto-deletes on `cdk destroy`; prod retains.
- Managed policy `secure-test-design-tool-<env>-asset-access` granting object Put/Get/Delete on the bucket — attach to the app role or a local-testing IAM user (the S3 parallel to `secure-test-bedrock`).
- **Roster sync (Slice 76, ADR 0017)** — `lib/roster-sync.ts`:
  - Bucket `secure-test-roster-<env>` (SSE-S3, public-blocked, TLS-only). Objects under `roster/` expire after 30 days: a snapshot names every student, and the bucket is a mailbox, not an archive.
  - Managed policy `secure-test-roster-<env>-producer`: `s3:PutObject` on `roster/*` only. This is what the warehouse DAG's principal gets (hand to the data engineer with `docs/roster-extract.md`).
  - Lambda `secure-test-roster-sync-<env>` (Node 22, arm64, 10 min, 1024 MB, reserved concurrency 1) bundled by esbuild from `lambda/roster-sync.ts` → `design-tool/lib/roster/syncHandler.ts`. Triggered by `OBJECT_CREATED` on `roster/*/manifest.json` only; reads the five objects, validates, imports; CloudWatch log lines carry counts and reason codes, never rows. Connects to the cluster with `DB_SECRET_ARN` (read once per cold start). Runs **inside the VPC** in the isolated subnets with its own security group; the cluster SG admits that SG on 5432 (SG-to-SG, tighter than AI Studio's VPC-CIDR rule). It was originally placed outside the VPC on the theory that a public cluster is reachable from anywhere — it is not unless the SG is open to the world, and every S3-triggered import died with `connect ETIMEDOUT` (CloudWatch, snapshots 20260828T001140Z and 20260828T130051Z).
  - **Deployed 2026-08-26** (`secure-test-roster-dev`, `secure-test-roster-dev-producer`, `secure-test-roster-sync-dev`). **Updated 2026-08-27**: Object Ownership set to bucket-owner-enforced and the warehouse MWAA execution role granted put-only on `roster/*` through the bucket policy (slice 90); the importer carries the list-shaped manifest support (slice 88). Aurora is at migration 0020 (same evening), so the importer's first write (`roster_sync_runs`) has a table to land in.

## Cost posture

- Idle (cluster paused at 0 ACU): storage only, ~$0.10/GB-month.
- Active (1 ACU): ~$0.12/hour = ~$3/day.
- No NAT (~$32/mo saved). S3 gateway endpoint is free. The Secrets Manager interface endpoint is the one paid endpoint: one ENI per AZ (2) at ~$0.01/hour each plus data processed — order of ~$15/mo, needed because the importer has no other path to Secrets Manager.

`cdk destroy` removes everything; `RemovalPolicy.DESTROY` is set for dev.

## Deploy

```bash
# Required: AWS creds for the playground account loaded.
# Required: bootstrap CDK in us-west-2 once per account (skip if done previously for PoC-B/C).
bunx cdk bootstrap aws://<account-id>/us-west-2

# Required: colima running (the app image is built + pushed by the deploy).
# Required: cdk.context.json filled in (copy cdk.context.json.example and
# fill in real values — it is gitignored, never committed). The two OAuth
# client ids, the MWAA producer role ARN and the public domainName all come
# from there (public identifiers, not secrets, but kept out of tracked
# source per the public-release scrub); --context oidcWebClientId=… /
# oidcNativeClientId=… / domainName=… overrides them for a one-off, e.g. a
# prod pair.
# Optional: --context env=prod to name the asset bucket for prod (default dev).
bunx cdk deploy

# Then, if the deploy shipped new migrations (deploy FIRST — the image
# carries the migrations it was built with):
scripts/migrate-aurora.sh
```

### Context file (`cdk.context.json`)

`cdk.context.json` is gitignored — it carries the account id (in CDK's own
availability-zones lookup cache), the two Google OAuth client ids, the MWAA
producer role ARN, the public `domainName` and the Bedrock `guardrailId`, none of which are tracked in
source. Copy `cdk.context.json.example` to `cdk.context.json` and fill in
real values before deploying; `bunx cdk synth` also works against the
example's placeholder values as long as no AWS lookup needs to resolve
(e.g. a real account's availability zones). `DesignToolStack` throws a
clear error at synth/deploy time if `domainName` or `guardrailId` is
missing — there is no hardcoded fallback for either.

Outputs printed:

- `ClusterEndpoint` — hostname:port of the writer.
- `DatabaseName` — `secure_test_design_tool`.
- `CredentialsSecretArn` — Secrets Manager ARN holding the JSON `{username, password, host, port, dbname}`.
- `AssetBucketName` — S3 bucket for image assets (set as `S3_BUCKET` in `.env.local`).
- `AssetBucketAccessPolicyArn` — managed policy to attach for Put/Get/Delete on the bucket.

## Migrations

Run from inside the VPC — see "Migrating Aurora" below. There is no laptop
path by default.

## Ad-hoc psql from a laptop (temporary rule)

For a one-off query (`roster:health`, the go-live checklist SQL), open the
cluster SG to your current IP by hand and revoke it in the same session.
Never make the district address a standing rule — it is the WSIPC/K-20 NAT
for the whole network. The stack never re-adds a CIDR rule, so a rule left
behind by mistake does not collide with the next deploy; it just stays open
until someone notices.

```bash
export AWS_REGION=us-west-2
SG=$(aws ec2 describe-security-groups --filters Name=group-name,Values='SecureTestDesignTool-ClusterSg*' --query 'SecurityGroups[0].GroupId' --output text)
ME=$(curl -s https://checkip.amazonaws.com)/32
aws ec2 authorize-security-group-ingress --group-id "$SG" --protocol tcp --port 5432 --cidr "$ME"

SECRET=$(aws secretsmanager get-secret-value \
  --secret-id arn:aws:secretsmanager:us-west-2:<account-id>:secret:SecureTestDesignToolCluster-<suffix> \
  --query SecretString --output text)
export DATABASE_URL=$(echo "$SECRET" | jq -r '"postgres://\(.username):\(.password)@\(.host):\(.port)/\(.dbname)?sslmode=require"')
psql "$DATABASE_URL" -Atc "select version();"
# … cd .. && bun run roster:health …

aws ec2 revoke-security-group-ingress --group-id "$SG" --protocol tcp --port 5432 --cidr "$ME"
unset DATABASE_URL SECRET
```

(The `!` shell in Claude Code runs each line in a fresh shell, so exported
variables do not survive between lines there — use a normal terminal.)

## Tear down

```bash
bunx cdk destroy
```

## Observability (slice 1, `docs/observability-design.md`)

- Context key **`notifyEmail`** (see `cdk.context.json.example`) — the
  address subscribed to the alarm topic. Required, same shape as
  `domainName` / `guardrailId`: the stack throws a clear error at
  synth/deploy time if it's missing.
- One SNS topic, `secure-test-notify-<env>`, with an email subscription to
  `notifyEmail`. **AWS emails that address a confirmation link on first
  deploy — click it once or the subscription never delivers.**
  **Do NOT confirm by clicking the link (2026-09-07 lesson):** every SNS
  email carries a one-click Unsubscribe link, and the district mail path's
  link scanner follows it — the first confirmed subscription was
  unsubscribed within a minute of the first alarm email, twice. Confirm
  from the CLI instead, with authenticated unsubscribe, so the link needs
  an AWS-signed request:
  `aws sns confirm-subscription --topic-arn <arn> --token <Token= from the
  confirmation URL> --authenticate-on-unsubscribe true`. The CLI-made
  subscription is outside CloudFormation's control (the stack's own
  `AWS::SNS::Subscription` was deleted by the unsubscribe); a future
  `cdk deploy` recreates the stack's pending one beside it — harmless,
  leave the pending one unconfirmed or delete it. The
  `taskRole` gets `sns:Publish` scoped to this one topic (nothing
  broader); the topic ARN is injected into the container as
  `NOTIFY_TOPIC_ARN`, with `NOTIFY_PROVIDER=sns`, for slice 3's feedback
  publish (`POST /api/feedback`; dev and tests default to `mock`).
- The app's log group (`AppService`'s `AppLogGroup`, `/ecs/secure-test-design-tool-<env>`)
  is now explicit, with **30-day retention** and `RemovalPolicy.DESTROY` —
  it replaced the CDK-generated group, which had no retention and grew
  forever.
- Four alarms, all publishing to the topic above:
  - **ServerErrorsAlarm** — a CloudWatch metric filter on the log group
    matching `{ $.level = "error" }` (namespace `SecureTest`, metric
    `ServerErrors`); sum ≥ 1 over one 5-minute period. Nothing emits this
    shape of log line yet (slice 2 does); the alarm is in place first so
    slice 2 lights it up rather than building it.
  - **TargetGroup5xxAlarm** — the ALB target group's
    `HTTPCode_Target_5XX_Count`, sum ≥ 5 over 5 minutes.
  - **HealthyHostCountAlarm** — the ALB target group's `HealthyHostCount`
    (minimum) < 1 for two consecutive 1-minute periods, missing data
    treated as breaching. Chosen over ECS `RunningTaskCount`, which lives
    under `ECS/ContainerInsights` and would have meant enabling Container
    Insights on the cluster (a paid, cluster-wide change) for one metric;
    Container Insights stays `DISABLED`.
  - **ImporterErrorsAlarm** (on `RosterSync`) — the roster importer
    Lambda's `Errors` metric, sum ≥ 1 over 5 minutes. The roster stack and
    the app stack are the same CDK stack (`RosterSync` and `AppService`
    are both constructs inside `DesignToolStack`), so the topic is passed
    to both as a construct prop — no cross-stack export/import needed.
- The circuit breaker (`circuitBreaker: { rollback: true }`) is unchanged.

## Open questions (carried from the slice plan)

- 24.1 Aurora vs RDS vs DynamoDB long-term cost — measure idle + active spend over the first month before committing.
- Whether to keep public-access posture for prod, or move to private + RDS Proxy + in-VPC app deployment (folds into the future Next.js deployment slice).

## Migrating Aurora

REWRITTEN 2026-09-01 (infra slice): migrations run **inside the VPC** as a
one-off ECS `run-task`, and the laptop CIDR rule is gone from the stack.
History: the 2026-07 → 08 shape was "open the SG to my IP, `bun run
db:migrate` from the laptop, close it"; the 2026-08-31 Fargate deploy
folded the CIDR into the stack; both are retired.

How it works:

- `scripts/migrate-aurora.sh` runs a task on the **app service's own task
  definition** — same image, same ECS-injected `DB_*` secrets, same
  security group (so the existing SG→SG rule admits it), same public
  subnets with a public IP (ECR pull, no NAT) — with the container command
  overridden to `node design-tool/scripts/docker-entrypoint.mjs migrate`.
  The entrypoint assembles `DATABASE_URL` exactly as it does for the
  server, then imports `db/migrate.mjs` instead of `server.js`.
- `db/migrate.mjs` is `db/migrate.ts` bundled by `bun build` in the
  Dockerfile's builder stage: the runtime image has no bun, and Next's
  standalone trace does not carry `drizzle-orm`/`postgres` as resolvable
  modules (they are bundled into the server chunks), so the migrator is
  shipped as one self-contained file that plain node runs.
- The script waits for the task to stop, prints the container's CloudWatch
  lines and exits with the container's exit code. The verification line is
  the migrator's own: `migrations applied — N in drizzle.__drizzle_migrations
  (journal has N), latest <timestamp>`. N must equal the journal count;
  `latest` is the journal `when` of the newest applied migration (drizzle
  stores that, not the apply time), so it identifies the migration.
- Idempotent: drizzle applies only what the table lacks. Order matters:
  **deploy first, then migrate** — the image carries the migrations it was
  built with, and a task started from the old task definition would run the
  old set. Schema-ahead-of-app is the safe direction, so the window between
  the two is fine.

```bash
# From design-tool/infra/, AWS creds loaded. Nothing to pass.
scripts/migrate-aurora.sh
```

Failure modes seen or expected: task fails to start (image pull, secrets)
→ `stoppedReason` on the FAILED line, exit code empty; migrator throws
(bad SQL, connection) → node exit 1 and the stack trace in the log lines.
A stray task cannot be left running: the entrypoint refuses any argument
other than `migrate`, and the migrator exits when done.

The importer Lambda and the app service are unaffected by any of this: they
reach the cluster through their own SG→SG rules. Record: Aurora was brought
to 0020 on 2026-08-26 (laptop), 0023 on 2026-08-31 (laptop, count 24), 0024
on 2026-09-01 16:35 PT (laptop, count 25); the first run-task migration was
the no-op proof on 2026-09-01 evening (task `5062e5832a01…`, 45 s from
start to stop, exit 0, `25 … (journal has 25)`).

## Roster sync — local / manual run

The same importer the Lambda runs, pointed at a directory:

```bash
cd .. && DATABASE_URL=postgres://$USER@localhost:5432/secure_test_design_tool_dev \
  bun scripts/roster-import-local.ts /path/to/snapshot-dir
```

Exit 0 = imported, 1 = refused (reason on the JSON line and in `roster_sync_runs`), 2 = usage. Run it on `design-tool/test/fixtures/roster/complete` to see the shape, and on the data engineer's first real extract before any bucket exists.

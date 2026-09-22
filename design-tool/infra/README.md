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
  - **D-11 retention sweep (2026-09-15)**: after every import, the same Lambda invocation runs `sweepEventTables` (`design-tool/lib/retention/sweep.ts`) and deletes rows older than 90 days from `server_error_events`, `client_error_events` (aged off `received_at`, the server clock — not the client-stamped `occurred_at`) and `guardrail_events`; `feedback` is never touched. Best-effort — a sweep failure is logged as `retention_sweep_failed` and never fails the sync. No infra change: it runs inside the existing 10-minute timeout / 1024 MB Lambda, no new env var. Confirm in the log group (`secure-test-roster-sync-<env>` in the observability log group) by finding the `retention_sweep` line after a nightly run — it carries `retention_days` and the three tables' deleted counts.

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

Or the whole recipe as one command — pre-flight (clean tree, HEAD =
origin/main, AWS creds, colima, context file), the live commit from
`/api/health`, `cdk diff`, `cdk deploy --require-approval never`,
`migrate-aurora.sh` only when migration files changed between the live
commit and HEAD, then the health stamp + rollout state:

```bash
scripts/deploy.sh            # everything
scripts/deploy.sh --diff     # pre-flight + diff, no deploy
scripts/deploy.sh --no-migrate
```

`aws sso login` stays a human step (it opens a browser).

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

Context keys:

| Key | Required | What it is |
|---|---|---|
| `availability-zones:account=…` | CDK's own | Lookup cache; carries the account id |
| `oidcWebClientId` | yes in practice | Google OAuth web client id → `OIDC_CLIENT_ID` |
| `oidcNativeClientId` | yes in practice | The macOS client's id → second `OIDC_AUDIENCE` entry |
| `mwaaProducerRoleArn` | for the roster feed | The warehouse DAG's role, allowed to put snapshots |
| `domainName` | **yes, throws** | Public origin host → cert, `OIDC_REDIRECT_URI` |
| `guardrailId` | **yes, throws** | Bedrock guardrail id (ADR 0011) |
| `notifyEmail` | **yes, throws** | Address subscribed to the alarm/feedback topic |
| `adminEmails` | no, defaults `""` | Access slice 2 (docs/access-model-design.md, D-1): comma-separated staff addresses that get system-admin access → `ADMIN_EMAILS`. Empty = nobody, which is a correct deployment, so the stack does NOT throw without it |

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

**Read-only queries: use `scripts/query-aurora.sh <file.sql>`** (2026-09-22).
It runs the manual recipe below in one shell — opens the cluster SG to your
public /32, reads the cluster secret, runs the file in a session with
`default_transaction_read_only = on` (writes fail at the database; a file
that touches that setting is refused), and revokes the rule on any exit,
including a rule an earlier interrupted run left behind. Pager off, so no
"(END)" prompt. Writes still go through the migration path or
`oneoff-aurora.sh`.

For anything else (`roster:health`, the go-live checklist SQL), open the
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
that is not one of its modes, and each one exits when done.

Since slice 4 of `docs/scoring-corpus-design.md` the run-task machinery lives
in **`scripts/oneoff-aurora.sh <mode> [args…]`**; `migrate-aurora.sh` is a
one-line wrapper that execs it with `migrate`, so the command above and the
deploy recipe are unchanged. The generalized script takes any entrypoint mode
and passes every argument after it through to the bundled script (the
container-command JSON is built with `jq` when present, by hand otherwise, so
an argument with spaces survives), waits with its own poll loop —
`aws ecs wait tasks-stopped` gives up after 10 minutes, too short for a
Bedrock run, so the ceiling is `TIMEOUT_MINUTES` (default 30) — and exits
with the container's own code.

The importer Lambda and the app service are unaffected by any of this: they
reach the cluster through their own SG→SG rules. Record: Aurora was brought
to 0020 on 2026-08-26 (laptop), 0023 on 2026-08-31 (laptop, count 24), 0024
on 2026-09-01 16:35 PT (laptop, count 25); the first run-task migration was
the no-op proof on 2026-09-01 evening (task `5062e5832a01…`, 45 s from
start to stop, exit 0, `25 … (journal has 25)`).

## Corpus runs on Aurora

The essay-scoring corpus runner (`docs/scoring-corpus-design.md`) is an
operator script, and Aurora is in-VPC, so it runs the same way migrations do
— as a one-off task on the service's task definition, which also means it
scores with the **task role's** Bedrock access and the same guardrail the
service uses.

```bash
# From design-tool/infra/, AWS creds loaded.
# 1. Count what matches, create nothing:
scripts/oneoff-aurora.sh corpus --label "sonnet-4-6 prompt 2026-09-14 vs pilot finals" \
  --with-human-final --dry-run
# 2. The real run (same arguments, minus --dry-run):
scripts/oneoff-aurora.sh corpus --label "sonnet-4-6 prompt 2026-09-14 vs pilot finals" \
  --with-human-final
# 3. Read the numbers:
scripts/oneoff-aurora.sh compare --all --csv
```

- **Always `--dry-run` first.** A filter typo that matches nothing exits 1
  without creating a run; a filter that matches more than you meant spends
  Bedrock tokens on every essay it found.
- The task's `ESSAY_SCORER_PROVIDER` is already `bedrock`, so **`--provider`
  can be omitted** — the runner's default is that env var, then `mock`. Pass
  `--provider mock` deliberately if what you want is a shape check against
  production data with no Bedrock spend.
- **`--model <bedrock model id>`** overrides `BEDROCK_ESSAY_SCORE_MODEL` for
  that run only (the env var on the task definition is untouched); the model
  lands in the run's `provider_id`, which is what tells two runs apart.
- Exit codes come from the script: 0 scored something, 1 nothing matched or
  the label is already used, 2 a bad flag, 64 a bad mode. Progress and the
  final tally are in the printed CloudWatch lines; the tally is also written
  to `scoring_runs.notes`.
- The run writes `research` score rows only — invisible to teachers by
  construction (slice 1) — so a corpus run against production is safe to do
  during the school day. It is not free: it is Bedrock spend attributed to
  the assessment owner in the `ai_usage` log lines, like any other scoring.
- Raise `TIMEOUT_MINUTES` if a run is bigger than half an hour. Hitting the
  ceiling exits 3 and does **not** stop the task — it keeps scoring, and the
  run's rows and notes still land; re-read them with `compare`.

## Seeding pilot essays

Getting AI scoring in front of a teacher needs several submitted essays of
different quality, and producing those through the macOS client means several
real sittings. `seed-essays` writes them straight into the attempt tables
instead, mirroring the join / answer / hand-in routes
(`design-tool/lib/dev/seedEssays.ts`; the essays themselves are in
`lib/dev/sampleEssays.ts`, written against the AP Seminar-style four-source
prompt). Unlike `scripts/seed-attempts.ts` it is **meant** to run against the
deployed database — which is why it discovers nothing: every student is named
explicitly, the assessment must be published, and the sitting must be open and
named by its code.

Pre-steps in the app, in this order:

1. **Publish** the assessment.
2. **Start session** with *Picked students* = exactly the students you are
   about to seed (this script does not check section admission — that
   decision is yours, made here).
3. Copy the **Session code** off the Test sessions tab.

```bash
# From design-tool/infra/, AWS creds loaded.
# 1. Validate everything, write nothing:
scripts/oneoff-aurora.sh seed-essays \
  --assessment <assessment-uuid> --session-code <SESSION-CODE> \
  --student <student-number>=high --student <student-number>=mid \
  --student <student-number>=low --student <student-number>=brief \
  --student <student-number>=offtopic --dry-run
# 2. The real run (same arguments, minus --dry-run):
scripts/oneoff-aurora.sh seed-essays \
  --assessment <assessment-uuid> --session-code <SESSION-CODE> \
  --student <student-number>=high --student <student-number>=mid \
  --student <student-number>=low --student <student-number>=brief \
  --student <student-number>=offtopic
```

- Qualities: `high | mid | low | brief | offtopic`. `brief` is a two-sentence
  non-answer and `offtopic` is fluent prose about something else — both exist
  so the AI's low end can be seen, not just its high end.
- **One attempt per student per assessment.** A re-run refuses and names the
  attempt id; delete that attempt on the student's results page first, then
  re-run. Nothing partial is ever written — a refusal on the fourth student
  means the first three were not seeded either.
- Locally, the same script runs directly:
  `bun --env-file=.env.local scripts/seed-essays.ts …`.
- Exit codes: 0 seeded (or dry-ran), 1 refused with the reason on stderr,
  2 a bad flag.
- Then score them from the **Scoring queue** — this is the path finding R-4
  added the "Score with AI" button to.

## Roster health on Aurora

`scripts/roster-health.ts` is the go-live checklist's SQL in one command, and
the one-off task is the only way to point it at Aurora now that the cluster
security group has no laptop CIDR:

```bash
scripts/oneoff-aurora.sh roster-health                     # counts + last 5 sync runs
scripts/oneoff-aurora.sh roster-health <teacher@psd401.net> # plus that teacher's roster
```

Read-only. Exit 1 means the latest sync run did not succeed.

## Roster sync — local / manual run

The same importer the Lambda runs, pointed at a directory:

```bash
cd .. && DATABASE_URL=postgres://$USER@localhost:5432/secure_test_design_tool_dev \
  bun scripts/roster-import-local.ts /path/to/snapshot-dir
```

Exit 0 = imported, 1 = refused (reason on the JSON line and in `roster_sync_runs`), 2 = usage. Run it on `design-tool/test/fixtures/roster/complete` to see the shape, and on the data engineer's first real extract before any bucket exists.

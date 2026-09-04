# First ECS Fargate deploy of the design tool — proposal (2026-08-31)

Status: SLICES 1–4 BUILT 2026-08-31 (commits acd37e4, f057e2b, e782bfb,
ce3e8eb — see "Build record + slice-5 runbook" at the bottom); slice 5
(Aurora 0023 + deploy + verify) is James's, runbook below. `cdk deploy`
runs are James's throughout. Implements ADR 0014 (ECS Fargate + ALB, extending the
existing `SecureTestDesignTool` stack) with ADR 0017's Google identity in
place of the ClassLink gate ADR 0014 still mentions. Unblocks manual-check
rows 19 (colleague run needs a URL) and 20 (`next/font` at image build).

## What exists / what's missing

Exists: the stack (`design-tool/infra/`, aws-cdk-lib 2.257.0, account
<account-id>, us-west-2) with VPC (public + isolated subnets, no NAT),
Aurora Serverless v2 (0–1 ACU, public subnets, secret
`SecureTestDesignToolCluster-…`), asset bucket + managed policy
`secure-test-design-tool-<env>-asset-access` (attached to nothing — "no app
compute exists yet"), roster bucket + in-VPC importer Lambda. 9.1/9.4 are in
code AND recorded deployed 2026-08-28 19:40 PT (`docs/phase-7-slices.md:98`;
the stale CLAUDE.md line saying otherwise is superseded).

Missing: Dockerfile; `output: "standalone"` in `next.config.ts`; ECR repo;
task role; service SG + SG→SG rule into `ClusterSg` (only the importer's SG
is admitted today); a way to turn the cluster secret JSON into
`DATABASE_URL`; HTTPS (domain + ACM cert — ADR 0014 names neither); Aurora
migration 0023 (last recorded 0022); cold-start handling for the 0-ACU
resume on the web path.

## Slices

1. **Standalone build + Dockerfile.** `output: "standalone"` in
   `next.config.ts`; multi-stage Dockerfile (bun install → `next build` →
   node runner on the standalone output, port 3000; pin the Node base image
   — nothing in the repo pins a version today, `@types/node` ^20).
   Row 20 lives here: the build stage needs egress to fonts.googleapis.com
   for `next/font` (Josefin Sans + Inter) or the TTFs get vendored — decide
   when the first build runs. Local verify: `docker build` + run against
   local Postgres.
2. **CDK: service + ALB + task role.** In `DesignToolStack`: ECR asset
   (CDK `DockerImageAsset` — no separate repo to manage), Fargate service
   (1 task, public subnets w/ public IP per ADR 0014, no NAT), ALB with
   HTTPS listener, service SG (ingress only from ALB SG), SG→SG rule into
   `ClusterSg` on 5432. Task role: attach the existing asset-access policy
   (closes ADR 0008's unchecked grant step), `bedrock:InvokeModel` on the
   `us.` inference profiles AND underlying foundation models for
   Sonnet 4.6 + Haiku 4.5 (ADR 0007:62), `bedrock:ApplyGuardrail` on
   the guardrail (id in context), `secretsmanager:GetSecretValue` on the cluster secret +
   an app-env secret (slice 3).
3. **Env + secrets plumbing.** A small entrypoint assembles `DATABASE_URL`
   (with `sslmode=require`) from `DB_SECRET_ARN` at boot — same pattern as
   the importer Lambda (`syncHandler.ts:databaseUrlFromSecret`). One
   Secrets Manager entry for app secrets: `DESIGN_TOOL_SESSION_SECRET`,
   `DESIGN_TOOL_PKCE_SECRET`, `DESIGN_TOOL_DELIVERY_SECRET`,
   `OIDC_CLIENT_SECRET` (James creates/fills it; the values never enter the
   repo or my hands). Plain env on the task: `NODE_ENV=production`,
   `OIDC_ISSUER`, `OIDC_CLIENT_ID` (web), `OIDC_AUDIENCE=web-id,native-id`
   (both, or the client's `/api/auth/exchange` breaks),
   `OIDC_REDIRECT_URI=https://<origin>/api/auth/callback` (explicit — do
   not trust origin derivation behind the ALB), `STORAGE_PROVIDER=s3`
   (container disk is ephemeral), `S3_BUCKET`, `AWS_REGION=us-west-2`,
   `AI_PROVIDER=bedrock` + model overrides as today,
   `GUARDRAIL_PROVIDER=bedrock`, `GUARDRAIL_ID=<guardrail-id>`,
   `GUARDRAIL_VERSION=1` (code default is DRAFT). `ALLOW_TEST_ISSUER`
   absent (hard-disabled under production anyway).
4. **HTTPS + Google.** Domain (per 1.1): placeholder
   **`<origin>`**, final friendlier name + domain wrapped
   together post-pilot (a rename later costs: cert, one GCP redirect URI,
   `OIDC_REDIRECT_URI`, `SECURE_TEST_SERVER`, and one re-sign-in — nothing
   in the DB stores the origin). The `psd401.ai` zone is outside this
   stack: ACM cert with **DNS validation** — CDK/console emits the
   validation CNAME, James adds it and the ALIAS/CNAME to the ALB (both
   quick per past projects). ALB HTTPS listener + HTTP→HTTPS redirect.
   Without HTTPS the deploy cannot work at all: session/PKCE cookies are
   `secure` under `NODE_ENV=production` (`lib/auth/session.ts:53-62`), so
   a plain-HTTP ALB yields `missing_pkce_cookie` sign-in failures. James
   adds the redirect URI to the web OAuth client in GCP.
5. **Aurora migrate + deploy + verify.** Migration 0023 (fold into the
   Sep 2 pre-flight — internal, see the ops repository). Then the
   deploy, and: staff sign-in at the real origin, roster pages against
   Aurora, an assessment round-trip (S3 asset + Bedrock item gen through
   the task role), client pointed at the origin via `SECURE_TEST_SERVER`,
   row 19 colleague run, row 20 recorded.

## Known risks / accepted shapes

- **Aurora 0-ACU cold start** (~15–90 s observed): the web app has no
  `waitForDatabase` equivalent — the first request after idle can 500.
  Resolved (1.2): `serverlessV2MinCapacity: 0.5` for the pilot (a few
  $/day), revisit post-pilot. Goes into slice 2's stack change. Note the
  importer's `waitForDatabase` becomes dormant but stays (harmless, and
  right again if min ACU ever returns to 0).
- **ALB idle timeout** (default 60 s) vs long AI requests (item gen) —
  raise to 120 s at the listener.
- Public-subnet tasks with public IPs: accepted in ADR 0014; service SG
  admits only the ALB.
- SSE for the monitor becomes possible post-deploy (slice 86 chose polling
  "because nothing is deployed") — not part of this plan.
- `proxy.ts` 500s as text/plain if `DESIGN_TOOL_SESSION_SECRET` is missing
  in the edge runtime — a task-def mistake surfaces as that known item.

## Questions — RESOLVED (James, 2026-08-31)

- 1.1 Domain: **placeholder `<origin>`** now; friendlier
  product name + final domain decided together post-pilot. James handles
  the validation CNAME + ALB record in the psd401.ai zone (quick, per past
  projects).
- 1.2 Cold start: **min ACU 0.5 for the pilot** (recommendation accepted).
- 1.3 Env name: **`dev` now**; `prod` at ADR 0014 phase B.
- 1.4 Fonts: **vendor the TTFs** (recommendation accepted) — Josefin Sans +
  Inter move to `next/font/local`, no build-time egress; closes row 20's
  question deterministically.

## Build record + slice-5 runbook (2026-08-31)

Built slices, with deviations from the plan text called out:

- **Slice 1** (acd37e4): vendored the **latin-subset variable woff2**
  files Google serves (the exact bytes `next/font/google` self-hosted —
  Inter 48KB + Josefin Sans 28KB, `app/fonts/README.md` has provenance),
  not full TTFs — same no-egress outcome, ~25× smaller. Standalone
  output + `outputFileTracingRoot` at the workspace root; multi-stage
  Dockerfile (node:22.23.2-slim + bun 1.3.6 binary, build from REPO
  ROOT: `docker build -f design-tool/Dockerfile .`). Verified in a
  container against local Postgres (login/fonts/proxy/staff-session DB
  round-trip all pass). Docker Desktop turned out to be a dead DMG
  symlink — replaced with **colima** (`colima start`) + docker CLI.
- **Slice 2** (f057e2b): AppService construct — ALB'd Fargate service
  (1 task, 0.5 vCPU/1GB, **ARM64** image + runtime, public subnets, SG
  admits only the ALB), idle timeout 120s, circuit breaker w/ rollback,
  health check = anonymous `/login` 200 (no DB dependency), SG→SG 5432
  into ClusterSg, task role = asset-bucket policy + Bedrock InvokeModel
  (Sonnet 4.6 + Haiku 4.5, profile AND foundation-model ARNs) +
  ApplyGuardrail on the guardrail. Min ACU 0→0.5 (decision 1.2).
- **Slice 3** (e782bfb): DEVIATION — DATABASE_URL is assembled by a boot
  shim (`scripts/docker-entrypoint.mjs`, importer URL shape,
  `sslmode=require`) from **ECS-native secret injection** (per-JSON-key
  DB_* vars), not an SDK GetSecretValue call: the standalone trace lacks
  the SDK, the grant lands on the execution role, no boot-time API call.
  Nothing runtime reads Secrets Manager, so the plan's task-role
  GetSecretValue grant is deliberately absent. Also: code has FOUR
  provider selectors, not one — AI_PROVIDER, MATH_TRANSLATOR_PROVIDER,
  ESSAY_SCORER_PROVIDER, PDF_EXTRACTOR_PROVIDER — all set to `bedrock`
  (all default `mock`). App secret name:
  `secure-test-design-tool/<env>/app-env`.
- **Slice 4** (ce3e8eb): DNS-validated ACM cert (no hostedZone), HTTPS
  listener + HTTP→HTTPS redirect, explicit
  `OIDC_REDIRECT_URI=https://<origin>/api/auth/callback`;
  domain overridable via `--context domainName=…` (or `cdk.context.json`
  — see `design-tool/infra/cdk.context.json.example`).

### Slice 5 progress (2026-08-31 evening)

- Runbook steps 1–3 DONE: app secret created + verified (4 keys, none
  empty; **same values as `.env.local` by James's choice** — dev/local
  are cryptographically one environment); GCP redirect URI added to the
  web client; **migration 0023 applied to Aurora, count = 24** (SG was
  already open via the in-flight deploy's CIDR context — the README's
  "close SG" step no longer applies, the stack owns the rules now).
- First `cdk deploy` attempt failed at ECR login: `~/.docker/config.json`
  still had `credsStore: "desktop"` from the dead Docker Desktop —
  removed (backup `~/.docker/config.json.bak-slice5`); the
  `/usr/local/bin/docker-credential-*` symlinks are dead too, harmless.
- Deploy re-run, image pushed, stack `UPDATE_IN_PROGRESS`, **paused on
  the cert** awaiting DNS validation. Both records sent to the DNS zone owner:
  validation `<validation-subdomain>.<origin>` →
  `_70f67a542fdb4af4149c4217e9bfe9fa.jkddzztszm.acm-validations.aws.`
  (keep permanently — renewal reuses it), and `<origin>` →
  `Secure-AppSe-XXXXXXXXXXXX-XXXXXXXXX.us-west-2.elb.amazonaws.com`.
- Remaining: the DNS zone owner's records land → stack completes on its own (a
  Ctrl-C'd terminal does not cancel it) → step 6 verify.

### Slice 5 verify — DONE 2026-08-31 late evening (client run pending)

The DNS zone owner's records landed (~2 h; validation CNAME kept permanently), the
cert issued, the stack completed. **The design tool is live at
https://<origin>.**

- Automated probes ✅: HTTPS /login 200 valid cert; HTTP→HTTPS 301;
  /dashboard 307→login (proxy + injected session secret working);
  redeem 401 JSON; brand PNG + both vendored fonts 200; 1 task running.
- **Live bug found + fixed the same evening** (22f82d9): sign-in
  succeeded but the callback's final redirect pointed at
  `https://ip-10-0-1-201.us-west-2.compute.internal:3000/…` — in a
  standalone route handler behind the ALB, `new URL(req.url).origin`
  resolves to the TASK's hostname. New `lib/auth/appOrigin.ts`
  (OIDC_REDIRECT_URI's origin, req.url fallback) swapped into the
  callback ×3 + logout. Redeployed; second deploy also shipped
  /api/health (now the ALB health-check target) and the SittingsPanel
  timeouts. Redeploy gotchas, for the record: a stale
  `credsStore: "desktop"` broke ECR login (fixed earlier); a re-run
  with placeholder client ids nearly deployed — caught at the approval
  prompt because James's home IP change forced a SG diff.
- James's rows ✅: staff sign-in → dashboard clean; sign-out clean
  (exercises the fixed logout redirect); roster pages correctly empty
  pre-flip (one overlay row from 08-29, expected); assessment created,
  hand-written item + published; **image upload landed in S3** (fresh
  object via the task role); **Generate-with-AI proposed a correct
  fraction item** (Bedrock Sonnet through the task role; gate is the
  per-assessment "Allow AI help" setting — off by default, and the
  button hides once published).
- Still open: client run against the origin
  (`SECURE_TEST_SERVER=https://<origin>`), row 19 colleague
  run (pre-pilot), row 20 recorded ✅ in
  `docs/design-tool-manual-checks.md`.

### Slice 5 runbook (James — in order)

1. Create + fill the app secret (values from `.env.local` / new ones):
   `aws secretsmanager create-secret --region us-west-2 --name secure-test-design-tool/dev/app-env --secret-string '{"DESIGN_TOOL_SESSION_SECRET":"…","DESIGN_TOOL_PKCE_SECRET":"…","DESIGN_TOOL_DELIVERY_SECRET":"…","OIDC_CLIENT_SECRET":"…"}'`
2. Add the redirect URI to the **web** OAuth client in GCP:
   `https://<origin>/api/auth/callback`.
3. Migration 0023 → Aurora (fold into the Sep 2 pre-flight — internal,
   see the ops repository).
4. Deploy (colima running; from `design-tool/infra/`): `bunx cdk deploy`
   (`--context allowedIngressCidr=…` was part of this command until the
   2026-09-01 infra slice removed CIDR ingress from the stack, and the two
   `--context oidc…ClientId=…` flags until the same evening moved the ids
   into `infra/cdk.json` — they are public identifiers, and CDK never
   persisted the flags; migrations now run in-VPC via
   `infra/scripts/migrate-aurora.sh` AFTER the deploy.)
   The stack will PAUSE on the certificate — add the validation CNAME
   it shows (Certificate Manager console) to the psd401.ai zone, then
   it completes.
5. CNAME `<origin>` → the `AlbDnsName` output.
6. Verify: staff sign-in at https://<origin>, roster pages
   against Aurora, an assessment round-trip (S3 asset + Bedrock item
   gen through the task role), client pointed via `SECURE_TEST_SERVER`,
   manual-check row 19 (colleague run) + row 20 recorded.

### Infra slice — in-VPC migrations, no laptop CIDR (2026-09-01)

- Premise check against the deployed image (task def rev 4): the standalone
  trace DID carry `db/migrate.ts` + all migrations (the whole `design-tool/`
  tree was being traced, `samples/` and `test/` included — now excluded via
  `.dockerignore`), but no bun and no resolvable `drizzle-orm`/`postgres`
  (Next bundles them into the server chunks). `bun run db:migrate` in the
  image was never possible.
- Shape: `db/migrate.ts` → `bun build --target=node` → `db/migrate.mjs` in
  the runner stage; `docker-entrypoint.mjs migrate` imports it instead of
  `server.js` (any other argument exits 64 — no stray server tasks);
  `infra/scripts/migrate-aurora.sh` runs a one-off task on the service's
  task definition + SG + subnets and prints the container log lines.
  `migrate.ts` now resolves `db/migrations` relative to itself and prints
  the applied count against the journal.
- Stack: `allowedIngressCidr` / `CDK_INGRESS_CIDR` / the `IngressWarning`
  output removed; ClusterSg ingress = importer SG + service SG only. The
  hand-rule escape hatch (authorize → use → revoke) is documented in the
  README for `roster:health` / checklist SQL from a laptop.
- RESULT 2026-09-01 evening: deployed 18:56 PT (task def rev 5, rollout
  COMPLETED, /api/health 200; the <former-laptop-ip>/32 rule is gone, the live
  SG shows only the importer + service SG→SG rules). First
  `migrate-aurora.sh` run = the no-op proof: task `5062e5832a01…`, started
  19:01:09 PT, stopped 19:01:54 PT, exit 0, "Essential container in task
  exited", log line `migrations applied — 25 in drizzle.__drizzle_migrations
  (journal has 25), latest 2026-09-01T23:00:41Z`; only the service task
  left running. CDK CLI note from the deploy: 2.1124.1 pinned in
  `infra/bun.lock`, 2.1139.0 available — proposal only.
- DEPLOY 2026-09-01 21:22 PT (E5 slices 1–4 + KaTeX + PDF-import slice 2 + the
  cdk.json ids): `bunx cdk deploy` with no flags, run from the Claude session on
  James's explicit say-so (the auto-mode classifier blocks it otherwise) — image
  rebuilt, task def rev 6, rollout COMPLETED in 219 s; `migrate-aurora.sh` then
  applied migration 0025 as the first real in-VPC migration (task `81dadef5…`,
  26/26); /api/health 200; the item-sets and import-pdf routes answer 401
  unauthenticated on the origin; ClusterSg unchanged (two SG→SG rules).


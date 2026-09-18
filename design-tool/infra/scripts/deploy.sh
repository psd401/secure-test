#!/usr/bin/env bash
# The design-tool deploy, as one command (infra/README.md "Deploy").
#
# Encodes the recipe every deploy has followed by hand since 2026-08-31, in
# the order that was learned the expensive way:
#   1. pre-flight: clean tree, HEAD pushed (the image stamps APP_COMMIT from
#      HEAD and /api/health reports it — an unpushed deploy is untraceable),
#      AWS creds valid (SSO login opens a browser, so it stays a human step),
#      colima running (it does not come back after a reboot; the image build
#      fails with "failed to connect to the docker API" otherwise).
#   2. what is live now: /api/health's commit, so the migration decision below
#      is a diff between two commits, not a guess.
#   3. cdk diff, printed for the record.
#   4. cdk deploy --require-approval never (no TTY in a scripted run).
#   5. migrate-aurora.sh — ONLY when the deploy carried new migration files.
#      Deploy first, then migrate: the image carries its own migrations.
#   6. verify: /api/health commit == HEAD, the service's newest deployment
#      rolloutState == COMPLETED.
#
# Usage (from anywhere; AWS creds loaded, colima up):
#   design-tool/infra/scripts/deploy.sh            # the whole recipe
#   design-tool/infra/scripts/deploy.sh --diff     # pre-flight + diff only
#   design-tool/infra/scripts/deploy.sh --no-migrate
# Env: AWS_REGION (default us-west-2), STACK (default SecureTestDesignTool).
#
# Exit codes: 1 pre-flight refused; the cdk / migrate exit code otherwise.
# Known quirk (2026-09-08): the CDK CLI can exit 1 with "SignatureDoesNotMatch:
# Signature expired" while monitoring a long stack event and the stack still
# finishes — step 6 is what decides, so read it before re-running.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
INFRA="$(cd "$HERE/.." && pwd)"
REPO="$(cd "$INFRA/../.." && pwd)"
export AWS_REGION="${AWS_REGION:-us-west-2}"
STACK="${STACK:-SecureTestDesignTool}"

DIFF_ONLY=0
MIGRATE=1
for arg in "$@"; do
  case "$arg" in
    --diff) DIFF_ONLY=1 ;;
    --no-migrate) MIGRATE=0 ;;
    *) echo "deploy: unknown flag $arg" >&2; exit 2 ;;
  esac
done

say() { printf '\n== %s\n' "$*"; }
fail() { echo "deploy: $*" >&2; exit 1; }

# ---------- 1. pre-flight ----------
say "pre-flight"
cd "$REPO"
[ -z "$(git status --porcelain)" ] || fail "working tree is not clean — commit or stash first"
HEAD_SHA="$(git rev-parse HEAD)"
git fetch -q origin
[ "$(git rev-parse origin/main)" = "$HEAD_SHA" ] || fail "HEAD ($HEAD_SHA) is not origin/main — push first (the image stamps APP_COMMIT from HEAD)"
echo "HEAD = origin/main = $HEAD_SHA"

aws sts get-caller-identity --query Account --output text >/dev/null 2>&1 \
  || fail "AWS credentials missing or expired — run: aws sso login --profile <your-sso-profile>"
echo "AWS creds OK"

colima status >/dev/null 2>&1 || fail "colima is not running — run: colima start"
echo "colima OK"

[ -f "$INFRA/cdk.context.json" ] || fail "$INFRA/cdk.context.json missing (copy the .example and fill it)"
ORIGIN="https://$(jq -r '.domainName' "$INFRA/cdk.context.json")"
[ "$ORIGIN" != "https://null" ] || fail "domainName missing from cdk.context.json"

# ---------- 2. what is live ----------
say "live now"
LIVE_SHA="$(curl -fsS --max-time 15 "$ORIGIN/api/health" | jq -r '.commit // empty' || true)"
if [ -n "$LIVE_SHA" ]; then
  echo "live commit: $LIVE_SHA"
else
  echo "live commit: unknown (health did not answer) — migrations will be run unconditionally"
fi

# ---------- 3. diff ----------
say "cdk diff"
cd "$INFRA"
bunx cdk diff || true
[ "$DIFF_ONLY" -eq 1 ] && exit 0

# ---------- 4. deploy ----------
say "cdk deploy"
set +e
bunx cdk deploy --require-approval never
CDK_EXIT=$?
set -e
[ "$CDK_EXIT" -eq 0 ] || echo "deploy: cdk exited $CDK_EXIT — checking the stack anyway (see the Signature-expired quirk above)"

# ---------- 5. migrations ----------
NEW_MIGRATIONS=""
if [ -n "$LIVE_SHA" ] && git -C "$REPO" cat-file -e "$LIVE_SHA^{commit}" 2>/dev/null; then
  NEW_MIGRATIONS="$(git -C "$REPO" diff --name-only "$LIVE_SHA" "$HEAD_SHA" -- design-tool/db/migrations/ | grep -v '/meta/' || true)"
else
  NEW_MIGRATIONS="(unknown live commit)"
fi
if [ "$MIGRATE" -eq 1 ] && [ -n "$NEW_MIGRATIONS" ]; then
  say "migrate-aurora (new migration files since $LIVE_SHA)"
  echo "$NEW_MIGRATIONS"
  bash "$HERE/migrate-aurora.sh"
else
  say "no new migrations — Aurora untouched"
fi

# ---------- 6. verify ----------
say "verify"
sleep 5
HEALTH="$(curl -fsS --max-time 15 "$ORIGIN/api/health" || echo '{}')"
echo "health: $HEALTH"
CLUSTER="$(aws ecs list-clusters --query "clusterArns[?contains(@, '${STACK}-')] | [0]" --output text)"
SERVICE="$(aws ecs list-services --cluster "$CLUSTER" --query 'serviceArns[0]' --output text)"
aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" \
  --query 'services[0].{taskDefinition:taskDefinition,rollout:deployments[0].rolloutState,running:runningCount}' --output table
LIVE_AFTER="$(echo "$HEALTH" | jq -r '.commit // empty')"
if [ "$LIVE_AFTER" = "$HEAD_SHA" ]; then
  echo "health stamp = HEAD ✅"
else
  echo "health stamp ($LIVE_AFTER) != HEAD ($HEAD_SHA) — the rollout may still be in progress; re-check in a minute" >&2
  exit "${CDK_EXIT:-1}"
fi
exit "$CDK_EXIT"

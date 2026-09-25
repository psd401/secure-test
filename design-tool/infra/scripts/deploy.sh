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
#   2. what is live now: /api/health's commit, and whether this deploy carries
#      new migration files (a diff between two commits, not a guess). DS-2: a
#      deploy that does is refused on weekdays 07:00–15:30 America/Los_Angeles
#      unless --during-school — the old task keeps serving while the new one
#      migrates, and a non-additive migration would break it mid-class.
#   3. cdk diff, printed for the record.
#   4. cdk deploy --require-approval never (no TTY in a scripted run).
#   5. verify: wait (up to DEPLOY_HEALTH_WAIT s, default 600) for /api/health
#      to report HEAD, then print the service's rollout.
#
# Migrations (DS-1, 2026-09-25): the container runs them at boot, before the
# server starts (scripts/docker-entrypoint.mjs), so a health stamp == HEAD also
# proves the new image's migrations applied — the server cannot start
# otherwise. A failing migration leaves the new task unhealthy, the circuit
# breaker rolls back, and the old task keeps serving. migrate-aurora.sh stays
# as the manual fallback (infra/README.md "Migrating Aurora").
#
# Usage (from anywhere; AWS creds loaded, colima up):
#   design-tool/infra/scripts/deploy.sh                  # the whole recipe
#   design-tool/infra/scripts/deploy.sh --diff           # pre-flight + diff only
#   design-tool/infra/scripts/deploy.sh --during-school  # override DS-2
# Env: AWS_REGION (default us-west-2), STACK (default SecureTestDesignTool),
#      DEPLOY_HEALTH_WAIT (seconds, default 600).
#
# Exit codes: 1 pre-flight refused; the cdk exit code otherwise; 1 when the
# health stamp never reaches HEAD.
# Known quirk (2026-09-08): the CDK CLI can exit 1 with "SignatureDoesNotMatch:
# Signature expired" while monitoring a long stack event and the stack still
# finishes — step 5 waits for the health stamp and decides.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
INFRA="$(cd "$HERE/.." && pwd)"
REPO="$(cd "$INFRA/../.." && pwd)"
export AWS_REGION="${AWS_REGION:-us-west-2}"
STACK="${STACK:-SecureTestDesignTool}"

DIFF_ONLY=0
DURING_SCHOOL=0
for arg in "$@"; do
  case "$arg" in
    --diff) DIFF_ONLY=1 ;;
    --during-school) DURING_SCHOOL=1 ;;
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
  echo "live commit: unknown (health did not answer)"
fi
NEW_MIGRATIONS=""
if [ -n "$LIVE_SHA" ] && git -C "$REPO" cat-file -e "$LIVE_SHA^{commit}" 2>/dev/null; then
  NEW_MIGRATIONS="$(git -C "$REPO" diff --name-only "$LIVE_SHA" "$HEAD_SHA" -- design-tool/db/migrations/ | grep -v '/meta/' || true)"
else
  NEW_MIGRATIONS="(unknown live commit — assuming new migrations)"
fi
if [ -n "$NEW_MIGRATIONS" ]; then
  echo "new migrations (the new task applies them at boot):"
  echo "$NEW_MIGRATIONS"
  # DS-2: school hours = Mon–Fri 07:00–15:30 Pacific.
  DOW="$(TZ=America/Los_Angeles date +%u)"
  HM="$(TZ=America/Los_Angeles date +%H%M)"
  if [ "$DOW" -le 5 ] && [ "$((10#$HM))" -ge 700 ] && [ "$((10#$HM))" -lt 1530 ] && [ "$DURING_SCHOOL" -eq 0 ]; then
    fail "this deploy carries migrations and it is school hours (weekday 07:00–15:30 PT) — deploy after 15:30, or pass --during-school if every migration is additive"
  fi
else
  echo "no new migrations"
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

# ---------- 5. verify ----------
# Wait for /api/health to report HEAD: the new task only starts serving once its
# boot-time migrations applied, and the Signature-expired quirk can make cdk
# exit 1 while the stack still finishes. DEPLOY_HEALTH_WAIT bounds the wait.
wait_for_head() {
  local deadline=$(( $(date +%s) + ${DEPLOY_HEALTH_WAIT:-600} )) sha
  while :; do
    sha="$(curl -fsS --max-time 15 "$ORIGIN/api/health" 2>/dev/null | jq -r '.commit // empty' || true)"
    [ "$sha" = "$HEAD_SHA" ] && return 0
    [ "$(date +%s)" -ge "$deadline" ] && return 1
    sleep 20
  done
}
say "verify"
HEAD_LIVE=0
wait_for_head && HEAD_LIVE=1
echo "health: $(curl -fsS --max-time 15 "$ORIGIN/api/health" || echo '{}')"
CLUSTER="$(aws ecs list-clusters --query "clusterArns[?contains(@, '${STACK}-')] | [0]" --output text)"
SERVICE="$(aws ecs list-services --cluster "$CLUSTER" --query 'serviceArns[0]' --output text)"
aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" \
  --query 'services[0].{taskDefinition:taskDefinition,rollout:deployments[0].rolloutState,running:runningCount}' --output table
if [ "$HEAD_LIVE" -eq 1 ]; then
  echo "health stamp = HEAD ✅ (boot-time migrations applied)"
  [ "$CDK_EXIT" -ne 0 ] && echo "deploy: cdk exited $CDK_EXIT but the new image is serving — treated as success"
  exit 0
fi
echo "health stamp never reached HEAD ($HEAD_SHA) — the new task did not go healthy (failed build, failed boot migration, or a rollback). Read the task's logs before re-running." >&2
[ "$CDK_EXIT" -ne 0 ] && exit "$CDK_EXIT"
exit 1

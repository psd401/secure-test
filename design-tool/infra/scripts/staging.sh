#!/usr/bin/env bash
# Start, stop or check the STAGING service (renderer slice 2, D-7 —
# docs/server-delivered-renderer-design.md; infra/README.md "Staging").
#
# The staging stack's ECS service has no DesiredCount in its template, so a
# deploy never changes it: this script is the only thing that does. Aurora
# pauses on its own when idle (min 0 ACU); the first request after a pause
# may fail while it wakes.
#
# Usage (AWS creds for the account loaded):
#   design-tool/infra/scripts/staging.sh up       # one task, wait until stable
#   design-tool/infra/scripts/staging.sh down     # zero tasks
#   design-tool/infra/scripts/staging.sh status   # counts + /api/health
#
# Env: AWS_REGION (default us-west-2). The stack is always
# SecureTestDesignToolStaging — there is no override, so this script can
# never scale production.
set -euo pipefail

export AWS_REGION="${AWS_REGION:-us-west-2}"
STACK="SecureTestDesignToolStaging"
HERE="$(cd "$(dirname "$0")" && pwd)"
INFRA="$(cd "$HERE/.." && pwd)"

ACTION="${1:-status}"
case "$ACTION" in up|down|status) ;; *) echo "usage: staging.sh up|down|status" >&2; exit 2 ;; esac

CLUSTER="$(aws ecs list-clusters --query "clusterArns[?contains(@, '${STACK}-')] | [0]" --output text)"
if [[ -z "$CLUSTER" || "$CLUSTER" == "None" ]]; then
  echo "staging: no ECS cluster for ${STACK} — deploy it first (deploy.sh --staging)" >&2
  exit 2
fi
SERVICE="$(aws ecs list-services --cluster "$CLUSTER" --query 'serviceArns[0]' --output text)"

case "$ACTION" in
  up)
    aws ecs update-service --cluster "$CLUSTER" --service "$SERVICE" --desired-count 1 >/dev/null
    echo "staging: desired 1 — waiting for the service to settle (Aurora may be waking)…"
    aws ecs wait services-stable --cluster "$CLUSTER" --services "$SERVICE" \
      || echo "staging: not stable yet — check status in a minute"
    ;;
  down)
    aws ecs update-service --cluster "$CLUSTER" --service "$SERVICE" --desired-count 0 >/dev/null
    echo "staging: desired 0 — the task stops within a minute"
    ;;
esac

aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" \
  --query 'services[0].{desired:desiredCount,running:runningCount,taskDefinition:taskDefinition}' --output table
DOMAIN="$(jq -r '.staging.domainName // empty' "$INFRA/cdk.context.json" 2>/dev/null || true)"
if [ -n "$DOMAIN" ]; then
  echo "health: $(curl -fsS --max-time 15 "https://$DOMAIN/api/health" 2>/dev/null || echo 'no answer')"
fi

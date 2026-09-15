#!/usr/bin/env bash
# Run a one-off operator script against Aurora from INSIDE the VPC
# (infra/README.md "Migrating Aurora" / "Corpus runs on Aurora").
#
# The cluster SG admits only the importer Lambda and the Fargate service
# (SG→SG); there is no laptop CIDR rule. So one-off work runs as an ECS
# run-task on the app service's own task definition — same image, same
# ECS-injected DB_* secrets, same task role (so Bedrock and the guardrail
# work exactly as they do for the service), same security group, same
# subnets — with the container command overridden to one of the entrypoint's
# modes (design-tool/scripts/docker-entrypoint.mjs). This script waits,
# prints the container's log lines and exits with the container's code.
#
# Usage (AWS creds for the account loaded):
#   design-tool/infra/scripts/oneoff-aurora.sh <mode> [args…]
#
#   oneoff-aurora.sh migrate
#   oneoff-aurora.sh corpus --label "sonnet-4-6 vs pilot finals" \
#       --with-human-final --dry-run
#   oneoff-aurora.sh compare --all --csv
#   oneoff-aurora.sh seed-essays --assessment <uuid> --session-code <code> \
#       --student <student-number>=high --dry-run
#   oneoff-aurora.sh roster-health [teacher@psd401.net]
#
# Every argument after the mode passes through to the bundled script
# untouched (quoted args survive — the overrides JSON is built with jq when
# it is available, and with a JSON string escaper otherwise). The modes are
# whatever the entrypoint accepts; it exits 64 on anything else.
#
# Env: AWS_REGION (default us-west-2), STACK (default SecureTestDesignTool),
#      TIMEOUT_MINUTES (default 30 — a Bedrock corpus run is minutes, not
#      seconds; `aws ecs wait tasks-stopped` caps out at 10 min, so the wait
#      below is our own poll loop).
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: oneoff-aurora.sh <mode> [args…]" >&2
  echo "  modes: migrate, corpus, compare, seed-essays, roster-health" >&2
  exit 2
fi
MODE="$1"
shift

export AWS_REGION="${AWS_REGION:-us-west-2}"
STACK="${STACK:-SecureTestDesignTool}"
CONTAINER="web"
TIMEOUT_MINUTES="${TIMEOUT_MINUTES:-30}"

# Discover everything from the deployed service — names are
# CloudFormation-generated, never hard-code them.
CLUSTER=$(aws ecs list-clusters \
  --query "clusterArns[?contains(@, '${STACK}-')] | [0]" --output text)
if [[ -z "$CLUSTER" || "$CLUSTER" == "None" ]]; then
  echo "oneoff-aurora: no ECS cluster for stack ${STACK}" >&2
  exit 2
fi
SERVICE=$(aws ecs list-services --cluster "$CLUSTER" \
  --query 'serviceArns[0]' --output text)
read -r TASKDEF SUBNETS SGS < <(aws ecs describe-services \
  --cluster "$CLUSTER" --services "$SERVICE" \
  --query 'services[0].[taskDefinition, join(`,`, networkConfiguration.awsvpcConfiguration.subnets), join(`,`, networkConfiguration.awsvpcConfiguration.securityGroups)]' \
  --output text)
read -r LOG_GROUP LOG_PREFIX < <(aws ecs describe-task-definition \
  --task-definition "$TASKDEF" \
  --query "taskDefinition.containerDefinitions[?name=='${CONTAINER}'] | [0].logConfiguration.options.[\"awslogs-group\", \"awslogs-stream-prefix\"]" \
  --output text)

echo "cluster:  ${CLUSTER##*/}"
echo "taskdef:  ${TASKDEF##*/}"
echo "subnets:  ${SUBNETS}  sg: ${SGS}"
echo "command:  ${MODE} $*"

# The container command: node <entrypoint> <mode> [args…]. Built as JSON so
# an argument with spaces ("--label sonnet-4-6 vs pilot finals") survives
# into the override intact.
ENTRY="design-tool/scripts/docker-entrypoint.mjs"
if command -v jq >/dev/null 2>&1; then
  OVERRIDES=$(jq -nc \
    --arg container "$CONTAINER" --arg entry "$ENTRY" --arg mode "$MODE" \
    '{containerOverrides:[{name:$container,command:(["node",$entry,$mode] + $ARGS.positional)}]}' \
    --args -- "$@")
  # The `--` is load-bearing: without it jq reads our leading-dash
  # pass-through arguments (--label, --dry-run) as its own options and dies.
else
  # No jq: escape each argument into a JSON string by hand (backslash and
  # double quote only — anything else a shell hands us is literal).
  json_string() {
    local s=$1
    s=${s//\\/\\\\}
    s=${s//\"/\\\"}
    printf '"%s"' "$s"
  }
  CMD_JSON="$(json_string node),$(json_string "$ENTRY"),$(json_string "$MODE")"
  for arg in "$@"; do
    CMD_JSON="${CMD_JSON},$(json_string "$arg")"
  done
  OVERRIDES="{\"containerOverrides\":[{\"name\":$(json_string "$CONTAINER"),\"command\":[${CMD_JSON}]}]}"
fi

# Public subnets + public IP: the image pull from ECR needs a route out and
# the VPC has no NAT (ADR 0014) — identical to how the service itself runs.
TASK=$(aws ecs run-task \
  --cluster "$CLUSTER" \
  --launch-type FARGATE \
  --task-definition "$TASKDEF" \
  --network-configuration "awsvpcConfiguration={subnets=[${SUBNETS}],securityGroups=[${SGS}],assignPublicIp=ENABLED}" \
  --overrides "$OVERRIDES" \
  --started-by "oneoff-${MODE}" \
  --query 'tasks[0].taskArn' --output text)
TASK_ID="${TASK##*/}"
echo "task:     ${TASK_ID} — waiting up to ${TIMEOUT_MINUTES} min for it to stop"

# `aws ecs wait tasks-stopped` polls every 6 s but gives up after 100
# attempts (10 min), which a Bedrock corpus run can outlast. Poll ourselves
# instead, with a heartbeat so a long run does not look hung.
DEADLINE=$(( $(date +%s) + TIMEOUT_MINUTES * 60 ))
STATUS=""
while :; do
  STATUS=$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK" \
    --query 'tasks[0].lastStatus' --output text)
  [[ "$STATUS" == "STOPPED" ]] && break
  if (( $(date +%s) >= DEADLINE )); then
    echo "oneoff-aurora: still ${STATUS} after ${TIMEOUT_MINUTES} min — giving up on the WAIT," >&2
    echo "  not on the task. It is still running: aws ecs describe-tasks --cluster ${CLUSTER##*/} --tasks ${TASK_ID}" >&2
    exit 3
  fi
  sleep 10
  printf '.'
done
printf '\n'

read -r EXIT_CODE STOP_REASON < <(aws ecs describe-tasks \
  --cluster "$CLUSTER" --tasks "$TASK" \
  --query 'tasks[0].[containers[0].exitCode, stoppedReason]' --output text)

# Log delivery lags the stop by a few seconds.
STREAM="${LOG_PREFIX}/${CONTAINER}/${TASK_ID}"
echo "--- ${LOG_GROUP} / ${STREAM}"
for _ in 1 2 3 4 5; do
  if aws logs get-log-events --log-group-name "$LOG_GROUP" \
      --log-stream-name "$STREAM" --start-from-head \
      --query 'events[].[message]' --output text 2>/dev/null | grep -q .; then
    break
  fi
  sleep 3
done
aws logs get-log-events --log-group-name "$LOG_GROUP" \
  --log-stream-name "$STREAM" --start-from-head \
  --query 'events[].[message]' --output text || true
echo "---"

if [[ "$EXIT_CODE" == "0" ]]; then
  echo "oneoff-aurora ${MODE}: OK (exit 0)"
  exit 0
fi
echo "oneoff-aurora ${MODE}: FAILED — exit ${EXIT_CODE}, stopped: ${STOP_REASON}" >&2
# Exit with the container's own code where there is one, so a corpus run's
# "nothing matched" (1) and a bad flag (2) stay distinguishable; a task that
# never ran its container reports no code at all (None / empty) → 1.
if [[ "$EXIT_CODE" =~ ^[0-9]+$ ]]; then exit "$EXIT_CODE"; fi
exit 1

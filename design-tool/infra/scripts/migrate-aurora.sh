#!/usr/bin/env bash
# Migrate Aurora from INSIDE the VPC (infra/README.md "Migrating Aurora").
#
# The cluster SG admits only the importer Lambda and the Fargate service
# (SG→SG); there is no laptop CIDR rule. So migrations run as a one-off ECS
# run-task on the app service's own task definition — same image, same
# ECS-injected DB_* secrets, same security group, same subnets — with the
# container command overridden to the entrypoint's `migrate` mode
# (design-tool/scripts/docker-entrypoint.mjs → db/migrate.mjs, the bundled
# db/migrate.ts). The task exits when drizzle is done; this script waits,
# prints the container's log lines and exits with the container's code.
#
# Usage (AWS creds for the account loaded; nothing else to pass):
#   design-tool/infra/scripts/migrate-aurora.sh
# Env: AWS_REGION (default us-west-2), STACK (default SecureTestDesignTool).
#
# Idempotent: drizzle applies only what drizzle.__drizzle_migrations lacks.
# Run it after every `cdk deploy` that shipped new migrations — the image
# carries the migrations it was built with, so deploy FIRST, then migrate.
set -euo pipefail

export AWS_REGION="${AWS_REGION:-us-west-2}"
STACK="${STACK:-SecureTestDesignTool}"
CONTAINER="web"

# Discover everything from the deployed service — names are
# CloudFormation-generated, never hard-code them.
CLUSTER=$(aws ecs list-clusters \
  --query "clusterArns[?contains(@, '${STACK}-')] | [0]" --output text)
if [[ -z "$CLUSTER" || "$CLUSTER" == "None" ]]; then
  echo "migrate-aurora: no ECS cluster for stack ${STACK}" >&2
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

# Public subnets + public IP: the image pull from ECR needs a route out and
# the VPC has no NAT (ADR 0014) — identical to how the service itself runs.
TASK=$(aws ecs run-task \
  --cluster "$CLUSTER" \
  --launch-type FARGATE \
  --task-definition "$TASKDEF" \
  --network-configuration "awsvpcConfiguration={subnets=[${SUBNETS}],securityGroups=[${SGS}],assignPublicIp=ENABLED}" \
  --overrides "{\"containerOverrides\":[{\"name\":\"${CONTAINER}\",\"command\":[\"node\",\"design-tool/scripts/docker-entrypoint.mjs\",\"migrate\"]}]}" \
  --started-by migrate-aurora \
  --query 'tasks[0].taskArn' --output text)
TASK_ID="${TASK##*/}"
echo "task:     ${TASK_ID} — waiting for it to stop"

# Polls every 6 s, up to 10 min.
aws ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$TASK"

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
  echo "migrate-aurora: OK (exit 0)"
  exit 0
fi
echo "migrate-aurora: FAILED — exit ${EXIT_CODE}, stopped: ${STOP_REASON}" >&2
exit 1

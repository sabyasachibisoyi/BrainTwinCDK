#!/usr/bin/env bash
#
# Phase 4.0.6 M.3 + M.4.b — Deploy BrainTwinStack with the image tags
# that BrainTwin's build-and-push.sh and build-and-push-caddy.sh just
# produced.
#
# Why this script lives in BrainTwinCDK (not BrainTwin)
# -----------------------------------------------------
# Deployment is the CDK repo's responsibility — it owns `cdk deploy`,
# the infrastructure templates, and CDK bootstrap. The build scripts
# live in BrainTwin because they build BrainTwin's code.
#
# How it threads the tags through
# -------------------------------
#   1. BrainTwin/scripts/build-and-push.sh writes the app tag to
#      BrainTwinCDK/.last-deploy-tag.
#   2. BrainTwin/scripts/build-and-push-caddy.sh writes the caddy tag
#      to BrainTwinCDK/.last-deploy-caddy-tag.
#   3. This script reads both files.
#   4. Passes `--context imageTag=<tag>` AND `--context caddyImageTag=<tag>`
#      to `cdk deploy`.
#   5. bin/braintwin.ts reads both contexts and forwards them to
#      BrainTwinStack via props.
#   6. compute.ts publishes the tags to two SSM String parameters
#      (/braintwin/image_tag, /braintwin/caddy_image_tag). The tags are
#      NOT baked into user-data, so a bump updates only those parameters
#      and never replaces the EC2 (which would deadlock on the single
#      RETAIN EBS volume).
#   7. After `cdk deploy` updates the parameters, this script triggers an
#      in-place refresh over SSM RunCommand: the box re-reads the tags,
#      regenerates docker-compose.yml, and runs `docker compose pull &&
#      up -d`. Container swap in seconds; no instance churn.
#
# Any extra args after the script name are passed through to `cdk
# deploy`, so you can still do things like `--require-approval never`
# or `-v` without modifying the script.
#
# Usage
# -----
#   ./scripts/deploy.sh                          # standard deploy
#   ./scripts/deploy.sh --require-approval never # CI-friendly
#
# Environment overrides:
#   AWS_PROFILE              default: braintwin
#   REGION                   default: us-west-2
#   IMAGE_TAG                deploy this app tag directly, skip tag file
#   CADDY_IMAGE_TAG          deploy this caddy tag directly, skip tag file
#   BRAINTWIN_TAG_FILE       path to the app tag file (default: <repo>/.last-deploy-tag)
#   BRAINTWIN_CADDY_TAG_FILE path to the caddy tag file (default: <repo>/.last-deploy-caddy-tag)
#   ECR_REPO                 app ECR repo to verify against (default: braintwin/app)
#   CADDY_ECR_REPO           caddy ECR repo to verify against (default: braintwin/caddy)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CDK_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

AWS_PROFILE="${AWS_PROFILE:-braintwin}"
REGION="${REGION:-us-west-2}"
# Export so `cdk` and the aws CLI calls below agree on region without
# relying on the profile's default (which may differ from $REGION).
export AWS_REGION="$REGION"

# Stack name mirrors bin/braintwin.ts (`BrainTwinStack-${region}`).
STACK_NAME="BrainTwinStack-$REGION"

# ECR repos the images live in - must match storage.ts.
ECR_REPO="${ECR_REPO:-braintwin/app}"
CADDY_ECR_REPO="${CADDY_ECR_REPO:-braintwin/caddy}"

# ----- Resolve the app image tag --------------------------------------
# Resolution order, most explicit first:
#   1. IMAGE_TAG env var          - fully decoupled from any file.
#   2. BRAINTWIN_TAG_FILE          - explicit path to the tag file.
#   3. $CDK_DIR/.last-deploy-tag   - default sideways drop from build-and-push.sh.
TAG_FILE="${BRAINTWIN_TAG_FILE:-$CDK_DIR/.last-deploy-tag}"

if [[ -n "${IMAGE_TAG:-}" ]]; then
  TAG="$IMAGE_TAG"
else
  if [[ ! -f "$TAG_FILE" ]]; then
    echo "ERROR: $TAG_FILE not found." >&2
    echo "Run BrainTwin/scripts/build-and-push.sh first, or pass IMAGE_TAG=<tag>." >&2
    exit 1
  fi
  IFS= read -r TAG < "$TAG_FILE" || true
  if [[ -z "${TAG// /}" ]]; then
    echo "ERROR: $TAG_FILE is empty." >&2
    echo "Re-run BrainTwin/scripts/build-and-push.sh, or pass IMAGE_TAG=<tag>." >&2
    exit 1
  fi
fi

# ----- Resolve the caddy image tag ------------------------------------
# Same resolution semantics. The caddy tag has a separate file because
# the two images are pushed by separate scripts and bump on different
# cadences (the app changes daily, Caddy every few months).
CADDY_TAG_FILE="${BRAINTWIN_CADDY_TAG_FILE:-$CDK_DIR/.last-deploy-caddy-tag}"

if [[ -n "${CADDY_IMAGE_TAG:-}" ]]; then
  CADDY_TAG="$CADDY_IMAGE_TAG"
else
  if [[ ! -f "$CADDY_TAG_FILE" ]]; then
    echo "ERROR: $CADDY_TAG_FILE not found." >&2
    echo "Run BrainTwin/scripts/build-and-push-caddy.sh first, or pass CADDY_IMAGE_TAG=<tag>." >&2
    exit 1
  fi
  IFS= read -r CADDY_TAG < "$CADDY_TAG_FILE" || true
  if [[ -z "${CADDY_TAG// /}" ]]; then
    echo "ERROR: $CADDY_TAG_FILE is empty." >&2
    echo "Re-run BrainTwin/scripts/build-and-push-caddy.sh, or pass CADDY_IMAGE_TAG=<tag>." >&2
    exit 1
  fi
fi

# ----- Verify both tags exist in ECR -----------------------------------
# Fail fast if either tag isn't actually in ECR. Without this, a stale
# or mistyped tag deploys clean and only surfaces later as an EC2 that
# can't `docker pull`. The ECR repos are created by this stack, so
# this assumes a prior deploy stood them up and images were pushed -
# which is the normal path into this script.
echo "==> Verifying $ECR_REPO:$TAG exists in ECR ($REGION)..."
if ! aws ecr describe-images \
  --repository-name "$ECR_REPO" \
  --image-ids imageTag="$TAG" \
  --profile "$AWS_PROFILE" \
  --region "$REGION" \
  --no-cli-pager >/dev/null 2>&1; then
  echo "ERROR: image $ECR_REPO:$TAG not found in ECR ($REGION, profile $AWS_PROFILE)." >&2
  echo "  Causes: tag never pushed, stale tag file, wrong region/profile, or the" >&2
  echo "  ECR repo isn't created yet (run the first stack deploy + a push)." >&2
  exit 1
fi

echo "==> Verifying $CADDY_ECR_REPO:$CADDY_TAG exists in ECR ($REGION)..."
if ! aws ecr describe-images \
  --repository-name "$CADDY_ECR_REPO" \
  --image-ids imageTag="$CADDY_TAG" \
  --profile "$AWS_PROFILE" \
  --region "$REGION" \
  --no-cli-pager >/dev/null 2>&1; then
  echo "ERROR: image $CADDY_ECR_REPO:$CADDY_TAG not found in ECR ($REGION, profile $AWS_PROFILE)." >&2
  echo "  Run BrainTwin/scripts/build-and-push-caddy.sh first." >&2
  exit 1
fi

echo "==> Deploying BrainTwinStack"
echo "    region         = $REGION"
echo "    profile        = $AWS_PROFILE"
echo "    imageTag       = $TAG"
echo "    caddyImageTag  = $CADDY_TAG"
echo

cd "$CDK_DIR"

# "$@" is safe to forward verbatim under `set -u` even when empty - it's
# a special parameter, no guard needed. Extra cdk flags pass through.
npx cdk deploy \
  --profile "$AWS_PROFILE" \
  --context "region=$REGION" \
  --context "imageTag=$TAG" \
  --context "caddyImageTag=$CADDY_TAG" \
  "$@"

# ----- Trigger an in-place container refresh (Option A) ----------------
# cdk deploy above updated the /braintwin/image_tag + /braintwin/caddy_image_tag
# SSM parameters but did NOT touch the running instance (the tags aren't in
# user-data, so there is no replacement). Tell the box to re-read the tags
# and pull+restart via the refresh script baked into its user-data.
echo
echo "==> Triggering in-place image refresh via SSM RunCommand..."

# All EC2 instances belonging to this stack (usually one).
INSTANCE_IDS=$(aws cloudformation describe-stack-resources \
  --stack-name "$STACK_NAME" \
  --profile "$AWS_PROFILE" --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::EC2::Instance'].PhysicalResourceId" \
  --output text)

if [[ -z "$INSTANCE_IDS" ]]; then
  echo "    No EC2 instances found in $STACK_NAME — nothing to refresh."
  exit 0
fi

# The command first `cloud-init status --wait`s. On a freshly replaced box
# the SSM agent registers early in boot — before user-data has written the
# refresh script — so a naked call would hit "not found" (127). Waiting for
# cloud-init returns immediately on a steady-state box, and on a fresh boot
# blocks until user-data (which already ran the refresh once) finishes; the
# subsequent run is then an idempotent no-op. The `test -x` guard turns a
# genuinely missing script into a clear message instead of a bare 127.
#
# send-command itself can still fail if the instance isn't SSM-registered
# yet; treat that as non-fatal and print the manual re-run.
if ! CMD_ID=$(aws ssm send-command \
  --document-name "AWS-RunShellScript" \
  --instance-ids $INSTANCE_IDS \
  --comment "BrainTwin in-place image refresh (deploy.sh)" \
  --parameters 'commands=["cloud-init status --wait >/dev/null 2>&1 || true","test -x /usr/local/bin/braintwin-refresh.sh || { echo refresh-script-not-found; exit 1; }","/usr/local/bin/braintwin-refresh.sh"]' \
  --profile "$AWS_PROFILE" --region "$REGION" \
  --query "Command.CommandId" --output text 2>/dev/null); then
  echo "    WARNING: could not send the SSM refresh command." >&2
  echo "    If this was a FIRST deploy the box already refreshed at boot." >&2
  echo "    Otherwise the instance may not be SSM-registered yet; re-run:" >&2
  echo "      aws ssm send-command --document-name AWS-RunShellScript \\" >&2
  echo "        --instance-ids $INSTANCE_IDS \\" >&2
  echo "        --parameters 'commands=[\"/usr/local/bin/braintwin-refresh.sh\"]' \\" >&2
  echo "        --profile $AWS_PROFILE --region $REGION" >&2
  exit 0
fi

echo "    Sent command $CMD_ID to: $INSTANCE_IDS"
# Poll for up to 7 minutes. The built-in `ssm wait command-executed` waiter
# tops out around 100s, which is too short when the command is blocked on a
# fresh box's `cloud-init status --wait` (full first boot can take minutes).
for id in $INSTANCE_IDS; do
  echo "    Waiting for refresh on $id (up to 7 min)..."
  deadline=$((SECONDS + 420))
  while true; do
    status=$(aws ssm get-command-invocation \
      --command-id "$CMD_ID" --instance-id "$id" \
      --profile "$AWS_PROFILE" --region "$REGION" \
      --query "Status" --output text 2>/dev/null || echo "Pending")
    case "$status" in
      Success)
        echo "    OK: $id refreshed to imageTag=$TAG caddyImageTag=$CADDY_TAG"
        break
        ;;
      Failed | Cancelled | TimedOut)
        echo "    WARNING: refresh on $id ended in $status. Inspect with:" >&2
        echo "      aws ssm get-command-invocation --command-id $CMD_ID \\" >&2
        echo "        --instance-id $id --profile $AWS_PROFILE --region $REGION" >&2
        break
        ;;
      *)
        if (( SECONDS >= deadline )); then
          echo "    WARNING: refresh on $id still '$status' after 7 min; check manually." >&2
          break
        fi
        sleep 10
        ;;
    esac
  done
done

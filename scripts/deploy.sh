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
#   6. compute.ts interpolates the tags into the EC2 user-data so the
#      boot-time `docker pull` grabs the right images for app + caddy.
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

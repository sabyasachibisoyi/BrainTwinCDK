#!/usr/bin/env bash
#
# Phase 4.0.6 M.3 — Deploy the BrainTwinCDK stack with the image tag
# that BrainTwin's build-and-push.sh just produced.
#
# Why this script lives in BrainTwinCDK (not BrainTwin)
# -----------------------------------------------------
# Deployment is the CDK repo's responsibility — it owns `cdk deploy`,
# the infrastructure templates, and CDK bootstrap. The build script
# lives in BrainTwin because it builds BrainTwin's code.
#
# How it threads the tag through
# ------------------------------
#   1. BrainTwin/scripts/build-and-push.sh writes the tag to
#      BrainTwinCDK/.last-deploy-tag (reaches sideways once).
#   2. This script reads its own local .last-deploy-tag.
#   3. Passes `--context imageTag=<tag>` to `cdk deploy`.
#   4. bin/braintwin.ts reads `app.node.tryGetContext("imageTag")`
#      and forwards it to BrainTwinStack via props.
#   5. M.3 compute.ts will interpolate the tag into the EC2 user-data
#      so the boot-time `docker pull` grabs the right image.
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
#   AWS_PROFILE        default: braintwin
#   REGION             default: us-west-2
#   IMAGE_TAG          deploy this tag directly, ignoring the tag file
#   BRAINTWIN_TAG_FILE path to the tag file (default: <repo>/.last-deploy-tag)
#   ECR_REPO           ECR repo to verify against (default: braintwin/app)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CDK_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

AWS_PROFILE="${AWS_PROFILE:-braintwin}"
REGION="${REGION:-us-west-2}"
# Export so `cdk` and the aws CLI calls below agree on region without
# relying on the profile's default (which may differ from $REGION).
export AWS_REGION="$REGION"

# ECR repo the image lives in — must match storage.ts (brandedLower("app")
# rewritten to a slash path). Overridable in case the repo is renamed.
ECR_REPO="${ECR_REPO:-braintwin/app}"

# Tag resolution, most explicit first:
#   1. IMAGE_TAG env var          — fully decoupled from any file (CI, ad-hoc).
#   2. BRAINTWIN_TAG_FILE          — explicit path to the tag file.
#   3. $CDK_DIR/.last-deploy-tag   — default sideways drop from build-and-push.sh.
# (1)/(2) avoid the fragile assumption that the two repos are siblings.
TAG_FILE="${BRAINTWIN_TAG_FILE:-$CDK_DIR/.last-deploy-tag}"

if [[ -n "${IMAGE_TAG:-}" ]]; then
  TAG="$IMAGE_TAG"
else
  if [[ ! -f "$TAG_FILE" ]]; then
    echo "ERROR: $TAG_FILE not found." >&2
    echo "Run BrainTwin/scripts/build-and-push.sh first, or pass IMAGE_TAG=<tag>." >&2
    exit 1
  fi
  # `read` strips the trailing newline cleanly (unlike $(cat …) it won't
  # carry embedded surrounding whitespace into the tag).
  IFS= read -r TAG < "$TAG_FILE" || true
  if [[ -z "${TAG// /}" ]]; then
    echo "ERROR: $TAG_FILE is empty." >&2
    echo "Re-run BrainTwin/scripts/build-and-push.sh, or pass IMAGE_TAG=<tag>." >&2
    exit 1
  fi
fi

# Fail fast if the tag isn't actually in ECR. Without this, a stale or
# mistyped tag deploys clean and only surfaces later as an EC2 that
# can't `docker pull` (or, with IMMUTABLE tags aged out by lifecycle, a
# recreated instance that can't boot). The ECR repo is created by this
# stack, so this assumes a prior deploy stood it up and an image was
# pushed — which is the normal path into this script.
echo "==> Verifying $ECR_REPO:$TAG exists in ECR ($REGION)…"
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

echo "==> Deploying BrainTwinStack"
echo "    region    = $REGION"
echo "    profile   = $AWS_PROFILE"
echo "    imageTag  = $TAG"
echo

cd "$CDK_DIR"

# "$@" is safe to forward verbatim under `set -u` even when empty — it's
# a special parameter, no guard needed. Extra cdk flags pass through.
npx cdk deploy \
  --profile "$AWS_PROFILE" \
  --context "region=$REGION" \
  --context "imageTag=$TAG" \
  "$@"

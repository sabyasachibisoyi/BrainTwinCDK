#!/usr/bin/env bash
# Populate the SSM SecureString parameters that BrainTwin needs at boot.
#
# Run ONCE before the first M.3 deploy. After this the EC2 can fetch
# the secrets via its instance profile — no static creds anywhere.
#
# Run AGAIN whenever you rotate a secret (e.g. compromised Anthropic
# key). The construct doesn't track values; CDK only manages the
# permissions to read them.
#
# Usage:
#   ./scripts/put-secrets.sh                     # uses AWS_PROFILE=braintwin, AWS_REGION=us-west-2
#   AWS_PROFILE=other ./scripts/put-secrets.sh   # override profile
#
# Values are read interactively. Nothing is echoed to the terminal,
# nothing is logged to history, nothing is committed to git.

set -euo pipefail

REGION="${AWS_REGION:-us-west-2}"
PROFILE="${AWS_PROFILE:-braintwin}"

NAMES=(
  "/braintwin/anthropic_key"
  "/braintwin/bearer_token"
  "/braintwin/telegram_token"
  "/braintwin/cloudflare_api_token"
  "/braintwin/allowed_telegram_user_ids"
)

DESCRIPTIONS=(
  "Anthropic API key (sk-ant-…) — sonnet + haiku calls."
  "Backend bearer token (matches BACKEND_BEARER_TOKEN — same value Chrome extension sends)."
  "Telegram bot token (123456:ABC-DEF…). Leave empty to skip bot."
  "Cloudflare API token (Zone:DNS:Edit + Origin Pull). Used by Caddy for ACME DNS-01 + AOP."
  "Allowed Telegram user IDs (comma-separated, e.g. '123456789,987654321'). Bot rejects messages from anyone else."
)

echo "Populating BrainTwin SSM Parameters in ${REGION} (profile: ${PROFILE})"
echo ""
echo "Each prompt is a SecureString — your input will NOT echo."
echo "Press Enter on an empty value to SKIP that parameter (leaves the"
echo "current SSM value unchanged, or absent if not yet created)."
echo ""

# Sanity: can we hit STS at all?
if ! aws sts get-caller-identity --profile "${PROFILE}" --region "${REGION}" >/dev/null 2>&1; then
  echo "ERROR: aws sts get-caller-identity failed for profile '${PROFILE}'."
  echo "  Run:  aws sso login --profile ${PROFILE}"
  exit 1
fi

for i in "${!NAMES[@]}"; do
  name="${NAMES[$i]}"
  desc="${DESCRIPTIONS[$i]}"

  echo "─── ${name} ───"
  echo "  ${desc}"
  # -s = silent (no echo)
  printf "  value (empty to skip): "
  IFS= read -rs value
  printf "\n"

  if [ -z "${value}" ]; then
    echo "  ↳ skipped (value unchanged)"
    echo ""
    continue
  fi

  # Feed the value via stdin (file:///dev/stdin), NOT as a --value
  # argument — argv is world-readable in `ps` while the CLI runs.
  # printf '%s' avoids appending a trailing newline to the secret.
  printf '%s' "${value}" | aws ssm put-parameter \
    --name "${name}" \
    --type "SecureString" \
    --value "file:///dev/stdin" \
    --overwrite \
    --region "${REGION}" \
    --profile "${PROFILE}" \
    --no-cli-pager \
    >/dev/null

  echo "  ✓ stored as SecureString"
  echo ""

  # Wipe the variable so it can't be leaked by a later `env` dump.
  value=""
  unset value
done

echo "Done."
echo ""
echo "Verify (without revealing values) with:"
echo "  aws ssm describe-parameters --profile ${PROFILE} --region ${REGION} \\"
echo "    --parameter-filters 'Key=Name,Option=BeginsWith,Values=/braintwin/'"

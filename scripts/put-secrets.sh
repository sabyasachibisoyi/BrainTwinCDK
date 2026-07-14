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
  # ---- Phase 4.1 M.M.1.b — Google OAuth + JWT + hidden-onboarding ----
  # The last two exist from Day 0 with placeholder values because the
  # eval-bearer-token AND join-slug are BOTH referenced by IAM/routes
  # long before Phase 4.1 lands (design doc §7.4 + Fable §5.4). Adding
  # them to put-secrets.sh at this milestone keeps discovery-driven
  # M.10 refresh working in one pass instead of two.
  "/braintwin/google_oauth_client_id"
  "/braintwin/google_oauth_client_secret"
  "/braintwin/jwt_secret"
  "/braintwin/eval_bearer_token"
  "/braintwin/join_slug"
)

DESCRIPTIONS=(
  "Anthropic API key (sk-ant-…) — sonnet + haiku calls."
  "Backend bearer token (matches BACKEND_BEARER_TOKEN — same value Chrome extension sends)."
  "Telegram bot token (123456:ABC-DEF…). Leave empty to skip bot."
  "Cloudflare API token (Zone:DNS:Edit + Origin Pull). Used by Caddy for ACME DNS-01 + AOP."
  # ---- Phase 4.1 M.M.1.b entries -------------------------------------
  # google_oauth_client_id is technically PUBLIC (Google shows it in the
  # consent screen URL) but stored as SecureString here for uniformity.
  # No security cost; a tiny convenience cost (must aws ssm get-parameter
  # --with-decryption to read it, same as every other value in this file).
  "Google OAuth 2.0 client_id (…apps.googleusercontent.com). Public but stored SecureString for uniformity. Create at console.cloud.google.com → APIs & Services → Credentials."
  "Google OAuth 2.0 client_secret (GOCSPX-…). Genuinely secret — never put in code. Same Console screen as client_id, revealed once at creation (regenerate if lost)."
  "JWT signing secret (32 random bytes hex). Generate with: openssl rand -hex 32. Bumping this INVALIDATES every live JWT (equivalent to bumping token_version for every user simultaneously) — do that only when doing a hard reset."
  "Long-lived JWT for the dedicated eval user (Phase 4.0.5 §3.5 step 7). Day-0 value: paste the CURRENT /braintwin/bearer_token value here so the nightly eval workflow keeps working; swap to the real eval-user JWT after M.M.1.d lands (design doc §7.4)."
  "URL-safe onboarding slug for the hidden /join/{slug} page (Fable §5.4). Generate with: openssl rand -base64 24 | tr '+/' '-_' | tr -d '='. Never in code, never in README — share the /join/<slug> URL with friends privately (email/Signal)."
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

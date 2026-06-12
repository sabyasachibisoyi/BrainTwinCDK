#!/usr/bin/env bash
# Refresh lib/cloudflare-ips.ts from the canonical source.
#
# Cloudflare publishes its current IPv4 CIDR list at
# https://www.cloudflare.com/ips-v4 as plain text, one CIDR per line.
# This script fetches that file, formats it as a TypeScript module,
# and overwrites lib/cloudflare-ips.ts. The diff is reviewable in
# the resulting PR.
#
# Run quarterly, or whenever Cloudflare publishes a notice that ranges
# have changed (rare — a few times per year).
#
# Usage (from repo root):
#   ./scripts/refresh-cloudflare-ips.sh
#
# What to do after:
#   git diff lib/cloudflare-ips.ts
#   npm test                  # snapshot drift expected on network.test
#   npm test -- -u            # accept the new snapshot
#   git add lib/cloudflare-ips.ts test/__snapshots__/
#   git commit -m "chore(network): refresh Cloudflare IPv4 ranges $(date +%F)"

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="$REPO_ROOT/lib/cloudflare-ips.ts"
TMP="$(mktemp)"

trap 'rm -f "$TMP"' EXIT

echo "Fetching https://www.cloudflare.com/ips-v4 …"
curl -fsSL https://www.cloudflare.com/ips-v4 > "$TMP"

# Fail closed: every non-empty line must be a syntactically valid IPv4
# CIDR. The fetched bytes are written into a TypeScript source file, so
# anything unexpected (proxy interception page, captive portal, format
# change) must abort rather than be injected into code.
BAD=$(grep -vE '^([0-9]{1,3}\.){3}[0-9]{1,3}/[0-9]{1,2}$' "$TMP" | grep -c . || true)
if [ "$BAD" -ne 0 ]; then
  echo "Refusing to overwrite — fetched content contains $BAD line(s) that"
  echo "are not IPv4 CIDRs. Response was probably not the expected plain-"
  echo "text list (proxy page? format change?). Inspect: $TMP"
  trap - EXIT # keep the temp file for inspection
  exit 1
fi

# grep -c, not wc -l: counts CIDR lines even if the final line has no
# trailing newline.
LINES=$(grep -cE '^([0-9]{1,3}\.){3}[0-9]{1,3}/[0-9]{1,2}$' "$TMP")
if [ "$LINES" -lt 5 ]; then
  echo "Refusing to overwrite — fetched only $LINES CIDRs (expected ~15)."
  echo "Cloudflare may be having an outage; try again later."
  exit 1
fi

TODAY="$(date +%Y-%m-%d)"

{
  cat <<EOF
/**
 * Cloudflare's IPv4 ranges — the ONLY source IPs allowed to hit our
 * Elastic IP on port 443.
 *
 * Refreshed: $TODAY from https://www.cloudflare.com/ips-v4
 * Re-pin quarterly with: ./scripts/refresh-cloudflare-ips.sh
 *
 * Why this matters: with these CIDRs in the Security Group ingress
 * rules, packets arriving at the EIP from anywhere ELSE (random
 * scanners, direct attackers) are dropped before they reach the EC2's
 * network stack.
 *
 * Scope of this control: these are Cloudflare's SHARED egress ranges,
 * used by every Cloudflare customer. The SG proves a packet came from
 * a Cloudflare data center — not that it came through OUR zone. An
 * attacker who learns the EIP can front it with their own Cloudflare
 * zone and arrive from an allowed IP, skipping our WAF / rate limits.
 * Zone-level authentication is enforced separately via Cloudflare
 * Authenticated Origin Pulls in compute.ts (M.2.e).
 *
 * Cloudflare changes these very rarely (a handful of times per year).
 * When the refresh script detects a diff, run the CI check + bump:
 *   1. ./scripts/refresh-cloudflare-ips.sh             # rewrites this file
 *   2. npm test                                          # snapshot drift expected
 *   3. npm test -- -u                                    # accept snapshot
 *   4. PR title: "chore(network): refresh Cloudflare IPv4 ranges YYYY-MM-DD"
 *   5. cdk deploy                                        # propagates SG rules
 */
export const CLOUDFLARE_IPV4_RANGES: readonly string[] = [
EOF
  # `|| [ -n "$cidr" ]` keeps the last CIDR even if the file lacks a
  # trailing newline.
  while IFS= read -r cidr || [ -n "$cidr" ]; do
    [ -z "$cidr" ] && continue
    echo "  \"$cidr\","
  done < "$TMP"
  cat <<EOF
];

/**
 * IPv6 is deliberately NOT included here. The Elastic IP is IPv4-only
 * (AWS does charge for IPv6 EIPs). If we later add an IPv6 path we'll
 * mirror with CLOUDFLARE_IPV6_RANGES from /ips-v6.
 */
EOF
} > "$TARGET"

echo "Wrote $LINES CIDRs to $TARGET"
echo ""
echo "Next steps:"
echo "  git diff lib/cloudflare-ips.ts"
echo "  npm test                        # expect snapshot drift in network.test"
echo "  npm test -- -u                  # accept the new snapshot"
echo "  git commit -m \"chore(network): refresh Cloudflare IPv4 ranges $TODAY\""

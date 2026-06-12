/**
 * Cloudflare's IPv4 ranges — the ONLY source IPs allowed to hit our
 * Elastic IP on port 443.
 *
 * Refreshed: 2026-06-11 from https://www.cloudflare.com/ips-v4
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
  "173.245.48.0/20",
  "103.21.244.0/22",
  "103.22.200.0/22",
  "103.31.4.0/22",
  "141.101.64.0/18",
  "108.162.192.0/18",
  "190.93.240.0/20",
  "188.114.96.0/20",
  "197.234.240.0/22",
  "198.41.128.0/17",
  "162.158.0.0/15",
  "104.16.0.0/13",
  "104.24.0.0/14",
  "172.64.0.0/13",
  "131.0.72.0/22",
];

/**
 * IPv6 is deliberately NOT included here. The Elastic IP is IPv4-only
 * (AWS does charge for IPv6 EIPs). If we later add an IPv6 path we'll
 * mirror with CLOUDFLARE_IPV6_RANGES from /ips-v6.
 */

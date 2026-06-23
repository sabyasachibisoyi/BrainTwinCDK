#!/usr/bin/env bash
# Nightly tarball of the Chroma directory → S3.
#
# Runs at 03:30 UTC via the systemd timer (30 min after DLM EBS
# snapshots at 03:00 so the two don't fight for disk IO). 7-day
# retention is enforced by the S3 lifecycle rule in storage.ts.
#
# Account ID + region are resolved from IMDS at runtime; the script
# doesn't need any CDK-time substitution and so lives as a static
# s3.Asset (M.12, Phase 4.0.6.1).
set -euo pipefail

T=$(curl -sX PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")
R=$(curl -sH "X-aws-ec2-metadata-token: $T" http://169.254.169.254/latest/meta-data/placement/region)
A=$(curl -sH "X-aws-ec2-metadata-token: $T" http://169.254.169.254/latest/dynamic/instance-identity/document | jq -r .accountId)
BUCKET="braintwin-state-${A}-${R}"
F="/tmp/chroma-$(date -u +%Y%m%d-%H%M%S).tar.gz"

# tar -C cds into the data dir first, so the archive doesn't carry
# the /var/lib/braintwin/data prefix — restoring extracts straight
# into a data dir.
tar czf "$F" -C /var/lib/braintwin/data chroma
aws s3 cp "$F" "s3://${BUCKET}/chroma-nightly/$(basename "$F")" --region "$R" --no-progress
rm -f "$F"

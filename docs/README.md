# `docs/` — operator runbooks (placeholder)

Cloud-side runbooks live here. The companion repo (`BrainTwin`) holds
application design docs; this folder holds the things an operator
needs to actually run AWS.

## Planned content

| File | When | What |
|------|------|------|
| `m1-local-smoke-test.md` | (kept in BrainTwin) | Local container smoke test |
| `m2-cdk-bootstrap.md` | M.2 | First `cdk deploy` walkthrough |
| `m3-aws-deploy.md` | M.3 | Cloudflare + DNS-01 setup, first cloud serve |
| `m4-litestream-backup.md` | M.4 | Wiring litestream + S3 bucket policy |
| `m5-restore-drill.md` | M.5 | Step-by-step DR walkthrough with timings |
| `ops-on-call.md` | post-deploy | What to do when /health flaps |
| `ops-cost-tuning.md` | post-deploy | Budget overruns, what to throttle first |

Phase deployment design (which decisions were made and why) stays in
`BrainTwin/docs/phase4.0.6-deployment-design.md`. Runbooks here are
how-to-execute, not why-this-design.

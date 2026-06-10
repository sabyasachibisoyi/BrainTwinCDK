# `lib/` — CDK constructs (placeholder)

This folder will hold the CDK stack and any custom constructs. Empty
until **Phase 4.0.6 M.2**.

## Planned shape for M.2

```
lib/
├── braintwin-stack.ts        # the main stack
└── constructs/
    ├── ec2-host.ts            # t4g.small + Graviton AMI + user-data
    ├── ebs-volume.ts          # gp3 20 GB attached to ec2-host
    ├── s3-state.ts            # braintwin-state bucket (lifecycle rules)
    ├── ecr-repos.ts           # ECR repos for braintwin-app, braintwin-bot
    ├── ssm-params.ts          # Parameter Store entries + IAM
    └── observability.ts       # CloudWatch Logs, Budgets, alarms
```

## Construct ID naming convention

Each construct ID in the CDK must match the variable name used in
`diagrams/architecture.py`, so the intent picture and the as-built
picture share labels. Already locked in `architecture.py`:

| `architecture.py` variable | Future CDK construct ID |
|---------------------------|------------------------|
| `caddy`, `app`, `bot`, `litestream` | (docker-compose service names — not CDK) |
| `ebs` | `EbsVolume` |
| `s3_wal` | `StateBucket` |
| `ecr` | `EcrAppRepo`, `EcrBotRepo` |
| `ssm_params` | `ParamAnthropicKey`, `ParamBearerToken`, `ParamTelegramToken` |
| `cwlogs` | `LogGroupApp`, `LogGroupBot` |
| `cwbudget` | `BudgetAlarm` |
| `ssm_session` | (IAM only — no construct ID) |
| `dlm` | `EbsSnapshotPolicy` |

When you change CDK, update `diagrams/architecture.py` to match. The
CI check in Phase 4.0.6.1 will fail PRs that drift.

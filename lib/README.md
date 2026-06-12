# `lib/` — CDK stack + constructs

## Status — Phase 4.0.6 M.2.b/c (shipped)

| File | What it does | Status |
|---|---|---|
| `stack-config.ts` | Typed per-region config (`RegionConfig`) with `availabilityZones: string[]`. Single source of truth for "what does each region look like." | ✅ shipped |
| `braintwin-stack.ts` | `BrainTwinStack` class (extends `cdk.Stack`). Empty body — applies universal tags, holds the typed config. Composition root for M.2.d+ constructs. | ✅ shipped (resource-empty) |
| `constructs/network.ts` | Default VPC + Security Group | M.2.d |
| `constructs/compute.ts` | EC2 + EBS + instance profile (iterates over `config.availabilityZones`) | M.2.e |
| `constructs/storage.ts` | S3 state bucket + ECR repo | M.2.f |
| `constructs/secrets.ts` | SSM Parameter Store (anthropic / bearer / telegram / cloudflare) | M.2.g |
| `constructs/observability.ts` | CloudWatch log groups + AWS Budget + DLM snapshot policy | M.2.h |

After M.2.b/c, `npx cdk synth` produces a real (but resource-empty)
CloudFormation template named `BrainTwinStack-us-west-2` with the
project tags applied.

## AZ-parameterization (design §3.0.1)

`stack-config.ts` exposes `availabilityZones: string[]`. Today every
region has a length-1 list. Adding a cold-standby AZ later is one line:

```ts
availabilityZones: ['us-west-2a', 'us-west-2b'],
```

`compute.ts` (M.2.e) will iterate this list and produce one EC2 + EBS
pair per AZ. Active-active multi-AZ requires Postgres + ALB + external
state and is Phase 5+; the parameterization here only enables cold-
standby and AZ swaps. See design `phase4.0.6-deployment-design.md`
§3.0.1.

## Construct ID naming convention

Each CDK construct ID must match the corresponding node variable in
`BrainTwinCDK/diagrams/architecture.py`, so the intent picture
(`architecture.png`) and the as-built picture (`cdk-generated.png`,
post-M.2) share labels.

| `architecture.py` variable | CDK construct ID | Where it lives |
|---------------------------|------------------|----------------|
| `caddy`, `app`, `bot`, `litestream` | (docker-compose services — not CDK) | n/a |
| `ebs` | `EbsVolume` (one per AZ → `EbsVolume0`, `EbsVolume1`, …) | `compute.ts` |
| `s3_wal` | `StateBucket` | `storage.ts` |
| `ecr` | `EcrAppRepo` | `storage.ts` |
| `ssm_params` | `ParamAnthropicKey`, `ParamBearerToken`, `ParamTelegramToken`, `ParamCloudflareToken` | `secrets.ts` |
| `cwlogs` | `LogGroupApp`, `LogGroupBot` | `observability.ts` |
| `cwbudget` | `BudgetAlarm` | `observability.ts` |
| `ssm_session` | (IAM-only on the instance profile in `compute.ts` — no separate construct) | `compute.ts` |
| `dlm` | `EbsSnapshotPolicy` | `observability.ts` |

When you change CDK, update `architecture.py` to match. The CI check
in Phase 4.0.6.1 will fail PRs that drift the two pictures.

## Resource naming convention (universal — applies to every construct)

Every AWS resource we create gets an explicit name prefixed with
`BrainTwin` so the AWS Console shows at a glance which project owns
it. The convention is **one source of truth in `stack-config.ts`** —
change `BRAND` there, every resource name follows.

Three flavors for three service formats:

| Helper | Output | Use for |
|---|---|---|
| `brandedName("Vpc")` | `BrainTwin-Vpc` | VPC, Security Group, IAM role, EC2 instance, EBS volume, Budget |
| `brandedLower("state")` | `braintwin-state` | S3 bucket name, ECR repo name (must be lowercase) |
| `brandedPath("anthropic")` | `/braintwin/anthropic` | SSM Parameter Store, CloudWatch log groups |

### How this shows up in the AWS Console

For each resource type, we set the name in TWO complementary ways:

1. **Explicit name property** where the construct supports it
   (`vpcName`, `securityGroupName`, `bucketName`, `roleName`, etc.).
   This becomes the actual resource Name AWS shows in console listings.
2. **Tag `Name: "BrainTwin-…"`** via `cdk.Tags.of(construct).add(…)`.
   This is what shows in any console view that has a Name column,
   for resources where there's no explicit name property (EIP, IGW,
   Route Table).

Plus the universal `cdk.Tags.of(this).add("Project", "BrainTwin")` set
at the stack level — this propagates to every child resource, so Cost
Explorer / Resource Groups can filter "all things this project owns."

### Gotcha — named resources can't be replace-updated

For resources where we set an explicit `*Name` property (Security Group,
S3 bucket, etc.), CloudFormation cannot do a *replace* update. If you
ever change a property that would force replacement (e.g. moving a SG
to a different VPC), CloudFormation errors out with "name already
exists." Fix: `cdk destroy && cdk deploy` — fine for a single-stack
project, would be unacceptable in prod with side traffic.

## Verify M.2.b/c is wired correctly

```bash
cd /Users/<you>/Desktop/LLM/BrainTwinCDK

npx cdk synth                               # → BrainTwinStack-us-west-2.template.json in cdk.out/
npx cdk synth --context region=ap-south-1   # → BrainTwinStack-ap-south-1.template.json (parallel stack)
npx cdk synth --context region=eu-west-1    # → throws "Unknown region 'eu-west-1'…"
npm test                                    # → passes (snapshot created on first run)
```

If those four commands behave as documented, M.2.b/c is done; M.2.d
(network construct — default VPC + Security Group) can begin.

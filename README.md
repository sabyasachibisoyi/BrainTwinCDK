# BrainTwinCDK

Infrastructure-as-code for the **DigitalTwin** product (codename: BrainTwin).

This repo holds the AWS CDK TypeScript stack and the cloud topology
diagrams. The application code (FastAPI backend, Chrome extension,
Telegram bot) lives in the companion repo at
**[BrainTwin](https://github.com/<your-github-user>/BrainTwin)**.

> **Naming:** Codename is **BrainTwin** (used for repo, IAM role names,
> stack names, S3 buckets). Public product brand is **DigitalTwin**
> (used in customer-facing UI, the domain `digitaltwin.app`, and docs).
> See `BrainTwin/docs/phase4.0.6-deployment-design.md` §11 for the split.

---

## Status

**Phase 4.0.6 M.2** (CDK skeleton) is the milestone that fills this
repo. As of this commit, only the design artifacts are here:

- `diagrams/architecture.py` — Python `diagrams` topology source
- `diagrams/flow-backup-restore.md` — Mermaid backup + restore drill
- `diagrams/README.md` — three-layer strategy + regen instructions

CDK code (`bin/`, `lib/`, `cdk.json`, `package.json`) will land in M.2.
Until then those folders contain only placeholder READMEs.

---

## Repo layout (planned for M.2)

```
BrainTwinCDK/
├── README.md
├── .gitignore
├── package.json          # ← M.2: npm deps (aws-cdk-lib, constructs)
├── tsconfig.json         # ← M.2
├── cdk.json              # ← M.2: cdk app entrypoint
├── bin/
│   └── braintwin.ts      # ← M.2: stack instantiation, region context
├── lib/
│   └── braintwin-stack.ts  # ← M.2: VPC + EC2 + EBS + S3 + ECR + SSM + IAM
├── diagrams/
│   ├── README.md
│   ├── architecture.py   # → architecture.png (regen locally)
│   ├── architecture.png  # (committed alongside the .py)
│   ├── cdk-generated.png # ← post-M.2: auto from `npx cdk-dia`
│   └── flow-backup-restore.md
└── docs/
    └── ops-runbooks/     # ← Phase 4.0.6.1+: operator runbooks
```

---

## How to use this repo

### Today (pre-M.2)

Just regenerate the topology diagram:

```bash
brew install graphviz
pip install diagrams
python diagrams/architecture.py
```

→ produces `diagrams/architecture.png` next to its source.

### After M.2 lands

```bash
npm install
npx cdk synth                                       # validate
npx cdk diff                                        # see drift vs deployed
npx cdk deploy --context region=us-west-2           # primary region
# npx cdk deploy --context region=ap-south-1        # second region (Phase 5+)
```

---

## Why this is a separate repo from BrainTwin

| Concern | App repo (BrainTwin) | This repo (BrainTwinCDK) |
|---------|---------------------|--------------------------|
| Audience | Product readers, code contributors | Ops / infra reviewers |
| Cadence | Frequent (every feature) | Rare (infra changes) |
| Permissions | Could go public sooner | Stays controlled (account IDs in CDK context) |
| What it deploys | nothing — application only | the AWS account |
| Portfolio signal | "Look how the product works" | "Look, infrastructure as code" |

The split is described in `BrainTwin/docs/phase4.0.6-deployment-design.md`
§3.0–§3.1 and the diagrams-placement rationale is in
`BrainTwin/docs/diagrams/README.md`.

---

## Region strategy (short)

- **Primary:** `us-west-2` (Oregon / PDX) — chosen for Seattle latency
- **Multi-region:** CDK stack is region-parameterized
  (`cdk deploy --context region=…`). A second region is one command;
  it is **NOT** deployed on day one (single user, 2× cost for no
  reliability gain).
- Active-active is a Phase 5+ decision.

Full reasoning in `BrainTwin/docs/phase4.0.6-deployment-design.md` §3.0.

---

## License

Same as BrainTwin (TBD).

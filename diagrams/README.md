# `BrainTwinCDK/diagrams/` — cloud topology

This folder holds the **AWS-side** architecture diagrams. App-behavior
flows (capture, recall, refinement, failure modes) live in the
companion repo at
**[sabyasachibisoyi/BrainTwin/docs/diagrams/](https://github.com/sabyasachibisoyi/BrainTwin/tree/main/docs/diagrams)**.

## What's here

| File | Role |
|------|------|
| `architecture.py` | Source of truth for the AWS topology (Python `diagrams` lib) |
| `architecture.png` | Generated from `architecture.py` (regen locally) |
| `flow-backup-restore.md` | Mermaid sequence for Litestream WAL + Chroma backup, plus the M.5 restore drill |
| `cdk-generated.png` | (Post-M.2) auto-generated from the CDK assembly by `cdk-dia` |

## Three-layer strategy (recap)

| Layer | Tool | Lives in |
|-------|------|----------|
| Topology (intent) | `architecture.py` → PNG | this repo |
| Per-flow lifecycles | Mermaid in `.md` | [BrainTwin/docs/diagrams/](https://github.com/sabyasachibisoyi/BrainTwin/tree/main/docs/diagrams) |
| Topology (reality) | `cdk-dia` against CDK assembly | this repo (post-M.2) |

The intent picture and the reality picture should always match. CI
diff between `architecture.png` and `cdk-generated.png` is what catches
drift.

## Regenerate the topology PNG

One-time setup on your Mac:

```bash
brew install graphviz
pip install diagrams
```

Then any time `architecture.py` changes:

```bash
cd /Users/<you>/Desktop/BrainTwinCDK
python diagrams/architecture.py
# → produces diagrams/architecture.png
```

Commit both files together in the same PR. The CI staleness check
(Phase 4.0.6.1) will fail PRs where the PNG is older than its source.

## Regenerate `cdk-generated.png` (post-M.2)

After the CDK skeleton lands:

```bash
npm install                   # one-time
npx cdk synth                 # builds the cloud assembly
npx cdk-dia                   # → diagrams/cdk-generated.png
```

## Maintenance contract

PRs that add or remove infrastructure resources MUST update:

- `lib/braintwin-stack.ts` (the actual CDK)
- `architecture.py` (and regenerate the PNG)
- A glance check that `architecture.png` and `cdk-generated.png` show
  the same set of nodes and edges

## Why not Miro / Lucidchart / drawio

- **Miro / Lucidchart** — not version-controlled, not PR-reviewable,
  not greppable. Fine for ad-hoc whiteboards; rejected as canonical.
- **drawio** — XML *can* be committed, but the editor is GUI-only so
  PR review shows blob diffs, not human-readable diffs.

Code-as-diagram is the smallest setup that gives both a picture
reviewers can read AND a diff reviewers can review.

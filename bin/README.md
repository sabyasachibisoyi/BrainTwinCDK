# `bin/` — CDK app entrypoint

This folder holds `braintwin.ts`, the CDK App entrypoint.

## Status — Phase 4.0.6 M.2.a (shipped)

`braintwin.ts` instantiates an **empty `cdk.App`** — no stacks defined
yet. `cdk synth` succeeds with an empty cloud assembly. This proves the
toolchain (TypeScript, ts-node, aws-cdk-lib resolution) is wired
correctly. CDK will warn "no stacks were defined" — that's the
green-light signal for this milestone.

## What lands next (M.2.b → M.2.h)

`braintwin.ts` grows to:

```ts
#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { BrainTwinStack } from "../lib/braintwin-stack";
import { CONFIG } from "../lib/stack-config";

const app = new cdk.App();

// Region comes from --context region=… ; defaults to us-west-2 (cdk.json)
const region = app.node.tryGetContext("region") ?? "us-west-2";
const config = CONFIG[region];
if (!config) {
  throw new Error(`Unknown region '${region}'. Add it to lib/stack-config.ts.`);
}

new BrainTwinStack(app, `BrainTwinStack-${region}`, {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region,
  },
  config,
});
```

The region comes from CDK context (default in `cdk.json`); the AZ list
comes from `CONFIG[region].availabilityZones`. Both are config
changes, not code changes, per design §3.0 and §3.0.1.

## Verify M.2.a is wired correctly

```bash
cd /Users/<you>/Desktop/LLM/BrainTwinCDK
npm install            # one-time, ~1 min
npx cdk --version      # should print 2.220.0 (or whatever package.json pins)
npx cdk synth          # → "no stacks were defined" + empty cdk.out/
```

If those three commands succeed, M.2.a is done; M.2.b can begin.

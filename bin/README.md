# `bin/` — CDK app entrypoint (placeholder)

This folder will hold `braintwin.ts`, the entrypoint that instantiates
the stack(s). Empty until **Phase 4.0.6 M.2**.

Expected M.2 shape:

```ts
#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { BrainTwinStack } from "../lib/braintwin-stack";

const app = new cdk.App();

// Region is parameterized so `cdk deploy --context region=ap-south-1`
// works without code changes. Defaults to us-west-2 (Seattle latency).
const region = app.node.tryGetContext("region") ?? "us-west-2";

new BrainTwinStack(app, `BrainTwinStack-${region}`, {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region,
  },
  // Per-region context: budget threshold, AZ, etc. could differ.
});
```

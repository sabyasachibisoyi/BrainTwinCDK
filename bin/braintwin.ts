#!/usr/bin/env node
/**
 * BrainTwinCDK — CDK App entrypoint.
 *
 * Phase 4.0.6 M.2.b/c: instantiates a real (but resource-empty)
 * BrainTwinStack with the typed RegionConfig for whichever region
 * the user passed via `--context region=...`.
 *
 * Defaults to us-west-2 (Seattle latency, per design §3.0). Override:
 *
 *   npx cdk synth --context region=ap-south-1
 *   npx cdk deploy --context region=us-west-2 --profile braintwin
 *
 * The 12-digit AWS account ID comes from process.env.CDK_DEFAULT_ACCOUNT,
 * which the AWS CLI sets when you run `cdk` with an active profile.
 * Never commit the account ID to code.
 *
 * Stack name embeds the region so a future second-region deploy
 * produces a parallel stack rather than colliding with the first one.
 */
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { BrainTwinStack } from "../lib/braintwin-stack";
import { getConfig } from "../lib/stack-config";

const app = new cdk.App();

// Region resolution order: --context region=… overrides; otherwise the
// default from cdk.json's context block (us-west-2). getConfig throws a
// clear error if the value isn't in CONFIG, which prevents typos from
// reaching CloudFormation as garbage stack names.
const region = (app.node.tryGetContext("region") as string) ?? "us-west-2";
const config = getConfig(region);

new BrainTwinStack(app, `BrainTwinStack-${region}`, {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region,
  },
  config,
  description: `DigitalTwin / BrainTwin stack — ${region} — Phase 4.0.6 M.2.b/c scaffold`,
});

app.synth();

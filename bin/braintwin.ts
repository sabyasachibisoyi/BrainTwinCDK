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

// Image tag the EC2 user-data will `docker pull` at boot. Default
// "bootstrap" is a synth-safe placeholder so `cdk synth` works without
// having to run build-and-push first. Real deploys must override:
//   ../BrainTwin/scripts/build-and-push.sh writes the chosen tag to
//     this repo's .last-deploy-tag (it reaches sideways once),
//   scripts/deploy.sh reads it and passes --context imageTag=<tag>.
// ECR is configured with IMMUTABLE tags (storage.ts), so each push is
// a distinct unique tag (snapshot-<git-sha> or v<MAJOR>.<MINOR>.<PATCH>).
const imageTag =
  (app.node.tryGetContext("imageTag") as string) ?? "bootstrap";

// Caddy image tag — same plumbing pattern as imageTag above. M.4.b's
// user-data runs `docker pull <registry>/braintwin/caddy:<caddyImageTag>`
// for the TLS edge container. Default "bootstrap" so the first deploy
// after M.4.a (which only creates the ECR repo) doesn't fail synth.
// Real deploys come from BrainTwin/scripts/build-and-push-caddy.sh +
// BrainTwinCDK/scripts/deploy.sh's --context caddyImageTag=<tag>.
const caddyImageTag =
  (app.node.tryGetContext("caddyImageTag") as string) ?? "bootstrap";

new BrainTwinStack(app, `BrainTwinStack-${region}`, {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region,
  },
  config,
  imageTag,
  caddyImageTag,
  // Plain ASCII hyphen only — the CloudFormation console renders
  // non-ASCII punctuation (em dash) as "?" in the description column.
  description: `BrainTwin stack - ${region}`,
});

app.synth();

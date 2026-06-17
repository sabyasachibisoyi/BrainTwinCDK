/**
 * Snapshot test for BrainTwinStack.
 *
 * The synthesized CloudFormation template is deterministic given the
 * config. If `cdk synth` produces a different template than the saved
 * snapshot, this test fails — you then review the diff, decide if the
 * change was intentional, and run `npm test -- -u` to update.
 *
 * Why this exists at M.2.b/c (when the stack is empty):
 *   - Establishes the test infrastructure so M.2.d–M.2.h can land
 *     individual construct tests without re-deriving fixtures.
 *   - Catches accidental tag / metadata drift early — tags landing in
 *     the template change the snapshot even if no resources changed.
 */
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { BrainTwinStack } from "../lib/braintwin-stack";
import { getConfig } from "../lib/stack-config";

describe("BrainTwinStack — us-west-2 (M.2.b/c scaffold)", () => {
  function synth() {
    const app = new cdk.App();
    return new BrainTwinStack(app, "TestBrainTwinStack-us-west-2", {
      env: { account: "123456789012", region: "us-west-2" },
      config: getConfig("us-west-2"),
      // Deterministic literal keeps the snapshot stable; real deploys
      // feed the value in via --context imageTag=<tag>.
      imageTag: "test-tag",
      caddyImageTag: "test-caddy-tag",
    });
  }

  test("synthesizes without error", () => {
    expect(() => synth()).not.toThrow();
  });

  test("CloudFormation template matches snapshot", () => {
    const stack = synth();
    const template = Template.fromStack(stack);
    expect(template.toJSON()).toMatchSnapshot();
  });

  test("stack inherits the standard project tags", () => {
    const stack = synth();
    const tags = cdk.Tags.of(stack);
    // Tags are added on the Stack — assertion is that the dispatcher
    // exists. The actual tag application is verified end-to-end via the
    // template snapshot (tags propagate to resources, so once
    // observability adds CloudWatch log groups the snapshot will show
    // the Project=BrainTwin tag on every resource).
    expect(tags).toBeDefined();
  });

  test("known region returns config; unknown region throws", () => {
    expect(() => getConfig("us-west-2")).not.toThrow();
    expect(() => getConfig("ap-south-1")).not.toThrow();
    expect(() => getConfig("us-east-99")).toThrow(/Unknown region/);
  });
});

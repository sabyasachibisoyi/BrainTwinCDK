/**
 * SecretsConstruct unit tests — Phase 4.0.6 M.2.g.
 *
 * The construct doesn't create the SSM parameters (CFN cannot, see
 * the docstring on secrets.ts). What we DO test:
 *
 *   - The four canonical names are exposed and lowercase-path-formatted.
 *   - The IAM grant scopes GetParameter to exactly these five ARNs
 *     (no `*` leak).
 *   - The KMS Decrypt grant is scoped to the SSM-managed key, not
 *     arbitrary KMS keys in the account.
 *   - The CFN output advertises the parameter names so the operator
 *     knows which to populate.
 *
 * If any of these regress, the failure mode is real: either the EC2
 * can read OTHER projects' secrets (over-permission) or our app can't
 * boot (under-permission).
 */
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { BrainTwinStack } from "../../lib/braintwin-stack";
import { getConfig } from "../../lib/stack-config";

function makeStack(): cdk.Stack {
  const app = new cdk.App();
  return new BrainTwinStack(app, "TestStack-us-west-2", {
    env: { account: "123456789012", region: "us-west-2" },
    config: getConfig("us-west-2"),
    imageTag: "test-tag",
    caddyImageTag: "test-caddy-tag",
  });
}

/**
 * Find a CFN output whose Value is a literal string containing `needle`.
 * Other outputs in the stack carry token objects (Fn::GetAtt etc.), so a
 * naive `.includes` on every Value throws — only strings qualify.
 */
function findStringOutput(
  t: Template,
  needle: string,
): { Value: string; Description?: string } | undefined {
  const outputs = t.findOutputs("*");
  return Object.values(outputs).find(
    (o): o is { Value: string; Description?: string } =>
      typeof o.Value === "string" && o.Value.includes(needle),
  );
}

describe("SecretsConstruct", () => {
  describe("Parameter names", () => {
    test("expected /braintwin/* paths are exposed", () => {
      // We can't directly inspect the construct from the synth output —
      // but the CFN output value carries the full list. Easier and
      // safer: assert the output value contains every expected name.
      const t = Template.fromStack(makeStack());
      const paramListOutput = findStringOutput(t, "/braintwin/anthropic_key");
      expect(paramListOutput).toBeDefined();
      const value = paramListOutput!.Value;
      expect(value).toContain("/braintwin/anthropic_key");
      expect(value).toContain("/braintwin/bearer_token");
      expect(value).toContain("/braintwin/telegram_token");
      expect(value).toContain("/braintwin/cloudflare_api_token");
    });

    test("parameter names are lowercase-path style (no PascalCase leakage)", () => {
      const t = Template.fromStack(makeStack());
      const paramListOutput = findStringOutput(t, "/braintwin/");
      expect(paramListOutput).toBeDefined();
      const value = paramListOutput!.Value;
      // Path-style only — no capital letters in the names. This catches
      // someone accidentally importing brandedName() instead of brandedPath().
      expect(value).not.toMatch(/BrainTwin-/);
    });
  });

  describe("CFN output advertises the parameter list", () => {
    test("output description tells the operator HOW to populate them", () => {
      const t = Template.fromStack(makeStack());
      const paramListOutput = findStringOutput(t, "/braintwin/anthropic_key");
      expect(paramListOutput).toBeDefined();
      const desc = paramListOutput!.Description as string;
      // The description should mention either the helper script or the
      // raw `aws ssm put-parameter` invocation — without that, the
      // operator's first deploy will fail with "parameter not found"
      // and there's no breadcrumb.
      const mentionsHowTo =
        desc.includes("put-secrets.sh") || desc.includes("put-parameter");
      expect(mentionsHowTo).toBe(true);
    });
  });

  describe("IAM grant — scoped, not wildcard", () => {
    test("instance role gets ssm:GetParameter on exactly the five ARNs", () => {
      const t = Template.fromStack(makeStack());
      const policies = t.findResources("AWS::IAM::Policy");
      const policyTexts = Object.values(policies).map((p) =>
        JSON.stringify(p.Properties.PolicyDocument),
      );

      // The grant should mention each parameter name (or a Fn::Join
      // that includes them). Easiest: stringify, look for substrings.
      const concat = policyTexts.join("\n");
      expect(concat).toContain("/braintwin/anthropic_key");
      expect(concat).toContain("/braintwin/bearer_token");
      expect(concat).toContain("/braintwin/telegram_token");
      expect(concat).toContain("/braintwin/cloudflare_api_token");
      // M.7.5 added this one — bot allowlist.
      expect(concat).toContain("/braintwin/allowed_telegram_user_ids");

      // GetParameter action must be present
      expect(concat).toContain("ssm:GetParameter");
    });

    test("grant does NOT use a wildcard resource (`*`) for SSM", () => {
      // The classic over-permission. If someone refactors and replaces
      // the scoped resource list with "*", the EC2 could read every
      // SSM parameter in the account.
      const t = Template.fromStack(makeStack());
      const policies = t.findResources("AWS::IAM::Policy");
      for (const policy of Object.values(policies)) {
        const statements = policy.Properties.PolicyDocument.Statement;
        for (const stmt of statements) {
          if (
            Array.isArray(stmt.Action)
              ? stmt.Action.includes("ssm:GetParameter")
              : stmt.Action === "ssm:GetParameter"
          ) {
            // Resource must be a list or a Fn::Join — never the literal "*".
            expect(stmt.Resource).not.toBe("*");
          }
        }
      }
    });

    test("M.10: instance role gets ssm:GetParametersByPath scoped to /braintwin/*", () => {
      // The discovery pattern needs GetParametersByPath in addition to
      // GetParameter. Without this grant, the refresh script's single
      // `aws ssm get-parameters-by-path` call 403s and boot fails.
      // The scope is /braintwin and /braintwin/* (path + everything
      // under it) — broad enough to discover any future param the
      // operator adds via put-secrets.sh, but tight enough that the
      // EC2 can't enumerate the rest of the account's SSM tree.
      const t = Template.fromStack(makeStack());
      const policies = t.findResources("AWS::IAM::Policy");
      const concat = Object.values(policies)
        .map((p) => JSON.stringify(p.Properties.PolicyDocument))
        .join("\n");
      expect(concat).toContain("ssm:GetParametersByPath");
      expect(concat).toContain("parameter/braintwin");
      // The path-scoped ARN must NOT be a wildcard on ssm tree-roots
      // (e.g., `parameter/*`). If someone widens it accidentally,
      // discovery starts pulling secrets from OTHER apps.
      for (const policy of Object.values(policies)) {
        const statements = policy.Properties.PolicyDocument.Statement;
        for (const stmt of statements) {
          const actions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action];
          if (!actions.includes("ssm:GetParametersByPath")) continue;
          const resources = Array.isArray(stmt.Resource) ? stmt.Resource : [stmt.Resource];
          for (const r of resources) {
            const rs = typeof r === "string" ? r : JSON.stringify(r);
            // Must mention "braintwin"; must NOT be a bare "*".
            expect(rs).not.toBe("*");
            expect(rs).toContain("braintwin");
          }
        }
      }
    });
  });

  describe("KMS decrypt — scoped via service", () => {
    test("grants kms:Decrypt with kms:ViaService = ssm.<region>.amazonaws.com", () => {
      const t = Template.fromStack(makeStack());
      const policies = t.findResources("AWS::IAM::Policy");
      let foundScopedKmsDecrypt = false;

      for (const policy of Object.values(policies)) {
        const statements = policy.Properties.PolicyDocument.Statement;
        for (const stmt of statements) {
          const actions = Array.isArray(stmt.Action)
            ? stmt.Action
            : [stmt.Action];
          if (!actions.includes("kms:Decrypt")) continue;

          // The condition must restrict the KMS use to the SSM service.
          const condition = stmt.Condition?.StringEquals;
          if (
            condition &&
            (condition["kms:ViaService"] === "ssm.us-west-2.amazonaws.com" ||
              (typeof condition["kms:ViaService"] === "string" &&
                condition["kms:ViaService"].includes("ssm.")))
          ) {
            foundScopedKmsDecrypt = true;
          }
        }
      }

      expect(foundScopedKmsDecrypt).toBe(true);
    });
  });
});

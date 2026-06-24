/**
 * SecretsConstruct — SSM Parameter Store names + IAM grants.
 *
 * Phase 4.0.6 M.2.g. This construct does **NOT** create the parameters.
 * It declares their canonical names, exposes them as public fields, and
 * provides a `grantReadAll(role)` helper that scopes IAM permissions to
 * exactly these names plus the SSM-managed KMS decrypt.
 *
 * ## Why CDK doesn't create the parameters
 *
 * CloudFormation CANNOT create `SecureString` parameters. The reason is
 * structural: the encrypted value would have to live in the template,
 * which defeats the entire point of having a secret. The CFN spec
 * explicitly forbids it.
 *
 * Two ways people work around this:
 *
 *   1. **Create as plain `String` with a placeholder, then manually
 *      flip to SecureString.** Sketchy: the placeholder lands in
 *      `cdk.out/`, and the operator must remember to `--type
 *      SecureString` on every override or it stays unencrypted.
 *   2. **Create out of band, reference by name in CDK.** Clean: real
 *      SecureString from the first byte, no placeholder leakage,
 *      CDK just declares the contract ("here's what we expect to
 *      exist; here's who can read it").
 *
 * We pick (2). The operator runs `scripts/put-secrets.sh` once before
 * the first M.3 deploy; this construct is the source of truth for
 * which parameters exist and who can read them.
 *
 * ## The four parameters
 *
 *   /braintwin/anthropic_key         — Sonnet + Haiku API key
 *   /braintwin/bearer_token          — backend BACKEND_BEARER_TOKEN
 *                                       (Chrome extension + bot share it)
 *   /braintwin/telegram_token        — bot TELEGRAM_BOT_TOKEN
 *   /braintwin/cloudflare_api_token  — Caddy uses it for DNS-01 ACME
 *                                       challenges (TLS cert renewals)
 *                                       + Authenticated Origin Pulls
 *
 * All four are SecureStrings encrypted with the default AWS-managed KMS
 * key `alias/aws/ssm`. The EC2 retrieves them at boot via
 * `aws ssm get-parameter --with-decryption` (handled by the M.3
 * user-data template).
 *
 * ## Why permissions are SCOPED to these names
 *
 * The naive way would be to grant `ssm:GetParameter` on `*` — works
 * but leaks. If a future construct (or a misconfiguration) creates an
 * unrelated `/somebody-elses/secret`, the EC2 could read it.
 *
 * We scope the IAM resource list to exactly these four parameter ARNs.
 * Least privilege: if someone adds a new secret, they must update this
 * construct (and the M.3 user-data, and the test). That friction is the
 * point.
 *
 * ## KMS decrypt permission
 *
 * Reading a SecureString takes TWO API calls under the hood:
 *
 *   1. `ssm:GetParameter` — returns the encrypted blob
 *   2. `kms:Decrypt`      — decrypts client-side
 *
 * Without #2 the EC2 sees ciphertext. We grant Decrypt on
 * `alias/aws/ssm` (the AWS-managed key the parameters were encrypted
 * with).
 */
import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import { brandedPath, RegionConfig } from "../stack-config";

export interface SecretsConstructProps {
  readonly config: RegionConfig;
}

export class SecretsConstruct extends Construct {
  /** /braintwin/anthropic_key — Sonnet + Haiku API key. */
  public readonly anthropicKeyName: string;
  /** /braintwin/bearer_token — backend BACKEND_BEARER_TOKEN. */
  public readonly bearerTokenName: string;
  /** /braintwin/telegram_token — Telegram bot token (optional, may be empty). */
  public readonly telegramTokenName: string;
  /** /braintwin/cloudflare_api_token — Caddy DNS-01 ACME + AOP. */
  public readonly cloudflareApiTokenName: string;
  /**
   * /braintwin/allowed_telegram_user_ids — comma-separated allowlist of
   * Telegram user IDs the bot will accept messages from. Stored as a
   * SecureString for consistency with the rest of the secrets bag,
   * though strictly the value isn't a secret (a Telegram user ID is
   * akin to a public username). M.7.5 added this — before, the
   * operator had to SSH in and append to /etc/braintwin/secrets.env
   * by hand, which got wiped on every instance replacement.
   */
  public readonly allowedTelegramUserIdsName: string;

  /** All five parameter names, in deterministic order — useful for outputs and the helper script. */
  public readonly allParameterNames: readonly string[];

  /** Fully-qualified ARNs of each parameter, for tightly-scoped IAM. */
  private readonly parameterArns: string[];

  constructor(scope: Construct, id: string, _props: SecretsConstructProps) {
    super(scope, id);

    this.anthropicKeyName = brandedPath("anthropic_key");
    this.bearerTokenName = brandedPath("bearer_token");
    this.telegramTokenName = brandedPath("telegram_token");
    this.cloudflareApiTokenName = brandedPath("cloudflare_api_token");
    this.allowedTelegramUserIdsName = brandedPath("allowed_telegram_user_ids");

    this.allParameterNames = [
      this.anthropicKeyName,
      this.bearerTokenName,
      this.telegramTokenName,
      this.cloudflareApiTokenName,
      this.allowedTelegramUserIdsName,
    ];

    const { partition, region, account } = cdk.Stack.of(this);

    // SSM ARN format: arn:<partition>:ssm:<region>:<account>:parameter/path
    // Note: the parameter name already starts with "/" (brandedPath
    // prepends it), so we don't add another slash here.
    this.parameterArns = this.allParameterNames.map(
      (name) => `arn:${partition}:ssm:${region}:${account}:parameter${name}`,
    );

    // CloudFormation output — tells the operator exactly which
    // parameters to populate via scripts/put-secrets.sh.
    new cdk.CfnOutput(this, "ParameterNames", {
      value: this.allParameterNames.join(","),
      description:
        "SSM SecureString parameters the app reads at boot. Populate " +
        "BEFORE first M.3 deploy using scripts/put-secrets.sh (or one " +
        "`aws ssm put-parameter --type SecureString --name <name> " +
        "--value <value>` per param).",
    });
  }

  /**
   * Attach IAM permissions to `role` for reading every parameter this
   * construct manages, plus the KMS decrypt needed for SecureStrings.
   *
   * Scoped: GetParameter is restricted to exactly the five secret ARNs,
   * GetParametersByPath to /braintwin/*, and Decrypt to the AWS-managed
   * SSM KMS key. The role cannot read OTHER projects' SSM parameters.
   */
  public grantReadAll(role: iam.IRole): void {
    const { partition, region, account } = cdk.Stack.of(this);

    // 1. GetParameter on exactly the five secret ARNs. As of M.10 the
    //    refresh script reads these via GetParametersByPath (statement
    //    2), so nothing in user-data calls GetParameter on them today —
    //    this is kept as defense for ad-hoc ops (`aws ssm get-parameter
    //    --name /braintwin/anthropic_key`). NOTE: image_tag /
    //    caddy_image_tag are NOT covered here; they get their own
    //    grantRead() in compute.ts.
    role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter", "ssm:GetParameters"],
        resources: this.parameterArns,
      }),
    );

    // 2. (M.10) Allow GetParametersByPath on /braintwin/* so the refresh
    //    script can discover the full secret bag in one call. This is
    //    the action that makes "adding a new secret = put-secrets.sh +
    //    refresh.sh" possible without a CDK edit + instance replacement.
    //    The resource path covers any current/future parameter under
    //    /braintwin/, not the rest of the account.
    role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParametersByPath"],
        resources: [
          `arn:${partition}:ssm:${region}:${account}:parameter/braintwin`,
          `arn:${partition}:ssm:${region}:${account}:parameter/braintwin/*`,
        ],
      }),
    );

    // 3. Decrypt the SecureString blob via KMS
    //    The parameters use the AWS-managed key `alias/aws/ssm`, whose
    //    key ID isn't referenceable from CloudFormation. So we allow
    //    Decrypt on any key in the account BUT require the call to come
    //    through SSM (kms:ViaService) — which only the SSM-managed key
    //    path satisfies for GetParameter --with-decryption.
    role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ["kms:Decrypt"],
        resources: [`arn:${partition}:kms:${region}:${account}:key/*`],
        conditions: {
          // Only the SSM-managed key, not any other KMS key in the
          // account. ViaService is the standard pattern for scoping
          // KMS grants to a specific service.
          StringEquals: {
            "kms:ViaService": `ssm.${region}.amazonaws.com`,
          },
        },
      }),
    );
  }
}

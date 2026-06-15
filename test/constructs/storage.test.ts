/**
 * StorageConstruct unit tests — Phase 4.0.6 M.2.f.
 *
 * Asserts the security-sensitive properties (public access blocked,
 * encryption, TLS required, RETAIN on stack delete) and the
 * cost-control levers (lifecycle rules per prefix, ECR image counts).
 *
 * If any of these break, the regression class is real: leaked backups,
 * accidental data deletion, or unbounded storage cost growth.
 */
import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { BrainTwinStack } from "../../lib/braintwin-stack";
import { getConfig } from "../../lib/stack-config";

function makeStack(): cdk.Stack {
  const app = new cdk.App();
  return new BrainTwinStack(app, "TestStack-us-west-2", {
    env: { account: "123456789012", region: "us-west-2" },
    config: getConfig("us-west-2"),
    imageTag: "test-tag",
  });
}

describe("StorageConstruct", () => {
  describe("S3 state bucket — security properties", () => {
    test("exactly one S3 bucket is created", () => {
      const t = Template.fromStack(makeStack());
      t.resourceCountIs("AWS::S3::Bucket", 1);
    });

    test("bucket name is globally-unique-by-construction", () => {
      // braintwin-state-<account>-<region> → "braintwin-state-123456789012-us-west-2"
      const t = Template.fromStack(makeStack());
      t.hasResourceProperties("AWS::S3::Bucket", {
        BucketName: "braintwin-state-123456789012-us-west-2",
      });
    });

    test("encryption is on (SSE-S3, AES256)", () => {
      const t = Template.fromStack(makeStack());
      t.hasResourceProperties("AWS::S3::Bucket", {
        BucketEncryption: Match.objectLike({
          ServerSideEncryptionConfiguration: Match.arrayWith([
            Match.objectLike({
              ServerSideEncryptionByDefault: Match.objectLike({
                SSEAlgorithm: "AES256",
              }),
            }),
          ]),
        }),
      });
    });

    test("ALL public access is blocked (no leaks via misconfigured ACL)", () => {
      const t = Template.fromStack(makeStack());
      t.hasResourceProperties("AWS::S3::Bucket", {
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
      });
    });

    test("versioning is enabled (defense vs accidental delete + bit-rot)", () => {
      const t = Template.fromStack(makeStack());
      t.hasResourceProperties("AWS::S3::Bucket", {
        VersioningConfiguration: { Status: "Enabled" },
      });
    });

    test("TLS-only access is enforced via bucket policy", () => {
      // CDK adds an explicit deny statement when enforceSSL: true.
      // The statement denies any action where aws:SecureTransport is false.
      const t = Template.fromStack(makeStack());
      t.hasResourceProperties("AWS::S3::BucketPolicy", {
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Effect: "Deny",
              Condition: Match.objectLike({
                Bool: Match.objectLike({
                  "aws:SecureTransport": "false",
                }),
              }),
            }),
          ]),
        }),
      });
    });

    test("bucket has RETAIN deletion policy (cdk destroy must not nuke backups)", () => {
      const t = Template.fromStack(makeStack());
      const buckets = t.findResources("AWS::S3::Bucket");
      for (const bucket of Object.values(buckets)) {
        expect(bucket.DeletionPolicy).toBe("Retain");
        expect(bucket.UpdateReplacePolicy).toBe("Retain");
      }
    });
  });

  describe("S3 state bucket — lifecycle rules (cost control)", () => {
    test("litestream/ prefix expires at 7 days", () => {
      const t = Template.fromStack(makeStack());
      t.hasResourceProperties("AWS::S3::Bucket", {
        LifecycleConfiguration: Match.objectLike({
          Rules: Match.arrayWith([
            Match.objectLike({
              Id: "litestream-wal-expire-7d",
              Status: "Enabled",
              Prefix: "litestream/",
              ExpirationInDays: 7,
            }),
          ]),
        }),
      });
    });

    test("chroma-nightly/ prefix expires at 30 days", () => {
      const t = Template.fromStack(makeStack());
      t.hasResourceProperties("AWS::S3::Bucket", {
        LifecycleConfiguration: Match.objectLike({
          Rules: Match.arrayWith([
            Match.objectLike({
              Id: "chroma-nightly-expire-30d",
              Status: "Enabled",
              Prefix: "chroma-nightly/",
              ExpirationInDays: 30,
            }),
          ]),
        }),
      });
    });

    test("images/ transitions to STANDARD_IA at 30 days, no expiration", () => {
      const t = Template.fromStack(makeStack());
      t.hasResourceProperties("AWS::S3::Bucket", {
        LifecycleConfiguration: Match.objectLike({
          Rules: Match.arrayWith([
            Match.objectLike({
              Id: "images-transition-ia-30d",
              Status: "Enabled",
              Prefix: "images/",
              Transitions: Match.arrayWith([
                Match.objectLike({
                  StorageClass: "STANDARD_IA",
                  TransitionInDays: 30,
                }),
              ]),
            }),
          ]),
        }),
      });
    });

    test("incomplete multipart uploads cleaned up after 1 day on every prefix", () => {
      // Multipart uploads abandoned mid-stream silently accumulate
      // storage cost. Every lifecycle rule should clean them up.
      const t = Template.fromStack(makeStack());
      const buckets = t.findResources("AWS::S3::Bucket");
      const bucket = Object.values(buckets)[0];
      const rules = bucket.Properties.LifecycleConfiguration.Rules;
      for (const rule of rules) {
        expect(rule.AbortIncompleteMultipartUpload.DaysAfterInitiation).toBe(1);
      }
    });
  });

  describe("ECR app repo", () => {
    test("exactly one ECR repo is created", () => {
      const t = Template.fromStack(makeStack());
      t.resourceCountIs("AWS::ECR::Repository", 1);
    });

    test("repository name is braintwin/app", () => {
      const t = Template.fromStack(makeStack());
      t.hasResourceProperties("AWS::ECR::Repository", {
        RepositoryName: "braintwin/app",
      });
    });

    test("image scanning runs on every push", () => {
      const t = Template.fromStack(makeStack());
      t.hasResourceProperties("AWS::ECR::Repository", {
        ImageScanningConfiguration: { ScanOnPush: true },
      });
    });

    test("image tag mutability is IMMUTABLE (can't silently overwrite a version)", () => {
      const t = Template.fromStack(makeStack());
      t.hasResourceProperties("AWS::ECR::Repository", {
        ImageTagMutability: "IMMUTABLE",
      });
    });

    test("encryption is AES256 (CDK omits the property for the ECR default)", () => {
      // ecr.RepositoryEncryption.AES_256 is the ECR service default, so
      // the L2 construct emits NO EncryptionConfiguration. Absent here
      // means "AES256, not KMS" — if someone switches to KMS the
      // property appears and this assertion fails, forcing review.
      const t = Template.fromStack(makeStack());
      t.hasResourceProperties("AWS::ECR::Repository", {
        EncryptionConfiguration: Match.absent(),
      });
    });

    test("lifecycle policy bounds image count", () => {
      // Two rules:
      //   1) keep last 5 untagged
      //   2) keep last 30 of any tag status
      const t = Template.fromStack(makeStack());
      t.hasResourceProperties("AWS::ECR::Repository", {
        LifecyclePolicy: Match.objectLike({
          LifecyclePolicyText: Match.stringLikeRegexp('"countNumber":\\s*5'),
        }),
      });
      t.hasResourceProperties("AWS::ECR::Repository", {
        LifecyclePolicy: Match.objectLike({
          LifecyclePolicyText: Match.stringLikeRegexp('"countNumber":\\s*30'),
        }),
      });
    });
  });

  describe("Stack-level wiring (storage grants to compute.instanceRole)", () => {
    test("instance role has S3 read+write on the state bucket", () => {
      const t = Template.fromStack(makeStack());
      // The grant translates to an inline IAM policy with the bucket
      // ARN in the resource list. Easiest assertion: there exists an
      // IAM policy that mentions the state bucket name in its
      // resource ARNs.
      const policies = t.findResources("AWS::IAM::Policy");
      const policyTexts = Object.values(policies).map((p) =>
        JSON.stringify(p.Properties.PolicyDocument),
      );
      const referencesBucket = policyTexts.some(
        (text) =>
          text.includes("StateBucket") ||
          text.includes("braintwin-state"),
      );
      expect(referencesBucket).toBe(true);
    });

    test("instance role has ECR pull on the app repo", () => {
      // ECR pull = BatchCheckLayerAvailability + GetDownloadUrlForLayer
      // + BatchGetImage + GetAuthorizationToken.
      const t = Template.fromStack(makeStack());
      const policies = t.findResources("AWS::IAM::Policy");
      const policyTexts = Object.values(policies).map((p) =>
        JSON.stringify(p.Properties.PolicyDocument),
      );
      const hasEcrPull = policyTexts.some((text) =>
        text.includes("ecr:BatchGetImage"),
      );
      expect(hasEcrPull).toBe(true);
    });
  });

  describe("CloudFormation outputs", () => {
    test("bucket name is output (ops runbook needs this)", () => {
      const t = Template.fromStack(makeStack());
      const outputs = t.findOutputs("*");
      const found = Object.entries(outputs).find(([key]) =>
        key.toLowerCase().includes("statebucketname"),
      );
      expect(found).toBeDefined();
    });

    test("ECR URI is output (docker push target)", () => {
      const t = Template.fromStack(makeStack());
      const outputs = t.findOutputs("*");
      const found = Object.entries(outputs).find(([key]) =>
        key.toLowerCase().includes("apprepouri"),
      );
      expect(found).toBeDefined();
    });
  });
});

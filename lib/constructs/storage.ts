/**
 * StorageConstruct — S3 state bucket + ECR app image repo.
 *
 * Phase 4.0.6 M.2.f. Two persistent resources that hold things the
 * stack cannot recreate without external input:
 *
 *   1. **S3 state bucket** — holds Litestream WAL replicas of the
 *      SQLite DB, nightly Chroma snapshots, and captured images.
 *      This is the "if EBS catches fire, we can rebuild" backup.
 *
 *   2. **ECR app repo** — holds the BrainTwin Docker image. The EC2
 *      pulls from this on boot (M.3 will template the pull into the
 *      compute construct's user-data). Without ECR there's nowhere
 *      for the image to live in cloud.
 *
 * ## Why these are RETAIN vs DESTROY
 *
 * - **S3 bucket: RETAIN.** Contents = your backups + image archive.
 *   `cdk destroy` should NOT take these down accidentally — the
 *   whole disaster-recovery story depends on this bucket surviving
 *   stack-level mistakes.
 * - **ECR repo: DESTROY.** Images are rebuildable from `git checkout
 *   <sha> && docker build`. Worth nothing to keep them around if the
 *   stack is gone. But each individual image lifecycle (keep last N)
 *   is policy-controlled so ECR storage doesn't grow without bound.
 *
 * ## Lifecycle rules (the cost-control levers)
 *
 * S3 storage is cheap but unbounded; ECR storage adds up fast with
 * frequent deploys. Both get policy-driven cleanup:
 *
 * **S3 prefixes:**
 *
 *   - `litestream/`     → expire 7 days. WAL is continuously rewritten;
 *                         older history is useless for point-in-time
 *                         recovery beyond a few days.
 *   - `chroma-nightly/` → expire 30 days. One snapshot per night;
 *                         keeping a month gives weekly-cadence rollback.
 *   - `images/`         → transition to STANDARD_IA after 30 days,
 *                         no expiration. Captured images are precious
 *                         (the user can't re-capture them) but get
 *                         touched rarely after a month.
 *
 * **ECR:**
 *
 *   - Keep last 30 TAGGED images (covers ~3 months of deploys at
 *     weekly cadence; older versions are unrecoverable but you have
 *     git tags to rebuild from).
 *   - Keep last 5 UNTAGGED images (untagged accumulate when a tag
 *     gets reused — they're orphaned manifests).
 *
 * ## Bucket name uniqueness
 *
 * S3 bucket names are globally unique across ALL AWS accounts. We
 * tack the account ID + region on so collisions are impossible
 * without cloning the entire AWS account:
 *
 *   braintwin-state-<account>-<region>
 *
 * `Stack.of(this).account` / `.region` resolve to the concrete
 * values when the stack has an explicit `env` (our case — see
 * bin/braintwin.ts), and fall back to CloudFormation pseudo-
 * parameter tokens for env-agnostic synth. Account ID is publicly
 * knowable; leaking it via the bucket name is not a security
 * concern (it's already in every IAM ARN).
 *
 * ## Permissions — granted by the stack, not by this construct
 *
 * This construct exposes the bucket and repo. It does NOT take an
 * IAM role in its props. The stack (braintwin-stack.ts) is where
 * cross-construct wiring lives — it calls
 * `storage.stateBucket.grantReadWrite(compute.instanceRole)` and
 * `storage.appRepo.grantPull(compute.instanceRole)` after both
 * constructs exist. This keeps each construct independently
 * testable and avoids implicit construct-to-construct dependencies.
 */
import * as cdk from "aws-cdk-lib";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
import { brandedLower, RegionConfig } from "../stack-config";

export interface StorageConstructProps {
  readonly config: RegionConfig;
}

export class StorageConstruct extends Construct {
  /**
   * S3 state bucket — Litestream WAL, Chroma snapshots, image archive.
   * RETAIN on stack delete. Versioning on, TLS-only access.
   */
  public readonly stateBucket: s3.Bucket;

  /**
   * ECR repo for the BrainTwin app image. M.3 user-data does the
   * `aws ecr get-login-password | docker login` + `docker pull` dance.
   */
  public readonly appRepo: ecr.Repository;

  constructor(scope: Construct, id: string, props: StorageConstructProps) {
    super(scope, id);

    // -----------------------------------------------------------------
    // 1) S3 state bucket
    // -----------------------------------------------------------------
    this.stateBucket = new s3.Bucket(this, "StateBucket", {
      // Globally unique. Account + region keeps it collision-free.
      bucketName:
        `${brandedLower("state")}-` +
        `${cdk.Stack.of(this).account}-${cdk.Stack.of(this).region}`,

      // SSE-S3 (AES256, AWS-managed keys, free). KMS would add audit
      // detail at ~$1/key/month + per-call charges; not worth it for
      // single-user data.
      encryption: s3.BucketEncryption.S3_MANAGED,

      // Block ALL public access. Litestream + the EC2 are the only
      // intended readers; both go through IAM, not anonymous.
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,

      // Versioning — defense against accidental delete and bit-rot.
      // Litestream replicas are small (~MBs); versioning storage is
      // negligible. Older versions are cleaned up via the lifecycle
      // rule below.
      versioned: true,

      // TLS-required bucket policy. CDK adds a deny-statement that
      // rejects any request not using HTTPS. Cheap defense; only cost
      // is one extra rule in the bucket policy.
      enforceSSL: true,

      // RETAIN on cdk destroy. Backups are not stack-lifetime data.
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      autoDeleteObjects: false,

      // Per-prefix lifecycle. These are the cost-control knobs.
      lifecycleRules: [
        {
          id: "litestream-wal-expire-7d",
          enabled: true,
          prefix: "litestream/",
          // WAL frames are continuously refreshed; nothing older than
          // a week is useful for recovery — and they accumulate fast.
          expiration: cdk.Duration.days(7),
          // Versioned bucket → also clean noncurrent versions.
          noncurrentVersionExpiration: cdk.Duration.days(7),
          abortIncompleteMultipartUploadAfter: cdk.Duration.days(1),
        },
        {
          id: "chroma-nightly-expire-30d",
          enabled: true,
          prefix: "chroma-nightly/",
          expiration: cdk.Duration.days(30),
          noncurrentVersionExpiration: cdk.Duration.days(7),
          abortIncompleteMultipartUploadAfter: cdk.Duration.days(1),
        },
        {
          id: "images-transition-ia-30d",
          enabled: true,
          prefix: "images/",
          // No expiration — captured images are user data the user
          // can't recapture. But after 30 days move to Standard-IA
          // (half the storage cost; per-retrieval fee, which is fine
          // because we read images rarely).
          transitions: [
            {
              storageClass: s3.StorageClass.INFREQUENT_ACCESS,
              transitionAfter: cdk.Duration.days(30),
            },
          ],
          noncurrentVersionExpiration: cdk.Duration.days(30),
          abortIncompleteMultipartUploadAfter: cdk.Duration.days(1),
        },
      ],
    });

    // CloudFormation output — for ops runbooks ("here's where backups live")
    new cdk.CfnOutput(this, "StateBucketName", {
      value: this.stateBucket.bucketName,
      description:
        "S3 bucket for Litestream WAL, Chroma nightly snapshots, " +
        "and captured images. RETAIN - survives cdk destroy.",
    });

    // -----------------------------------------------------------------
    // 2) ECR app repo — for the BrainTwin Docker image
    // -----------------------------------------------------------------
    this.appRepo = new ecr.Repository(this, "AppRepo", {
      // ECR allows slashes in names (becomes the image path component).
      // `braintwin/app` matches `docker pull <acct>.dkr.ecr.<region>.amazonaws.com/braintwin/app:tag`.
      repositoryName: `${brandedLower("app").replace(/^braintwin-/, "braintwin/")}`,

      // Scan every push for known CVEs. Free, runs in <30 sec after
      // push. Result visible in ECR console; alerts wire up in M.2.h.
      imageScanOnPush: true,

      // Once a tag (e.g. v0.1.0) is pushed, it can't be silently
      // replaced. Re-deploying the same version means making a new
      // tag — which forces visibility in `cdk diff` and PR review.
      imageTagMutability: ecr.TagMutability.IMMUTABLE,

      // ECR encrypts with AES256 by default (free). Same KMS rationale
      // as the bucket — not worth the per-key charge for our setup.
      encryption: ecr.RepositoryEncryption.AES_256,

      // Lifecycle — bounded image storage so ECR doesn't grow forever.
      lifecycleRules: [
        {
          rulePriority: 1,
          description: "Keep last 5 untagged images (orphan manifests)",
          tagStatus: ecr.TagStatus.UNTAGGED,
          maxImageCount: 5,
        },
        {
          rulePriority: 2,
          description: "Keep last 30 tagged images (~3 months at weekly cadence)",
          tagStatus: ecr.TagStatus.ANY,
          maxImageCount: 30,
        },
      ],

      // DESTROY policy. Images are rebuildable from git; ECR storage
      // shouldn't outlive the stack.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      // Allow `cdk destroy` to wipe the images. Without this, ECR
      // would refuse to delete a non-empty repo and the destroy would
      // hang.
      emptyOnDelete: true,
    });

    new cdk.CfnOutput(this, "AppRepoUri", {
      value: this.appRepo.repositoryUri,
      description:
        "ECR repo URI. From your Mac: " +
        "`aws ecr get-login-password | docker login --username AWS " +
        "--password-stdin <uri>; docker push <uri>:vX.Y.Z`. " +
        "M.3 user-data templates the pull side.",
    });
  }
}

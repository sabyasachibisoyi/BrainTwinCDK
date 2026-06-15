/**
 * BrainTwinStack — the single composition root for the cloud topology.
 *
 * Phase 4.0.6 M.2.b/c: empty stack. The class exists, takes typed
 * props including the per-region config, and applies a standard tag
 * set so every future resource inherits "this came from BrainTwinCDK
 * targeting <region>". `cdk synth` succeeds and produces a real (but
 * resource-empty) CloudFormation template.
 *
 * M.2.d → M.2.h fill the stack body by instantiating one custom
 * construct per domain (network, compute, storage, secrets,
 * observability). Each construct lives in `lib/constructs/`.
 */
import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import { ComputeConstruct } from "./constructs/compute";
import { NetworkConstruct } from "./constructs/network";
import { ObservabilityConstruct } from "./constructs/observability";
import { SecretsConstruct } from "./constructs/secrets";
import { StorageConstruct } from "./constructs/storage";
import { RegionConfig } from "./stack-config";

export interface BrainTwinStackProps extends cdk.StackProps {
  /**
   * Per-region typed config (instance type, AZs, budget thresholds,
   * etc.). Look it up via `getConfig(region)` in bin/braintwin.ts.
   */
  readonly config: RegionConfig;

  /**
   * ECR image tag the EC2 user-data will `docker pull` at boot. Fed in
   * from `--context imageTag=<tag>` by scripts/deploy.sh. Defaults to
   * "bootstrap" in bin/braintwin.ts so `cdk synth` works without a
   * prior image build — but a real deploy with that placeholder will
   * boot an EC2 that can't pull anything. M.3 compute.ts interpolates
   * this into the docker-compose user-data template.
   */
  readonly imageTag: string;
}

export class BrainTwinStack extends cdk.Stack {
  public readonly config: RegionConfig;
  public readonly imageTag: string;
  public readonly network: NetworkConstruct;
  public readonly compute: ComputeConstruct;
  public readonly storage: StorageConstruct;
  public readonly secrets: SecretsConstruct;
  public readonly observability: ObservabilityConstruct;

  constructor(scope: Construct, id: string, props: BrainTwinStackProps) {
    super(scope, id, props);
    this.config = props.config;
    this.imageTag = props.imageTag;

    // Warn loudly at synth if the operator forgot to set an imageTag.
    // "bootstrap" is fine for `cdk synth` / unit tests, but deploying
    // it would boot an EC2 that fails its `docker pull` and so never
    // serves traffic — the failure mode is loud at runtime but easy to
    // miss at deploy time. A synth-warning makes it visible up front.
    if (props.imageTag === "bootstrap") {
      cdk.Annotations.of(this).addWarning(
        "imageTag is the placeholder 'bootstrap' - the EC2 user-data " +
          "will fail to pull a real image. Run BrainTwin/scripts/" +
          "build-and-push.sh then BrainTwinCDK/scripts/deploy.sh (which " +
          "passes the real tag via --context imageTag=<tag>) before " +
          "relying on this deploy.",
      );
    }

    // Universal tags. Cost Explorer can filter by these to slice spend
    // per region / phase. Also lets a future ops runbook grep "all
    // resources for this stack."
    cdk.Tags.of(this).add("Project", "BrainTwin");
    cdk.Tags.of(this).add("Phase", "4.0.6");
    cdk.Tags.of(this).add("Region", props.config.region);
    cdk.Tags.of(this).add("ManagedBy", "BrainTwinCDK");

    // Construct instantiation order — IMPORTANT.
    //
    // Starting with M.3.a, ComputeConstruct's user-data references the
    // ECR repo name (storage), the SSM parameter names (secrets), and
    // the CloudWatch log group names (observability). All three must
    // be constructed BEFORE compute, so it can read those values at
    // synth time and bake them into the cloud-init script.
    //
    // The grant calls (storage.appRepo.grantPull(compute.instanceRole)
    // etc.) come AFTER compute is constructed — they only need the
    // role reference, not the construct itself, so there's no ordering
    // problem there.

    // M.2.d — Network: VPC + Security Group + Elastic IP.
    this.network = new NetworkConstruct(this, "Network", {
      config: this.config,
    });

    // M.2.f — Storage: S3 state bucket + ECR app repo + lifecycle.
    this.storage = new StorageConstruct(this, "Storage", {
      config: this.config,
    });

    // M.2.g — Secrets: SSM Parameter Store names + IAM grants.
    // The construct does NOT create parameters (CFN cannot create
    // SecureStrings — see secrets.ts docstring). Operator runs
    // scripts/put-secrets.sh once to populate them out of band.
    this.secrets = new SecretsConstruct(this, "Secrets", {
      config: this.config,
    });

    // M.2.h — Observability: CloudWatch log groups + AWS Budget + DLM.
    // The Budget filters by Project=BrainTwin (universal stack tag set
    // above); DLM targets the EBS volume by the same tag. The two log
    // group names get baked into the docker-compose `logging:` block
    // in compute's user-data via the construct reference below.
    this.observability = new ObservabilityConstruct(this, "Observability", {
      config: this.config,
    });

    // M.2.e + M.3.a — Compute: EC2 + EBS + IAM role + EIP association +
    // full app-bring-up user-data (Docker, SSM secret fetch, ECR pull,
    // docker compose up).
    this.compute = new ComputeConstruct(this, "Compute", {
      config: this.config,
      network: this.network,
      storage: this.storage,
      secrets: this.secrets,
      observability: this.observability,
      imageTag: this.imageTag,
    });

    // ----- Cross-construct IAM grants (compute.instanceRole + others) -----
    //
    // grantReadWrite: Litestream needs PUT + GET + DELETE under
    // litestream/ + chroma-nightly/; the app needs the same on
    // images/. ReadWrite covers all of it. Litestream uses the
    // SDK; no need for separate scoping at the path level.
    this.storage.stateBucket.grantReadWrite(this.compute.instanceRole);

    // grantPull: BatchCheckLayerAvailability + GetDownloadUrlForLayer
    // + BatchGetImage + GetAuthorizationToken. M.3.a user-data does
    // `aws ecr get-login-password | docker login` then `docker pull`.
    this.storage.appRepo.grantPull(this.compute.instanceRole);

    // ssm:GetParameter on the four /braintwin/* parameter ARNs + a
    // service-scoped kms:Decrypt. Compute's user-data calls
    // `aws ssm get-parameter --with-decryption` for each.
    this.secrets.grantReadAll(this.compute.instanceRole);

    // logs:CreateLogStream + logs:PutLogEvents on the two log groups.
    // The Docker `awslogs` driver in the generated docker-compose.yml
    // uses these to ship container stdout to CloudWatch.
    this.observability.grantLogWrite(this.compute.instanceRole);

    // Surface the imageTag in CloudFormation outputs so the operator can
    // confirm scripts/deploy.sh threaded the tag through synth correctly.
    //
    // IMPORTANT: as of M.2 this is the *configured* tag only — nothing
    // consumes it yet. ComputeConstruct does not receive it and the
    // user-data does not `docker pull`. M.3 will interpolate this tag
    // into the docker-compose user-data; until then this output does NOT
    // mean the running EC2 is on this image.
    new cdk.CfnOutput(this, "ConfiguredImageTag", {
      value: this.imageTag,
      description:
        "ECR tag configured for this stack via --context imageTag=<tag> " +
        "(handled by BrainTwinCDK/scripts/deploy.sh, which reads " +
        ".last-deploy-tag written by BrainTwin/scripts/build-and-push.sh). " +
        "Threaded into the EC2 user-data as of M.3.a so the boot-time " +
        "`docker pull` targets this tag.",
    });
  }
}

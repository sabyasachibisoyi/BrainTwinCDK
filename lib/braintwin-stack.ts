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
}

export class BrainTwinStack extends cdk.Stack {
  public readonly config: RegionConfig;
  public readonly network: NetworkConstruct;
  public readonly compute: ComputeConstruct;
  public readonly storage: StorageConstruct;
  public readonly secrets: SecretsConstruct;
  public readonly observability: ObservabilityConstruct;

  constructor(scope: Construct, id: string, props: BrainTwinStackProps) {
    super(scope, id, props);
    this.config = props.config;

    // Universal tags. Cost Explorer can filter by these to slice spend
    // per region / phase / brand. Also lets a future ops runbook grep
    // "all resources for this stack."
    cdk.Tags.of(this).add("Project", "BrainTwin");
    cdk.Tags.of(this).add("PublicBrand", "DigitalTwin");
    cdk.Tags.of(this).add("Phase", "4.0.6");
    cdk.Tags.of(this).add("Region", props.config.region);
    cdk.Tags.of(this).add("ManagedBy", "BrainTwinCDK");

    // M.2.d — Network: VPC + Security Group + Elastic IP.
    this.network = new NetworkConstruct(this, "Network", {
      config: this.config,
    });

    // M.2.e — Compute: EC2 + EBS + IAM role + EIP association + user-data.
    this.compute = new ComputeConstruct(this, "Compute", {
      config: this.config,
      network: this.network,
    });

    // M.2.f — Storage: S3 state bucket + ECR app repo + lifecycle.
    this.storage = new StorageConstruct(this, "Storage", {
      config: this.config,
    });

    // ----- Cross-construct wiring (the stack is where this lives) -----
    //
    // grantReadWrite: Litestream needs PUT + GET + DELETE under
    // litestream/ + chroma-nightly/; the app needs the same on
    // images/. ReadWrite covers all of it. Litestream uses the
    // SDK; no need for separate scoping at the path level.
    this.storage.stateBucket.grantReadWrite(this.compute.instanceRole);

    // grantPull: BatchCheckLayerAvailability + GetDownloadUrlForLayer
    // + BatchGetImage + GetAuthorizationToken. M.3 user-data does
    // `aws ecr get-login-password | docker login` then `docker pull`.
    this.storage.appRepo.grantPull(this.compute.instanceRole);

    // M.2.g — Secrets: SSM Parameter Store names + IAM grants.
    // The construct does NOT create parameters (CFN cannot create
    // SecureStrings — see secrets.ts docstring). Operator runs
    // scripts/put-secrets.sh once to populate them out of band.
    this.secrets = new SecretsConstruct(this, "Secrets", {
      config: this.config,
    });
    this.secrets.grantReadAll(this.compute.instanceRole);

    // M.2.h — Observability: CloudWatch log groups + AWS Budget + DLM.
    // The Budget filters by Project=BrainTwin (universal stack tag set
    // above); DLM targets the EBS volume by the same tag. EC2 gets
    // CreateLogStream/PutLogEvents on the two log groups so the
    // Docker awslogs driver in M.3 can ship container stdout.
    this.observability = new ObservabilityConstruct(this, "Observability", {
      config: this.config,
    });
    this.observability.grantLogWrite(this.compute.instanceRole);
  }
}

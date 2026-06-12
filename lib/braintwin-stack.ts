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
import { NetworkConstruct } from "./constructs/network";
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

    // M.2.e–M.2.h still to land:
    //
    //   const storage = new StorageConstruct(this, "Storage", { config: this.config });
    //   const secrets = new SecretsConstruct(this, "Secrets", { config: this.config });
    //   const observability = new ObservabilityConstruct(this, "Observability", {
    //     config: this.config,
    //   });
    //   const compute = new ComputeConstruct(this, "Compute", {
    //     config: this.config,
    //     network: this.network,
    //     storage,
    //     secrets,
    //     observability,
    //   });
  }
}

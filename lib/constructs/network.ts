/**
 * NetworkConstruct — VPC, Security Group, and Elastic IP.
 *
 * Phase 4.0.6 M.2.d. This construct creates everything the future EC2
 * needs to be reachable from the public internet via Cloudflare:
 *
 *   1. A small custom VPC with one PUBLIC subnet per AZ in config.
 *      No NAT gateway (free). No private subnets (we don't have an
 *      internal workload to isolate yet).
 *   2. A Security Group that allows :443 ingress ONLY from Cloudflare
 *      IPv4 CIDRs. No :22 (SSH replaced by SSM Session Manager).
 *      Egress is wide open so the EC2 can talk to Anthropic / ECR /
 *      SSM / CloudWatch.
 *   3. An Elastic IP. M.2.e (compute.ts) associates it to the EC2 ENI.
 *      It outlives the instance — if the EC2 is replaced, the EIP and
 *      the Cloudflare DNS record both stay valid.
 *
 * ## Why a custom VPC instead of the default VPC?
 *
 * Two reasons to NOT use `Vpc.fromLookup({ isDefault: true })` here:
 *
 *   - `fromLookup` queries AWS at synth time. That means `cdk synth`
 *     fails on a developer machine that hasn't run `aws sso login`
 *     yet — blocks the local "design before deploy" feedback loop.
 *   - The default VPC's subnet IDs are randomly assigned at account
 *     creation. A snapshot test would have to capture those, which
 *     would make the test deployment-account-specific.
 *
 * A custom VPC with no NAT gateway is identical in cost ($0) to the
 * default VPC — the cost trap was always the NAT gateway, not the VPC.
 * Custom VPC means deterministic synth, no AWS calls during local dev,
 * predictable subnet CIDRs across regions.
 *
 * ## AZ parameterization (design §3.0.1)
 *
 * The VPC creates one public subnet per AZ in `config.availabilityZones`.
 * Today that's a length-1 list → one subnet → fine for the single EC2.
 * Adding a second AZ later creates another subnet, ready for a second
 * EC2. Active-active across the two requires more than this construct
 * (ALB + RDS + externalised conversation store — Phase 5+).
 */
import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import { Construct } from "constructs";
import { CLOUDFLARE_IPV4_RANGES } from "../cloudflare-ips";
import { brandedName, RegionConfig } from "../stack-config";

export interface NetworkConstructProps {
  readonly config: RegionConfig;
}

export class NetworkConstruct extends Construct {
  /** The VPC the EC2 will live in. */
  public readonly vpc: ec2.Vpc;

  /** Security Group attached to the EC2's primary ENI in compute.ts. */
  public readonly securityGroup: ec2.SecurityGroup;

  /** Static public IPv4. Cloudflare's DNS A record points here. */
  public readonly elasticIp: ec2.CfnEIP;

  /** Convenience: the public subnets that compute.ts can place EC2s in. */
  public readonly publicSubnets: ec2.ISubnet[];

  constructor(scope: Construct, id: string, props: NetworkConstructProps) {
    super(scope, id);

    // -----------------------------------------------------------------
    // 1) VPC — custom, small, no NAT
    // -----------------------------------------------------------------
    this.vpc = new ec2.Vpc(this, "Vpc", {
      // BrainTwin-Vpc shows up as the Name tag in the AWS Console.
      vpcName: brandedName("Vpc"),
      // 10.10.0.0/16 → 65k addresses. Way more than we need but
      // matches the "default-ish" feel of a real VPC.
      ipAddresses: ec2.IpAddresses.cidr("10.10.0.0/16"),
      // Pin the exact AZs from config. `maxAzs` would only take a COUNT
      // and let CDK pick the first N AZs alphabetically — the config's
      // AZ names would be silently ignored, breaking compute.ts's
      // per-configured-AZ placement the moment a config names anything
      // other than the region's first AZ.
      availabilityZones: [...props.config.availabilityZones],
      natGateways: 0,
      subnetConfiguration: [
        {
          // Subnet Name tag becomes "BrainTwin-Public" in the console.
          name: brandedName("Public"),
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
      ],
      enableDnsHostnames: true,
      enableDnsSupport: true,
      restrictDefaultSecurityGroup: true,
      // No Flow Logs (deferred to Phase 4.0.6.1 — $0.50/GB stored).
    });

    // CDK auto-creates the IGW + route tables under the Vpc — they
    // inherit the Project=BrainTwin tag set at the stack level, but
    // their Name tags are CDK-generated paths. Override here so the
    // console shows recognisable names instead of "BrainTwin/Network/Vpc/IGW".
    for (const child of this.vpc.node.findAll()) {
      if (child instanceof ec2.CfnInternetGateway) {
        cdk.Tags.of(child).add("Name", brandedName("Igw"));
      } else if (child instanceof ec2.CfnRouteTable) {
        cdk.Tags.of(child).add("Name", brandedName("PublicRouteTable"));
      }
    }

    this.publicSubnets = this.vpc.publicSubnets;

    // -----------------------------------------------------------------
    // 2) Security Group — Cloudflare-only :443 ingress
    // -----------------------------------------------------------------
    this.securityGroup = new ec2.SecurityGroup(this, "SecurityGroup", {
      vpc: this.vpc,
      // `securityGroupName` becomes the actual "Group name" column in
      // the EC2 Security Groups console, not just a Name tag.
      // Tradeoff: CloudFormation can't do replace-update on a named SG,
      // so changes that force replacement need a clean destroy first.
      // Acceptable for a single-stack project.
      securityGroupName: brandedName("SG"),
      description:
        "BrainTwin EC2 — allow :443 from Cloudflare only; " +
        "no :22 (SSH disabled, SSM Session Manager only)",
      allowAllOutbound: true,
    });
    cdk.Tags.of(this.securityGroup).add("Name", brandedName("SG"));

    // Add an ingress rule per Cloudflare CIDR. With ~15 rules each,
    // we're well under the default 60-rules-per-SG limit.
    //
    // SCOPE OF THIS CONTROL: these CIDRs are Cloudflare's shared egress
    // ranges, used by EVERY Cloudflare customer. This SG proves "the
    // packet came from a Cloudflare data center", NOT "it came through
    // OUR Cloudflare zone". An attacker who learns the EIP can point
    // their own free Cloudflare zone at it and reach the origin from
    // an allowed IP, skipping our zone's WAF / rate limits. compute.ts
    // (M.2.e) MUST therefore enable Cloudflare Authenticated Origin
    // Pulls (origin requires Cloudflare's client cert at TLS) so only
    // requests proxied through our zone terminate successfully.
    for (const cidr of CLOUDFLARE_IPV4_RANGES) {
      this.securityGroup.addIngressRule(
        ec2.Peer.ipv4(cidr),
        ec2.Port.tcp(443),
        `Cloudflare ${cidr}`,
      );
    }

    // Explicitly NOT adding port 22 ingress. SSH access is provided
    // by SSM Session Manager (design §3.4), which uses an outbound
    // tunnel from the EC2 to the SSM service — no inbound port
    // needed, ever.

    // -----------------------------------------------------------------
    // 3) Elastic IP — static public IPv4 for the Cloudflare A record
    // -----------------------------------------------------------------
    this.elasticIp = new ec2.CfnEIP(this, "ElasticIp", {
      domain: "vpc",
      tags: [{ key: "Name", value: brandedName("EIP") }],
    });

    // Output the EIP so `cdk deploy` prints the value the operator
    // needs to put into Cloudflare's DNS A record at M.6.
    // No `exportName`: a CloudFormation export would lock the value
    // against change/deletion once anything imports it, and the only
    // consumer is a human copying it into Cloudflare DNS.
    new cdk.CfnOutput(this, "ElasticIpAddress", {
      value: this.elasticIp.attrPublicIp,
      description:
        "Static public IPv4 — set this as the A record for " +
        "api.braintwin.net in Cloudflare (orange-cloud / proxied).",
    });
  }
}

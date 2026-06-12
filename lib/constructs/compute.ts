/**
 * ComputeConstruct — EC2 + EBS + instance profile + EIP association.
 *
 * Phase 4.0.6 M.2.e. This is the construct that, when fully wired
 * (with M.2.f storage, M.2.g secrets, and M.3 runtime), actually
 * RUNS the BrainTwin app in the cloud. Today it builds the host shell
 * (compute, persistent disk, IAM access, OS bring-up) and leaves the
 * application bring-up as a TODO for later milestones.
 *
 * ## What this construct creates
 *
 *   1. ONE IAM role, shared across all EC2s (CDK auto-creates the
 *      instance profile that wraps it when the role is passed to
 *      `ec2.Instance`).
 *      Today: SSM Session Manager + CloudWatch agent permissions.
 *      M.2.f will attach ECR pull + S3 (state bucket) read/write.
 *      M.2.g will attach SSM Parameter Store read on /braintwin/*.
 *
 *   2. ONE EC2 instance PER AZ in `config.availabilityZones`.
 *      Today that's a length-1 list → one EC2. Adding `'us-west-2b'`
 *      to the config tomorrow creates a second EC2 (cold standby).
 *      Active-active across the two is NOT magic — it requires RDS +
 *      ALB + externalised state (Phase 5+; see design §3.0.1).
 *
 *   3. ONE EBS gp3 volume PER AZ, attached to the EC2 in the same AZ.
 *      RemovalPolicy.RETAIN — even `cdk destroy` leaves the data behind.
 *      Replacing the EC2 (e.g. instance-type bump) re-attaches the same
 *      volume on first boot.
 *
 *   4. EIP association on instances[0] (the primary). On a future
 *      failover drill, the operator manually reassociates the EIP to
 *      the standby — the Cloudflare DNS A record stays valid.
 *
 *   5. User-data that installs Docker + docker-compose, mounts the EBS
 *      at /var/lib/braintwin/data, and chowns it to UID 10001 so the
 *      container's non-root `braintwin` user can write to it. The
 *      actual `docker compose up` (the part that pulls the image from
 *      ECR and runs the app) is stubbed out — M.3 templates it in
 *      once ECR + SSM Parameters exist.
 *
 * ## Cloudflare Authenticated Origin Pulls (AOP) — flagged from M.2.d
 *
 * The Security Group filters by Cloudflare's shared egress IPs, which
 * proves the request came through SOME Cloudflare zone, not OUR zone.
 * Caddy needs to validate Cloudflare's per-zone client certificate
 * against Cloudflare's Origin Pull CA. The CA cert is a public PEM
 * published at:
 *   https://developers.cloudflare.com/ssl/origin-configuration/
 *     authenticated-origin-pull/configure/
 *
 * Plan for AOP, sequenced:
 *   M.2.e (this construct) — user-data creates /etc/caddy/ but does
 *       NOT yet deploy the cert (Caddy isn't running).
 *   M.3 (cloud deploy)     — Caddy joins docker-compose. The user-data
 *       fetches Cloudflare's Origin Pull CA at boot and writes it to
 *       /etc/caddy/cloudflare-origin-ca.pem; the Caddyfile is
 *       templated with `tls { client_auth { trust_pool file …pem } }`.
 *
 * ## Cost note
 *
 * Each EC2 (t4g.small) + 20 GiB gp3 + EIP-while-attached = ~$17/month.
 * Synth-and-don't-deploy is free; `cdk deploy` starts the meter. Hold
 * off on deploy until M.2.h (observability) + M.3 (app actually runs)
 * are wired, otherwise you're paying to have an idle box do nothing.
 */
import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import { NetworkConstruct } from "./network";
import { brandedName, RegionConfig } from "../stack-config";

export interface ComputeConstructProps {
  readonly config: RegionConfig;
  readonly network: NetworkConstruct;
}

export class ComputeConstruct extends Construct {
  /** Shared IAM role attached to every EC2 in this construct. */
  public readonly instanceRole: iam.Role;

  /** One EC2 per AZ in `config.availabilityZones`. instances[0] is primary. */
  public readonly instances: ec2.Instance[];

  /** One gp3 volume per AZ, RETAIN policy, attached to the AZ-matched EC2. */
  public readonly ebsVolumes: ec2.Volume[];

  constructor(scope: Construct, id: string, props: ComputeConstructProps) {
    super(scope, id);

    // -----------------------------------------------------------------
    // 1) IAM role — shared across every EC2 in this stack.
    //
    // Start narrow: just SSM Session Manager + CloudWatch agent.
    // M.2.f/g/h append focused permissions to this same role via
    // `instanceRole.attachInlinePolicy(...)` or `bucket.grantRead(...)`.
    // -----------------------------------------------------------------
    this.instanceRole = new iam.Role(this, "InstanceRole", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      roleName: brandedName("EC2-Role"),
      description:
        "BrainTwin EC2 role — SSM Session Manager + CloudWatch agent. " +
        "ECR pull, S3 state bucket, SSM Parameter Store reads are " +
        "attached by storage.ts / secrets.ts / observability.ts.",
      managedPolicies: [
        // SSM Session Manager (replaces SSH per design §3.4)
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "AmazonSSMManagedInstanceCore",
        ),
        // CloudWatch agent (M.2.h adds the log group; this grants write)
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "CloudWatchAgentServerPolicy",
        ),
      ],
    });

    // NOTE: no explicit CfnInstanceProfile here. Passing `role:` to
    // ec2.Instance below makes CDK create the instance profile — a
    // hand-rolled one would be a second, orphaned IAM resource.

    // -----------------------------------------------------------------
    // 2) AMI lookup — Canonical Ubuntu 22.04 LTS, arm64 (Graviton).
    //
    // `fromSsmParameter` resolves the parameter AT DEPLOY TIME, so every
    // `cdk deploy` picks up the latest patched AMI. The parameter name is
    // a public SSM path that Canonical maintains for years.
    // -----------------------------------------------------------------
    const ami = ec2.MachineImage.fromSsmParameter(
      "/aws/service/canonical/ubuntu/server/22.04/stable/current/arm64/hvm/ebs-gp2/ami-id",
      { os: ec2.OperatingSystemType.LINUX },
    );

    const instanceType = new ec2.InstanceType(props.config.instanceType);

    // -----------------------------------------------------------------
    // 3) User-data — runs as root on first boot.
    //
    // Kept SHORT and FOCUSED. Heavy logic (running the app, fetching
    // secrets) is the responsibility of later milestones. This script
    // gets the host into a state where M.3's `docker compose up` will
    // "just work."
    // -----------------------------------------------------------------
    const userData = this._buildUserData(props.config.ebsSizeGiB);

    // -----------------------------------------------------------------
    // 4) Per-AZ EC2 + EBS.
    //
    // Iterates `config.availabilityZones` so adding a second AZ in
    // stack-config.ts → second EC2+EBS pair without code change here.
    // -----------------------------------------------------------------
    this.instances = [];
    this.ebsVolumes = [];

    props.config.availabilityZones.forEach((az, idx) => {
      // Find the public subnet CDK auto-created in this AZ.
      const subnet = props.network.publicSubnets.find(
        (s) => s.availabilityZone === az,
      );
      if (!subnet) {
        throw new Error(
          `No public subnet found in AZ '${az}'. ` +
            `network.ts should have created one — check that ` +
            `config.availabilityZones is consistent.`,
        );
      }

      // ----- EBS volume (data plane, RETAIN policy) -----
      const ebs = new ec2.Volume(this, `EbsVolume${idx}`, {
        availabilityZone: az,
        size: cdk.Size.gibibytes(props.config.ebsSizeGiB),
        volumeType: ec2.EbsDeviceVolumeType.GP3,
        encrypted: true,
        volumeName: brandedName(`EBS-${idx}`),
        // RETAIN: the user's corpus, Chroma index, captured images.
        // Losing this is the failure mode the whole backup story exists
        // to prevent — making `cdk destroy` accidentally take it down
        // is exactly the bug we don't want.
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      });

      // ----- EC2 instance -----
      const instance = new ec2.Instance(this, `Instance${idx}`, {
        vpc: props.network.vpc,
        availabilityZone: az,
        vpcSubnets: { subnets: [subnet] },
        instanceType,
        machineImage: ami,
        role: this.instanceRole,
        securityGroup: props.network.securityGroup,
        userData,
        instanceName: brandedName(`EC2-${idx}`),
        // 10 GiB root for OS + Docker + the BrainTwin image (~3 GB).
        // App data lives on the separate EBS volume mounted at
        // /var/lib/braintwin/data.
        blockDevices: [
          {
            deviceName: "/dev/sda1",
            volume: ec2.BlockDeviceVolume.ebs(10, {
              volumeType: ec2.EbsDeviceVolumeType.GP3,
              encrypted: true,
              deleteOnTermination: true, // root is rebuildable
            }),
          },
        ],
        // Force IMDSv2 — IMDSv1 is the source of countless EC2 metadata
        // exfiltration CVEs.
        requireImdsv2: true,
      });

      // ----- Attach the EBS volume to this EC2 -----
      // /dev/sdf is requested; the kernel renames it to /dev/nvmeXn1 on
      // Nitro instances (which t4g is). User-data finds it by SIZE label.
      new ec2.CfnVolumeAttachment(this, `EbsAttachment${idx}`, {
        device: "/dev/sdf",
        instanceId: instance.instanceId,
        volumeId: ebs.volumeId,
      });

      // ----- EIP association — only on the primary (index 0) -----
      // A second instance in a multi-AZ standby scenario does NOT get
      // an EIP. Failover is operator-driven: reassociate the EIP from
      // instance0 to instance1 (one CLI call, ~30 sec).
      if (idx === 0) {
        new ec2.CfnEIPAssociation(this, "EipAssociation", {
          allocationId: props.network.elasticIp.attrAllocationId,
          instanceId: instance.instanceId,
        });
      }

      this.instances.push(instance);
      this.ebsVolumes.push(ebs);
    });

    // -----------------------------------------------------------------
    // 5) Outputs — what M.3 / operator runbooks need to know.
    // -----------------------------------------------------------------
    new cdk.CfnOutput(this, "PrimaryInstanceId", {
      value: this.instances[0].instanceId,
      description:
        "Primary EC2 instance ID. Use with `aws ssm start-session " +
        "--target <id>` to get a shell on the box (no SSH).",
    });

    new cdk.CfnOutput(this, "PrimaryEbsVolumeId", {
      value: this.ebsVolumes[0].volumeId,
      description:
        "Primary EBS volume ID. RETAIN policy — survives cdk destroy.",
    });
  }

  /**
   * The bash that runs as root on first boot.
   *
   * Goals — set the host up to the point where M.3 can ship a
   * docker-compose file and it Just Runs:
   *   - apt fresh, Docker installed and enabled
   *   - The `braintwin` UID 10001 user exists (matches the container
   *     user from the Dockerfile)
   *   - EBS mounted at /var/lib/braintwin/data, owned by 10001:10001
   *   - /etc/caddy/ exists (cert + Caddyfile land here in M.3)
   *
   * Things explicitly OUT of scope for M.2.e (deferred to M.3):
   *   - aws ecr get-login-password (no ECR repo yet — M.2.f)
   *   - docker compose pull / up (no compose file yet — M.3 templates one)
   *   - Cloudflare Origin Pull CA cert (Caddy isn't running yet — M.3)
   *   - Litestream restore (no S3 backup yet — M.4)
   */
  private _buildUserData(ebsSizeGiB: number): ec2.UserData {
    const ud = ec2.UserData.forLinux();

    ud.addCommands(
      // Strict mode + everything to a log file we can `sudo tail` later
      // via Session Manager.
      "set -euxo pipefail",
      "exec > >(tee -a /var/log/braintwin-userdata.log | logger -t braintwin-userdata) 2>&1",
      "echo '== braintwin user-data starting =='",

      // ----- Base packages -----
      "export DEBIAN_FRONTEND=noninteractive",
      "apt-get update -y",
      "apt-get install -y --no-install-recommends \\",
      "  ca-certificates curl gnupg lsb-release jq awscli e2fsprogs",

      // ----- Docker (from Docker's apt repo, not Ubuntu's older fork) -----
      "install -m 0755 -d /etc/apt/keyrings",
      "curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg",
      'echo "deb [arch=arm64 signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" > /etc/apt/sources.list.d/docker.list',
      "apt-get update -y",
      "apt-get install -y --no-install-recommends \\",
      "  docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin",
      "systemctl enable --now docker",

      // ----- braintwin user (matches container UID from BrainTwin/Dockerfile) -----
      // If the user already exists (re-running user-data on a recreated
      // instance with the same volume) that's fine — `useradd` errors,
      // we suppress via `|| true`.
      // Deliberately NOT in the docker group — docker-socket access is
      // root-equivalent, and this user only exists to own the data
      // mount. M.3's compose runs via root/systemd.
      "id -u braintwin >/dev/null 2>&1 || useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin braintwin",

      // ----- Find and mount the EBS data volume -----
      // /dev/sdf is requested by CDK; Nitro kernel renames to /dev/nvme1n1
      // (slot order). We match by SIZE so we don't care about device name.
      // Interpolated from config so a future size bump can't silently
      // desync from the lsblk size-match below.
      `EBS_SIZE_GIB=${ebsSizeGiB}`,
      "for i in $(seq 1 60); do",
      '  EBS_DEV=$(lsblk -dpno NAME,SIZE,TYPE | awk -v sz="${EBS_SIZE_GIB}G" \'$2==sz && $3=="disk" {print $1; exit}\')',
      '  [ -n "$EBS_DEV" ] && break',
      "  echo \"Waiting for ${EBS_SIZE_GIB}G EBS volume to appear (attempt $i)…\"",
      "  sleep 2",
      "done",
      'if [ -z "$EBS_DEV" ]; then echo "EBS volume never appeared; aborting"; exit 1; fi',
      'echo "EBS volume is $EBS_DEV"',

      // Only format if there's no filesystem already (preserves data
      // across instance recreations — the whole point of RETAIN).
      'if ! blkid "$EBS_DEV" >/dev/null 2>&1; then',
      '  echo "Fresh volume — formatting ext4 with label braintwin-data"',
      '  mkfs.ext4 -L braintwin-data "$EBS_DEV"',
      "else",
      '  echo "Existing filesystem on $EBS_DEV — skipping mkfs"',
      "fi",

      // Mount and add to fstab so reboots re-mount automatically.
      "mkdir -p /var/lib/braintwin/data",
      'grep -q "^LABEL=braintwin-data " /etc/fstab || echo "LABEL=braintwin-data /var/lib/braintwin/data ext4 defaults,noatime 0 2" >> /etc/fstab',
      "mount -a",

      // braintwin:braintwin ownership so the non-root container user
      // (UID 10001 in the Dockerfile) can read/write.
      "chown -R 10001:10001 /var/lib/braintwin/data",

      // ----- Caddy directory (cert + Caddyfile land here in M.3) -----
      "mkdir -p /etc/caddy",

      // ----- Done -----
      "echo '== braintwin user-data complete =='",
      "echo '== awaiting M.2.f (ECR + S3) and M.3 (docker compose up) ==' ",
    );

    return ud;
  }
}

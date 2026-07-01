/**
 * ComputeConstruct — EC2 + EBS + instance profile + EIP association +
 * full app bring-up + Caddy TLS edge.
 *
 * Phase 4.0.6 M.2.e (host + OS) → M.3.a (app bring-up) → M.4.b
 * (Caddy + Cloudflare DNS-01 + Authenticated Origin Pulls). With
 * the M.4.b expansion, first boot stands up three containers under
 * compose: app + bot + caddy. Caddy terminates TLS for
 * `config.publicHostname`, fronts the FastAPI app over the Docker
 * network, validates Cloudflare's per-zone client certificate, and
 * obtains/renews its Let's Encrypt cert via ACME DNS-01 using the
 * Cloudflare API token from SSM.
 *
 * ## What this construct creates
 *
 *   1. ONE IAM role, shared across all EC2s (CDK auto-creates the
 *      instance profile that wraps it when the role is passed to
 *      `ec2.Instance`).
 *      Permissions: SSM Session Manager + CloudWatch agent. ECR pull,
 *      S3 state bucket, SSM Parameter Store reads, and CloudWatch log
 *      writes are added by storage.ts / secrets.ts / observability.ts
 *      via `grant*` calls in braintwin-stack.ts.
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
 *   5. User-data that:
 *        a) installs Docker + docker-compose-plugin + AWS CLI,
 *        b) mounts the EBS at /var/lib/braintwin/data (UID 10001),
 *        c) fetches the 4 SSM secrets into /etc/braintwin/secrets.env,
 *        d) ECR-logs-in and writes /etc/braintwin/docker-compose.yml
 *           with the imageTag, ECR registry, and CloudWatch awslogs
 *           driver options templated in,
 *        e) `docker compose pull && docker compose up -d` — app + bot.
 *
 * ## Cloudflare Authenticated Origin Pulls (AOP) — flagged from M.2.d
 *
 * The Security Group filters by Cloudflare's shared egress IPs, which
 * proves the request came through SOME Cloudflare zone, not OUR zone.
 * Caddy needs to validate Cloudflare's per-zone client certificate
 * against Cloudflare's Origin Pull CA. M.3.a creates /etc/caddy/ but
 * Caddy itself + the Origin Pull cert land in M.4 along with the
 * Cloudflare DNS + ACME wiring.
 *
 * ## Cost note
 *
 * Each EC2 (t4g.small) + 20 GiB gp3 + EIP-while-attached = ~$17/month.
 * The added CloudWatch Logs storage from awslogs is bounded by the
 * 30-day retention set in observability.ts; expect <$2/month for typical
 * single-user traffic. Synth-and-don't-deploy is free.
 */
import * as path from "path";
import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3assets from "aws-cdk-lib/aws-s3-assets";
import * as ssm from "aws-cdk-lib/aws-ssm";
import { Construct, IConstruct } from "constructs";
import { NetworkConstruct } from "./network";
import { ObservabilityConstruct } from "./observability";
import { SecretsConstruct } from "./secrets";
import { StorageConstruct } from "./storage";
import { brandedName, brandedPath, RegionConfig } from "../stack-config";

export interface ComputeConstructProps {
  readonly config: RegionConfig;
  readonly network: NetworkConstruct;
  /**
   * Storage construct — compute needs the ECR repo name so the
   * boot-time `docker pull` can target the right registry path.
   */
  readonly storage: StorageConstruct;
  /**
   * Secrets construct — compute needs the SSM parameter NAMES so the
   * boot script can fetch the four secrets into /etc/braintwin/secrets.env.
   * The construct grants `ssm:GetParameter` on the same role separately
   * in braintwin-stack.ts (it's a method call, not a constructor wiring).
   */
  readonly secrets: SecretsConstruct;
  /**
   * Observability construct — compute references the three log group
   * names (app, bot, caddy) so the per-service `awslogs` driver in
   * docker-compose ships container stdout straight to CloudWatch.
   */
  readonly observability: ObservabilityConstruct;
  /**
   * ECR image tag the user-data will `docker pull` at boot. Threaded
   * through from `bin/braintwin.ts` (which reads it from
   * `--context imageTag=<tag>`). Defaults to "bootstrap" upstream — a
   * deploy with that placeholder will boot an EC2 that fails its pull,
   * which is the intended fail-loud behaviour for "you forgot to run
   * build-and-push.sh before deploy.sh."
   */
  readonly imageTag: string;

  /**
   * ECR tag for the custom Caddy image (M.4.a / M.4.b). Same plumbing
   * as imageTag - threaded from bin/braintwin.ts via
   * `--context caddyImageTag=<tag>`; user-data does `docker pull
   * <registry>/braintwin/caddy:<caddyImageTag>` for the TLS edge.
   * Built by BrainTwin/scripts/build-and-push-caddy.sh.
   */
  readonly caddyImageTag: string;
}

export class ComputeConstruct extends Construct {
  /** Shared IAM role attached to every EC2 in this construct. */
  public readonly instanceRole: iam.Role;

  /** One EC2 per AZ in `config.availabilityZones`. instances[0] is primary. */
  public readonly instances: ec2.Instance[];

  /** One gp3 volume per AZ, RETAIN policy, attached to the AZ-matched EC2. */
  public readonly ebsVolumes: ec2.Volume[];

  /**
   * SSM String parameter holding the ECR app image tag the EC2 should
   * run. The tag is read at boot (and on every deploy.sh-triggered
   * refresh) — NOT baked into user-data — so an image bump updates only
   * this parameter and never replaces the instance. See the "Option A"
   * note in `_buildUserData`.
   */
  /** M.12 — static config files served from the CDK bootstrap bucket. */
  private readonly cwAgentConfigAsset: s3assets.Asset;
  private readonly chromaBackupScriptAsset: s3assets.Asset;
  private readonly chromaBackupServiceAsset: s3assets.Asset;
  private readonly chromaBackupTimerAsset: s3assets.Asset;

  public readonly imageTagParameter: ssm.StringParameter;

  /** SSM String parameter holding the ECR Caddy image tag. See above. */
  public readonly caddyImageTagParameter: ssm.StringParameter;

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
      // IAM role description must be plain hyphen-minus only. IAM
      // rejects descriptions outside [TAB | LF | CR | U+0020-007E |
      // U+00A1-00FF]. Em dash (U+2014) falls in the excluded
      // U+007F-U+00A0 window and hard-fails CFN deploy.
      description:
        "BrainTwin EC2 role - SSM Session Manager + CloudWatch agent. " +
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
    // 1b) Image-tag SSM parameters (Option A — decoupled deploys).
    //
    // The image tags the box runs live HERE, not in user-data. Baking
    // them into user-data made every image bump change the boot script,
    // which (with userDataCausesReplacement) forced a full instance
    // replacement — and that deadlocked on the single RETAIN EBS volume
    // (the new instance can't attach a volume the old one still holds).
    //
    // Now: user-data reads these parameter names at boot, and
    // scripts/deploy.sh updates the VALUES (via this CFN resource) then
    // triggers an in-place `docker compose pull && up -d` over SSM. An
    // image bump touches only these two parameters; the instance is
    // never replaced and the EBS volume never moves.
    //
    // When state moves off the box (RDS + hosted Chroma) and we run
    // multiple stateless instances, this same "tag in SSM, pull to
    // apply" primitive becomes the rolling-deploy mechanism.
    this.imageTagParameter = new ssm.StringParameter(this, "ImageTagParam", {
      parameterName: brandedPath("image_tag"),
      stringValue: props.imageTag,
      description:
        "ECR app image tag the EC2 runs. Updated by scripts/deploy.sh; " +
        "read at boot and on each SSM-triggered refresh.",
    });
    this.caddyImageTagParameter = new ssm.StringParameter(
      this,
      "CaddyImageTagParam",
      {
        parameterName: brandedPath("caddy_image_tag"),
        stringValue: props.caddyImageTag,
        description:
          "ECR Caddy image tag the EC2 runs. Updated by scripts/deploy.sh; " +
          "read at boot and on each SSM-triggered refresh.",
      },
    );

    // Scoped read: GetParameter on exactly these two parameter ARNs.
    this.imageTagParameter.grantRead(this.instanceRole);
    this.caddyImageTagParameter.grantRead(this.instanceRole);

    // -----------------------------------------------------------------
    // 1.5) Static config files as s3.Asset (M.12, Phase 4.0.6.1)
    //
    // EC2 user-data is hard-capped at 16 KB after base64 encoding. The
    // pre-M.12 user-data was within ~50 bytes of the limit because we
    // were embedding the CW Agent JSON, the chroma backup script, and
    // its systemd units inline. None of those files have CDK-time
    // substitutions, so they belong out of user-data entirely.
    //
    // Each asset:
    //   - is hashed by content; the same file produces the same S3 key
    //   - lives in the CDK bootstrap bucket
    //     (cdk-hnb659fds-assets-<account>-<region>)
    //   - grants read on the precise key path to the instance role
    //   - exposes s3BucketName / s3ObjectKey tokens that resolve at
    //     deploy time so user-data can fetch via `aws s3 cp`
    //
    // What stays inline in user-data (and why):
    //   - Caddyfile — has two CDK config substitutions
    //     (publicHostname, budgetAlertEmail); externalizing would
    //     require runtime env substitution. M.12.b candidate.
    //   - litestream.yml — has refresh-time $ACCOUNT_ID/$REGION
    //     substitution. Small enough that the savings aren't worth
    //     the complexity.
    //   - docker-compose.yml — heavily templated by refresh.sh;
    //     keep there.
    //   - Cloudflare Origin Pull CA fetch — genuinely runtime
    //     (a remote curl).
    // -----------------------------------------------------------------
    const assetsDir = path.join(__dirname, "..", "..", "assets");
    // The CW Agent config drops BOTH instance-lifetime dimensions:
    //   - `append_dimensions` (InstanceId) is removed → no InstanceId tag
    //   - `omit_hostname: true` is set in the agent block → no host tag
    //
    // Why: we run a single EC2 architecture; each §14.1 instance
    // replacement would otherwise mint new InstanceId-AND-host-tagged
    // metric tuples that persist for 15 months (CW custom-metric
    // retention), accumulating cost (~$0.30/metric/month each) AND
    // chart clutter (one ghost line per old instance in every SEARCH
    // expression) without any informational value. There's only ever
    // one BrainTwin EC2 emitting at a time.
    //
    // With both dropped, every replacement reuses the same metric
    // tuples — charts show one line per real physical dimension (per
    // CPU, per partition), cost stays bounded.
    //
    // Add either dimension back ONLY if we move to multi-instance
    // (e.g., the Phase 5 horizontal scaling path in §13 of the main
    // design doc), and even then prefer a stable label like `az` or
    // `node-role` over the ephemeral InstanceId.
    this.cwAgentConfigAsset = new s3assets.Asset(this, "CWAgentConfigAsset", {
      path: path.join(assetsDir, "amazon-cloudwatch-agent.json"),
    });
    this.chromaBackupScriptAsset = new s3assets.Asset(
      this,
      "ChromaBackupScriptAsset",
      { path: path.join(assetsDir, "braintwin-chroma-backup.sh") },
    );
    this.chromaBackupServiceAsset = new s3assets.Asset(
      this,
      "ChromaBackupServiceAsset",
      { path: path.join(assetsDir, "braintwin-chroma-backup.service") },
    );
    this.chromaBackupTimerAsset = new s3assets.Asset(
      this,
      "ChromaBackupTimerAsset",
      { path: path.join(assetsDir, "braintwin-chroma-backup.timer") },
    );
    for (const asset of [
      this.cwAgentConfigAsset,
      this.chromaBackupScriptAsset,
      this.chromaBackupServiceAsset,
      this.chromaBackupTimerAsset,
    ]) {
      asset.grantRead(this.instanceRole);
    }

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
    const userData = this._buildUserData(props);

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
        // Replace the instance when the user-data itself changes, so
        // cloud-init (which runs user-data only once, on first boot)
        // actually re-executes a STRUCTURAL boot change. Under Option A
        // the image tags are NOT in user-data — they live in SSM — so a
        // routine image bump leaves user-data byte-identical and does
        // NOT trigger replacement (that path is the in-place SSM refresh
        // instead). Only genuine boot-script changes (new package, new
        // mount, Caddyfile edit) replace the box, which is rare. When a
        // replacement does happen, the operator detaches the RETAIN data
        // volume first (see scripts / the EBS conflict runbook).
        userDataCausesReplacement: true,
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

      // ----- IMDS hop limit bump for in-container AWS SDK access -----
      // CDK's `requireImdsv2: true` shortcut produces a LaunchTemplate with
      // HttpPutResponseHopLimit=1 (the EC2 default). That blocks any
      // Docker container from reaching the IMDS endpoint, because the
      // docker0 bridge counts as a network hop. Litestream (and any
      // future containerized tool that uses the AWS SDK's default
      // credential chain) falls back to IMDS and errors with
      //   NoCredentialProviders: no valid providers in chain.
      // Bump to 2 so containers can reach IMDS but the hop limit still
      // bounds metadata-exfil blast radius. See §14 invariant.
      // The `requireImdsv2: true` shortcut installs a CDK Aspect that
      // synthesizes a LaunchTemplate at the same level as the instance.
      // We can't override CFN properties until the Aspect has run — so
      // we register a Prepare-phase callback that finds the LT after
      // synthesis-time tree traversal and tacks our override on.
      cdk.Aspects.of(instance).add({
        visit(node: IConstruct) {
          if (node instanceof ec2.CfnLaunchTemplate) {
            node.addPropertyOverride(
              "LaunchTemplateData.MetadataOptions.HttpPutResponseHopLimit",
              2,
            );
          }
        },
      });

      // The boot-time refresh script reads both image-tag parameters, so
      // they must exist before the instance comes up.
      instance.node.addDependency(
        this.imageTagParameter,
        this.caddyImageTagParameter,
      );

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
        "Primary EBS volume ID. RETAIN policy - survives cdk destroy.",
    });
  }

  /**
   * The bash that runs as root on first boot.
   *
   * After M.3.a this is end-to-end: by the time the script exits the
   * EC2 has Docker installed, the EBS data volume mounted, secrets
   * fetched from SSM, docker-compose.yml written, and `docker compose
   * up -d` kicked off. SSM Session Manager smoke test is then:
   *   aws ssm start-session --target i-xxx --profile braintwin
   *   sudo docker compose -f /etc/braintwin/docker-compose.yml ps
   *   curl -fsS http://127.0.0.1:8000/health
   *
   * Layout of /etc/braintwin/:
   *   secrets.env        — SSM secrets, mode 0600
   *   docker-compose.yml — generated, references awslogs driver per service
   *
   * Things explicitly OUT of scope (deferred to later milestones):
   *   - Caddy reverse proxy + Cloudflare Origin Pull CA cert (M.4)
   *   - Litestream WAL streaming to S3 (M.5)
   *   - CloudWatch Agent for system metrics (CPU/memory/disk) (M.6)
   */
  private _buildUserData(props: ComputeConstructProps): ec2.UserData {
    const ud = ec2.UserData.forLinux();
    // imageTag / caddyImageTag are intentionally NOT destructured here:
    // under Option A they live in SSM and are read at runtime by the
    // refresh script, never baked into this user-data.
    // M.10 — `secrets` (the SecretsConstruct) is intentionally NOT
    // destructured here. After the discovery pattern landed, the
    // refresh script reads every parameter under /braintwin/ at
    // runtime via get-parameters-by-path; it no longer needs CDK to
    // bake individual parameter names into user-data. The IAM grant
    // for GetParametersByPath lives in secrets.ts and is wired by
    // braintwin-stack.ts via secrets.grantReadAll(instanceRole).
    const { config, storage, observability } = props;

    ud.addCommands(
      // Strict mode + everything to a log file we can `sudo tail` later
      // via Session Manager.
      "set -euxo pipefail",
      "exec > >(tee -a /var/log/braintwin-userdata.log | logger -t braintwin-userdata) 2>&1",

      // ----- Base packages -----
      "export DEBIAN_FRONTEND=noninteractive",
      "apt-get update -y",
      "apt-get install -y --no-install-recommends \\",
      "  ca-certificates curl gnupg lsb-release jq awscli e2fsprogs",

      // ----- Resolve region from IMDS (needed by `aws s3 cp` for the
      // M.12 asset downloads below). IMDSv2 token + region call; the
      // refresh script later redefines REGION inside its own scope.
      'IMDS_TOKEN=$(curl -sX PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")',
      'REGION=$(curl -sH "X-aws-ec2-metadata-token: $IMDS_TOKEN" http://169.254.169.254/latest/meta-data/placement/region)',
      'export AWS_DEFAULT_REGION="$REGION"',

      // ----- s3cp_retry: download an M.12 asset with backoff -----
      // These files used to be inlined in user-data (guaranteed
      // present, no network). Fetching them from S3 at boot adds a
      // transient-failure surface — a slow NAT warm-up or an S3 blip
      // would otherwise abort the whole user-data run under `set -e`.
      // 5 attempts with backoff, mirroring the Cloudflare CA fetch
      // below, then fail loud. Usage: s3cp_retry <s3-url> <dest>.
      "s3cp_retry() {",
      "  for i in $(seq 1 5); do",
      '    aws s3 cp "$1" "$2" && return 0',
      '    echo "s3 cp $1 failed (attempt $i); retrying in 5s…"',
      "    sleep 5",
      "  done",
      '  echo "s3 cp $1 failed after 5 attempts; aborting"; return 1',
      "}",

      // ----- Docker (from Docker's apt repo, not Ubuntu's older fork) -----
      "install -m 0755 -d /etc/apt/keyrings",
      // --yes makes gpg --dearmor non-interactive when the target file
      // already exists. Without it, re-running user-data (debug or
      // recovery) prompts "Overwrite? (y/N)" and stalls under sudo.
      "curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor --yes -o /etc/apt/keyrings/docker.gpg",
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
      // mount. The compose runs via root/systemd.
      "id -u braintwin >/dev/null 2>&1 || useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin braintwin",

      // ----- Find and mount the EBS data volume -----
      // /dev/sdf is requested by CDK; Nitro kernel renames to /dev/nvme1n1
      // (slot order). We match by SIZE so we don't care about device name.
      // Interpolated from config so a future size bump can't silently
      // desync from the lsblk size-match below.
      `EBS_SIZE_GIB=${config.ebsSizeGiB}`,
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

      // ----- Caddy directory + Cloudflare Origin Pull CA cert (M.4.b) -----
      // /etc/caddy/ holds the Origin Pull CA we'll bind-mount into the
      // Caddy container for Authenticated Origin Pulls. The cert is
      // PUBLIC — Cloudflare publishes it at a well-known URL. We pull
      // it at boot so a future cert rotation is just "redeploy the
      // EC2," no operator dance.
      //
      // The data and config sub-dirs on the EBS persist Caddy's
      // Let's Encrypt account info + issued certs across container
      // restarts AND instance replacements (EBS has RETAIN). Without
      // persistence Caddy would re-issue every restart and hit Let's
      // Encrypt's rate limit (5 certs / 7 days / domain).
      "mkdir -p /etc/caddy",
      "mkdir -p /var/lib/braintwin/data/caddy/data",
      "mkdir -p /var/lib/braintwin/data/caddy/config",
      // Caddy's alpine image runs the binary as root, so 0:0 ownership
      // on the mount source is fine. If the image ever switches to a
      // non-root UID, bump this to match.
      "chown -R 0:0 /var/lib/braintwin/data/caddy",
      // Retry the fetch — under `set -e` a single transient failure
      // (slow NAT, DNS not warm yet) would otherwise abort the entire
      // user-data script BEFORE the compose file is even written, which
      // looks exactly like "Caddy was never configured." 5 attempts with
      // backoff, then fail loud.
      "for i in $(seq 1 5); do",
      "  curl -fsSL https://developers.cloudflare.com/ssl/static/authenticated_origin_pull_ca.pem -o /etc/caddy/cloudflare-origin-ca.pem && break",
      '  echo "Origin Pull CA fetch failed (attempt $i); retrying in 5s…"',
      "  sleep 5",
      "done",
      'if [ ! -s /etc/caddy/cloudflare-origin-ca.pem ]; then echo "Could not fetch Cloudflare Origin Pull CA; aborting"; exit 1; fi',
      "chmod 644 /etc/caddy/cloudflare-origin-ca.pem",

      // =================================================================
      // M.5 additions — CloudWatch Agent + nightly Chroma backup
      // =================================================================
      //
      // Both are host-level (systemd) rather than containers because:
      //   - CW Agent reads /proc to collect OS metrics; trivial outside
      //     a container, awkward inside (needs --pid=host etc.).
      //   - Chroma backup needs the same /var/lib/braintwin/data tree
      //     that Docker has bind-mounted into the app; running on the
      //     host gives a clean view without "stop containers, tar,
      //     start containers" choreography.
      //
      // Litestream IS a container — it follows the SQLite WAL via Docker
      // bind-mount and streams to S3. See the compose template below.

      // ----- CloudWatch Agent (M.5) -----
      // Installs the arm64 build, writes a config that collects only OS
      // metrics (CPU/mem/disk/net) in the BrainTwin/System namespace.
      // App-level metrics (per-route latency, recall phase timing) are
      // deferred to a follow-up (M.11) — design doc §14.
      //
      // The `CloudWatchAgentServerPolicy` is already on the instance
      // role from M.2.e, so the agent's PutMetricData calls just work.
      "wget -q https://s3.amazonaws.com/amazoncloudwatch-agent/ubuntu/arm64/latest/amazon-cloudwatch-agent.deb -O /tmp/cwagent.deb",
      "dpkg -i /tmp/cwagent.deb",
      "rm -f /tmp/cwagent.deb",
      // CW Agent JSON config from s3.Asset (M.12). The asset hash
      // changes whenever the JSON does, forcing a re-fetch on the
      // next boot; routine deploys with no config change re-fetch
      // the same key (idempotent).
      `s3cp_retry s3://${this.cwAgentConfigAsset.s3BucketName}/${this.cwAgentConfigAsset.s3ObjectKey} /opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json`,
      "/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -c file:/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json -s",

      // ----- Nightly Chroma backup (M.5) -----
      // Script + systemd timer. Runs at 03:30 UTC, 30 min after the
      // DLM EBS snapshots (03:00) so the disk isn't busy with both at
      // once. tarballs /var/lib/braintwin/data/chroma → S3, 7d retention
      // is enforced by the S3 lifecycle rule in storage.ts.
      //
      // The 'quoted-EOF' on this heredoc preserves the script's $-vars
      // literally so they get resolved inside the script when it runs,
      // not at user-data time.
      // Chroma backup script + systemd units from s3.Asset (M.12).
      // Each download is content-addressed; redeploying with no asset
      // change re-fetches the same S3 key (idempotent).
      `s3cp_retry s3://${this.chromaBackupScriptAsset.s3BucketName}/${this.chromaBackupScriptAsset.s3ObjectKey} /usr/local/bin/braintwin-chroma-backup.sh`,
      "chmod 0755 /usr/local/bin/braintwin-chroma-backup.sh",
      `s3cp_retry s3://${this.chromaBackupServiceAsset.s3BucketName}/${this.chromaBackupServiceAsset.s3ObjectKey} /etc/systemd/system/braintwin-chroma-backup.service`,
      `s3cp_retry s3://${this.chromaBackupTimerAsset.s3BucketName}/${this.chromaBackupTimerAsset.s3ObjectKey} /etc/systemd/system/braintwin-chroma-backup.timer`,

      "systemctl daemon-reload",
      "systemctl enable --now braintwin-chroma-backup.timer",

      // =================================================================
      // M.3.a additions — app bring-up
      // =================================================================
      //
      // From here down: resolve instance metadata, fetch secrets, ECR
      // login, write docker-compose.yml, pull image, `docker compose up`.

      // ----- Resolve account + region from IMDSv2 -----
      // We can't hardcode REGION as a CDK token because the same compute
      // construct deploys per-region (us-west-2 today, ap-south-1 later
      // per stack-config.ts). The account ID is similarly needed to
      // build the ECR registry hostname. IMDSv2 (token-required) is
      // already enforced on the instance (requireImdsv2:true above).
      'IMDS_TOKEN=$(curl -sX PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")',
      'REGION=$(curl -sH "X-aws-ec2-metadata-token: $IMDS_TOKEN" http://169.254.169.254/latest/meta-data/placement/region)',
      'ACCOUNT_ID=$(curl -sH "X-aws-ec2-metadata-token: $IMDS_TOKEN" http://169.254.169.254/latest/dynamic/instance-identity/document | jq -r .accountId)',
      'export AWS_DEFAULT_REGION="$REGION"',
      'echo "Resolved region=$REGION account=$ACCOUNT_ID"',

      // ----- Secrets.env directory permissions -----
      // M.7.5: the actual fetch + secrets.env regeneration happens
      // INSIDE the refresh script below, so a SSM-triggered redeploy
      // can rotate secrets without replacing the instance. Here we
      // only make sure /etc/braintwin/ exists with the right mode
      // before the refresh script's `cat > /etc/braintwin/secrets.env`
      // runs.
      "mkdir -p /etc/braintwin",
      "chmod 700 /etc/braintwin",

      // ----- Write the in-place refresh script (Option A) -----
      // The image tags are decoupled from this user-data. Instead of
      // baking IMAGE_TAG / CADDY_IMAGE_TAG in (which would make every
      // bump rewrite user-data → replace the instance → deadlock on the
      // single RETAIN EBS volume), we write a script that reads the tags
      // from SSM at RUNTIME, regenerates docker-compose.yml, and runs
      // `docker compose pull && up -d`. It runs once below at first boot,
      // and again whenever scripts/deploy.sh fires it via SSM RunCommand
      // after a deploy — no instance replacement involved.
      //
      // The heredoc terminator is QUOTED ('BRAINTWIN_REFRESH_EOF') so the
      // OUTER user-data bash writes the body verbatim: every $VAR survives
      // into the file and is expanded when the SCRIPT itself runs. CDK
      // ${...} substitution still happens at synth — that's how the repo
      // names and log-group names get baked in. Those are structural and
      // never change on an image bump, so user-data stays byte-identical
      // across routine deploys (which is the whole point).
      "cat > /usr/local/bin/braintwin-refresh.sh <<'BRAINTWIN_REFRESH_EOF'",
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      // Resolve region + account from IMDSv2 — standalone so the script
      // works both at boot and when re-run later over SSM RunCommand.
      'IMDS_TOKEN=$(curl -sX PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")',
      'REGION=$(curl -sH "X-aws-ec2-metadata-token: $IMDS_TOKEN" http://169.254.169.254/latest/meta-data/placement/region)',
      'ACCOUNT_ID=$(curl -sH "X-aws-ec2-metadata-token: $IMDS_TOKEN" http://169.254.169.254/latest/dynamic/instance-identity/document | jq -r .accountId)',
      'export AWS_DEFAULT_REGION="$REGION"',
      // The two image tags — the ones that change on a routine deploy.
      `IMAGE_TAG=$(aws ssm get-parameter --name ${brandedPath("image_tag")} --query Parameter.Value --output text)`,
      `CADDY_IMAGE_TAG=$(aws ssm get-parameter --name ${brandedPath("caddy_image_tag")} --query Parameter.Value --output text)`,
      'echo "Resolved image_tag=$IMAGE_TAG caddy_image_tag=$CADDY_IMAGE_TAG"',

      // ----- Discover SSM secrets + regenerate /etc/braintwin/secrets.env -----
      // M.10 discovery pattern: instead of hardcoding which parameter
      // names to fetch (which means a CDK edit + instance replacement
      // every time we add a secret), we read EVERYTHING under
      // /braintwin/ in one `get-parameters-by-path --recursive` call.
      // Adding a new secret thereafter is:
      //   ./scripts/put-secrets.sh new_thing
      //   ./scripts/deploy.sh            # SSM RunCommand → refresh
      // Zero CDK changes, zero instance churn.
      //
      // Two name mappings are layered on top of basename-uppercase:
      //
      //   1. image_tag + caddy_image_tag are NOT secrets — they're
      //      plaintext image-version pointers handled in their own
      //      get-parameter calls above. Skip them in the discovery loop
      //      or they'd leak into secrets.env.
      //
      //   2. Three of the existing five secrets have an app-side env
      //      var name that differs from their SSM basename uppercased:
      //         anthropic_key  → ANTHROPIC_API_KEY
      //         bearer_token   → BACKEND_BEARER_TOKEN
      //         telegram_token → TELEGRAM_BOT_TOKEN
      //      The other two (cloudflare_api_token, allowed_telegram_user_ids)
      //      already match. A small alias `case` block handles the three
      //      renames so we don't have to migrate the SSM param names.
      //      Any new secret added via put-secrets.sh just uses the
      //      uppercased basename — no CDK edit needed.
      //
      // umask 077 → the redirect-to-file below creates mode 0600 by
      // default; chmod is belt-and-suspenders.
      "umask 077",
      "{",
      '  echo "# Generated by braintwin-refresh.sh from SSM /braintwin/ discovery."',
      '  echo "# Edit /braintwin/<name> in SSM, then re-run refresh — do NOT edit by hand."',
      // Parse via `jq -r @tsv`, NOT `--output text`. CLI text output is
      // newline-separated rows, so a secret whose VALUE contains a
      // newline (a PEM, a JSON service-account blob) would split across
      // "rows" and corrupt the env file. `@tsv` escapes embedded tabs
      // and newlines into \t / \n, and the read below un-escapes only
      // the field delimiter — values stay intact on one line.
      "  aws ssm get-parameters-by-path \\",
      "    --path /braintwin/ \\",
      "    --recursive \\",
      "    --with-decryption \\",
      "    --query 'Parameters[*].[Name,Value]' \\",
      "    --output json |",
      "    jq -r '.[] | @tsv' |",
      '    while IFS=$\'\\t\' read -r name value; do',
      '      base=$(basename "$name")',
      // DENYLIST, not allowlist: every param under /braintwin/ that is
      // NOT listed here becomes a container env var. Any future
      // non-secret param (another image pointer, a feature flag, an ops
      // note) MUST be added to this case or it leaks into secrets.env.
      "      case \"$base\" in",
      "        image_tag|caddy_image_tag) continue ;;",
      "      esac",
      `      key=$(echo "$base" | tr '[:lower:]' '[:upper:]')`,
      "      case \"$key\" in",
      "        ANTHROPIC_KEY)  key=ANTHROPIC_API_KEY ;;",
      "        BEARER_TOKEN)   key=BACKEND_BEARER_TOKEN ;;",
      "        TELEGRAM_TOKEN) key=TELEGRAM_BOT_TOKEN ;;",
      "      esac",
      '      echo "${key}=${value}"',
      "    done",
      "} > /etc/braintwin/secrets.env",
      "chmod 600 /etc/braintwin/secrets.env",
      "umask 022",
      // Defensive check: secrets.env must be non-empty AND contain the
      // 5 expected app-side env var names. If the SSM bag is missing a
      // param (forgot put-secrets.sh on a fresh account, or a typo in
      // a rotation), fail loud here rather than starting containers
      // that crash on missing env.
      "for k in ANTHROPIC_API_KEY BACKEND_BEARER_TOKEN TELEGRAM_BOT_TOKEN CLOUDFLARE_API_TOKEN ALLOWED_TELEGRAM_USER_IDS; do",
      '  grep -q "^${k}=" /etc/braintwin/secrets.env || {',
      '    echo "FATAL: /etc/braintwin/secrets.env is missing ${k}. Did you run scripts/put-secrets.sh?" >&2',
      "    exit 1",
      "  }",
      "done",
      // Structural values baked at synth (do not change on image bumps).
      `ECR_REPO="${storage.appRepo.repositoryName}"`,
      `CADDY_REPO="${storage.caddyRepo.repositoryName}"`,
      'REGISTRY="$ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com"',
      `APP_LOG_GROUP="${observability.appLogGroup.logGroupName}"`,
      `BOT_LOG_GROUP="${observability.botLogGroup.logGroupName}"`,
      `CADDY_LOG_GROUP="${observability.caddyLogGroup.logGroupName}"`,
      // ECR login — re-runs each refresh so a later SSM-triggered pull
      // always has fresh credentials (the auth token is valid ~12h).
      'aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$REGISTRY"',
      "cat > /etc/braintwin/docker-compose.yml <<COMPOSE_EOF",
      "# Generated by BrainTwinCDK user-data on first boot. Do NOT edit by",
      "# hand — re-deploy via BrainTwinCDK/scripts/deploy.sh instead.",
      "services:",
      "",
      "  app:",
      "    image: $REGISTRY/$ECR_REPO:$IMAGE_TAG",
      "    container_name: braintwin-app",
      "    restart: unless-stopped",
      "    # Hardening — same as the local compose, copied verbatim.",
      "    security_opt:",
      "      - no-new-privileges:true",
      "    cap_drop:",
      "      - ALL",
      "    # Loopback-only host port - public traffic comes through",
      "    # Caddy (the caddy service below) which reverse-proxies to",
      "    # app:8000 over the Docker network. This 127.0.0.1 mapping",
      "    # is kept purely for in-EC2 smoke testing via SSM",
      "    # (curl http://127.0.0.1:8000/health from the shell).",
      "    ports:",
      '      - "127.0.0.1:8000:8000"',
      "    env_file:",
      "      - /etc/braintwin/secrets.env",
      "    environment:",
      "      SQLITE_PATH: /data/braintwin.db",
      "      CHROMA_PATH: /data/chroma",
      "      IMAGES_PATH: /data/images",
      "      TELEGRAM_STATE_PATH: /data/telegram_state.json",
      "      CAPTURE_FAILURES_PATH: /data/capture_failures.jsonl",
      "      ENRICHMENTS_PATH: /data/enrichments.jsonl",
      "      HYDRATIONS_PATH: /data/hydrations.jsonl",
      "      DATABASE_URL: sqlite+aiosqlite:////data/braintwin.db",
      "      BACKEND_HOST: 0.0.0.0",
      '      BACKEND_PORT: "8000"',
      "      WHISPER_MODEL_PATH: /data/models/ggml-small.en.bin",
      "    volumes:",
      "      # EBS data volume bind-mounted into the container at /data.",
      "      # Mount point is owned by UID 10001 (braintwin) so the",
      "      # container's non-root user can write.",
      "      - /var/lib/braintwin/data:/data",
      "    logging:",
      "      # awslogs driver ships container stdout straight to",
      "      # CloudWatch. Permission comes from the instance role",
      "      # via observability.grantLogWrite (braintwin-stack.ts).",
      "      driver: awslogs",
      "      options:",
      "        awslogs-region: $REGION",
      "        awslogs-group: $APP_LOG_GROUP",
      "        awslogs-stream: app",
      "    healthcheck:",
      '      test: ["CMD", "curl", "-fsS", "http://localhost:8000/health"]',
      "      interval: 30s",
      "      timeout: 5s",
      "      start_period: 60s",
      "      retries: 3",
      "",
      "  bot:",
      "    image: $REGISTRY/$ECR_REPO:$IMAGE_TAG",
      "    container_name: braintwin-bot",
      "    restart: unless-stopped",
      "    security_opt:",
      "      - no-new-privileges:true",
      "    cap_drop:",
      "      - ALL",
      "    env_file:",
      "      - /etc/braintwin/secrets.env",
      "    environment:",
      "      BACKEND_CAPTURE_URL: http://app:8000/capture",
      "      SQLITE_PATH: /data/braintwin.db",
      "      CHROMA_PATH: /data/chroma",
      "      IMAGES_PATH: /data/images",
      "      TELEGRAM_STATE_PATH: /data/telegram_state.json",
      "      CAPTURE_FAILURES_PATH: /data/capture_failures.jsonl",
      "      DATABASE_URL: sqlite+aiosqlite:////data/braintwin.db",
      "      # ALLOWED_TELEGRAM_USER_IDS comes from secrets.env (M.7.5).",
      "      # Rotate the allowlist via:",
      "      #   ./scripts/put-secrets.sh   (skip-on-empty all but the 5th)",
      "      #   ./scripts/deploy.sh        (refresh re-writes secrets.env)",
      "    volumes:",
      "      - /var/lib/braintwin/data:/data",
      "    logging:",
      "      driver: awslogs",
      "      options:",
      "        awslogs-region: $REGION",
      "        awslogs-group: $BOT_LOG_GROUP",
      "        awslogs-stream: bot",
      '    command: ["python", "-m", "backend.telegram_bot.bot"]',
      // Bot is a Telegram polling worker, not a web server. The app
      // image's Dockerfile HEALTHCHECK targets uvicorn on :8000, which
      // the bot never starts - so the inherited check would always
      // fail and the container would perpetually report "unhealthy."
      //
      // First attempt used pgrep but the python:slim base doesn't ship
      // procps. Switched to grep against /proc/*/cmdline — kernel-
      // provided pseudo-files, always present on Linux, zero image
      // additions needed. exit 0 if any running process's command
      // line contains "backend.telegram_bot"; exit 1 otherwise.
      // See phase4.0.6.1-polish-design.md §2.0.
      //
      // The pattern is bracketed ([b]ackend) so the check can't match
      // ITSELF: docker runs the test via `sh -c "grep …"`, and that
      // shell's own /proc/<pid>/cmdline contains the pattern string.
      // A plain `backend.telegram_bot` would match the shell running
      // the probe and report healthy even when the bot is dead. The
      // bracket makes the literal cmdline ("[b]ackend…") not match the
      // regex, while the real `python -m backend.telegram_bot.bot`
      // process still does.
      "    healthcheck:",
      '      test: ["CMD-SHELL", "grep -l [b]ackend.telegram_bot /proc/*/cmdline >/dev/null 2>&1"]',
      // interval (30s), timeout (30s), retries (3) all match docker
      // compose defaults — explicit lines elided to save user-data bytes.
      // Adjust here if the defaults stop being right.
      "    depends_on:",
      "      app:",
      "        condition: service_healthy",
      "",
      "  caddy:",
      "    # Custom Caddy with caddy-dns/cloudflare plugin compiled in",
      "    # (BrainTwin/caddy/Dockerfile). Used for ACME DNS-01.",
      "    image: $REGISTRY/$CADDY_REPO:$CADDY_IMAGE_TAG",
      "    container_name: braintwin-caddy",
      "    restart: unless-stopped",
      "    # Hardening - same as app/bot. The cap_add line is the one",
      "    # exception: NET_BIND_SERVICE lets a non-root process bind",
      "    # to :80 and :443. Without it the container can't open the",
      "    # privileged ports even though it's root inside.",
      "    security_opt:",
      "      - no-new-privileges:true",
      "    cap_drop:",
      "      - ALL",
      "    cap_add:",
      "      - NET_BIND_SERVICE",
      "    ports:",
      "      # Public HTTPS. Cloudflare proxy is the only IP set the SG",
      "      # admits, so the actual exposure is Cloudflare-egress-only.",
      '      - "443:443"',
      "      # Plain HTTP. Caddy redirects -> HTTPS automatically. With",
      "      # Cloudflare proxy + Always Use HTTPS on, public clients",
      "      # never reach :80, but Caddy needs it for the ACME HTTP",
      "      # challenge fallback if DNS-01 ever errors mid-renewal.",
      '      - "80:80"',
      "    env_file:",
      "      # CLOUDFLARE_API_TOKEN is read here for the ACME DNS-01",
      "      # plugin; the Caddyfile references it as",
      "      # {env.CLOUDFLARE_API_TOKEN}.",
      "      - /etc/braintwin/secrets.env",
      "    volumes:",
      "      - /etc/braintwin/Caddyfile:/etc/caddy/Caddyfile:ro",
      "      - /etc/caddy/cloudflare-origin-ca.pem:/etc/caddy/cloudflare-origin-ca.pem:ro",
      "      # Cert + ACME account state on EBS so it survives container",
      "      # restarts and instance replacements. Without persistence",
      "      # Caddy re-issues a cert on every restart and burns the LE",
      "      # rate limit (5 / 7 days / domain).",
      "      - /var/lib/braintwin/data/caddy/data:/data",
      "      - /var/lib/braintwin/data/caddy/config:/config",
      "    logging:",
      "      driver: awslogs",
      "      options:",
      "        awslogs-region: $REGION",
      "        awslogs-group: $CADDY_LOG_GROUP",
      "        awslogs-stream: caddy",
      "    depends_on:",
      "      app:",
      "        condition: service_healthy",
      "",
      "  litestream:",
      "    # M.5 — streams the SQLite WAL to S3 (7d retention). The",
      "    # upstream image is small and stable; no plugins → no custom",
      "    # build. AWS credentials come from the EC2 instance role via",
      "    # IMDSv2 (Litestream auto-detects when no AWS_* env vars are",
      "    # set). The bind-mount gives Litestream the same view of",
      "    # /var/lib/braintwin/data the app has, so it can read the",
      "    # WAL frames as the app writes them.",
      "    image: litestream/litestream:0.3.13",
      "    container_name: braintwin-litestream",
      // Match the host file owner (UID 10001 = braintwin). The Litestream
      // image runs as root by default; with `cap_drop: ALL` below, root
      // loses CAP_DAC_OVERRIDE and can no longer bypass file permissions,
      // so it can't write the `_litestream_seq` table to the DB owned by
      // 10001. Running as 10001 sidesteps the capability dance entirely.
      // See §14 in the design doc.
      '    user: "10001:10001"',
      "    restart: unless-stopped",
      "    security_opt:",
      "      - no-new-privileges:true",
      "    cap_drop:",
      "      - ALL",
      "    volumes:",
      "      - /etc/braintwin/litestream.yml:/etc/litestream.yml:ro",
      "      - /var/lib/braintwin/data:/data",
      "    command:",
      "      - replicate",
      "      - -config",
      "      - /etc/litestream.yml",
      "    logging:",
      "      # Route to the app log group with a 'litestream' stream so",
      "      # 'aws logs tail /braintwin/app' can show app + Litestream",
      "      # together (handy for 'why is recall slow? is the WAL",
      "      # checkpoint stuck?' debugging). Worst case, separate it to",
      "      # /braintwin/litestream later — that's another log group +",
      "      # one line change.",
      "      driver: awslogs",
      "      options:",
      "        awslogs-region: $REGION",
      "        awslogs-group: $APP_LOG_GROUP",
      "        awslogs-stream: litestream",
      "    depends_on:",
      "      # Don't start until the app has created the DB file.",
      "      app:",
      "        condition: service_healthy",
      "COMPOSE_EOF",
      "",
      // ----- Write litestream.yml (regenerated each refresh) -----
      // The S3 bucket name embeds account + region resolved at runtime.
      // Bash $REGION / $ACCOUNT_ID are already resolved earlier in this
      // refresh script (see IMDSv2 calls).
      "cat > /etc/braintwin/litestream.yml <<LITESTREAM_EOF",
      "# Generated by BrainTwinCDK at refresh time. Do NOT edit by hand.",
      "dbs:",
      "  - path: /data/braintwin.db",
      "    replicas:",
      "      - type: s3",
      "        bucket: braintwin-state-$ACCOUNT_ID-$REGION",
      "        path: litestream/braintwin.db",
      "        region: $REGION",
      "        # 168h = 7 days. Matches the s3 lifecycle rule on the",
      "        # litestream/ prefix in storage.ts so we don't keep paying",
      "        # to store frames the bucket policy will expire anyway.",
      "        retention: 168h",
      "        # Hourly snapshots (the default) + WAL replication every",
      "        # 1s. Snapshots compact older WAL into a single SQLite",
      "        # file in S3 to speed up restore.",
      "        snapshot-interval: 1h",
      "LITESTREAM_EOF",
      "",
      // Pull + (re)start. compose v2 pulls in parallel and only recreates
      // containers whose image actually changed, so an unchanged service
      // is left running untouched.
      "cd /etc/braintwin",
      "docker compose pull",
      "docker compose up -d",
      "docker compose ps",
      "BRAINTWIN_REFRESH_EOF",
      "chmod 0755 /usr/local/bin/braintwin-refresh.sh",

      // ----- Write the Caddyfile -----
      // Quoted heredoc terminator ('CADDYFILE_EOF') disables bash $-var
      // expansion - we want every $ in the file to pass through as
      // literal Caddy syntax (Caddy uses {env.X}-style placeholders,
      // not $X). CDK template-literal substitution (${...}) still
      // happens at synth time, which is how publicHostname and the
      // acme email get baked in.
      "cat > /etc/braintwin/Caddyfile <<'CADDYFILE_EOF'",
      "# Generated by BrainTwinCDK user-data on first boot. Do NOT edit by",
      "# hand - re-deploy via BrainTwinCDK/scripts/deploy.sh instead.",
      "",
      "{",
      `\temail ${config.budgetAlertEmail || "ops@example.invalid"}`,
      "\t# ACME DNS-01 via Cloudflare API. The token is read from the",
      "\t# env (env_file in docker-compose).",
      "\tacme_dns cloudflare {env.CLOUDFLARE_API_TOKEN}",
      "}",
      "",
      `${config.publicHostname} {`,
      "\t# Reverse proxy to the FastAPI app via the Docker network -",
      "\t# 'app' resolves to the app container's bridge IP. We pass the",
      "\t# original client IP via X-Forwarded-For (CF-Connecting-IP",
      "\t# would also work but this header is the FastAPI middleware's",
      "\t# default).",
      "\treverse_proxy app:8000",
      "",
      "\t# Authenticated Origin Pulls. mode require_and_verify means",
      "\t# any client without a valid certificate chained to the",
      "\t# Cloudflare Origin Pull CA gets refused at TLS handshake. The",
      "\t# SG already restricts source IPs to Cloudflare egress, but",
      "\t# AOP is the cryptographic proof - someone running a server",
      "\t# inside Cloudflare's network can't impersonate our zone's",
      "\t# origin without that cert.",
      "\ttls {",
      "\t\tclient_auth {",
      "\t\t\tmode require_and_verify",
      "\t\t\ttrust_pool file /etc/caddy/cloudflare-origin-ca.pem",
      "\t\t}",
      "\t}",
      "",
      "\t# HSTS. .net doesn't get HSTS preload like .app/.dev do, so we",
      "\t# add it explicitly. 2-year max-age, includeSubDomains, preload",
      "\t# (the latter just signals intent; actual preload requires",
      "\t# submission to https://hstspreload.org).",
      '\theader Strict-Transport-Security "max-age=63072000; includeSubDomains; preload"',
      "}",
      "CADDYFILE_EOF",

      // ----- Run the refresh script once (first boot) -----
      // Pulls the images for whatever tags are currently in SSM and
      // starts app + bot + caddy. Every subsequent deploy re-runs this
      // exact script over SSM RunCommand (scripts/deploy.sh) instead of
      // replacing the instance.
      "/usr/local/bin/braintwin-refresh.sh",
    );

    return ud;
  }
}

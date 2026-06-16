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
import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import { NetworkConstruct } from "./network";
import { ObservabilityConstruct } from "./observability";
import { SecretsConstruct } from "./secrets";
import { StorageConstruct } from "./storage";
import { brandedName, RegionConfig } from "../stack-config";

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
        // CRITICAL: without this, changing user-data (e.g. adding the
        // Caddy service) updates the instance's UserData property in
        // place but does NOT replace the instance — and cloud-init only
        // runs user-data once, on first boot. The running box would keep
        // its old /etc/braintwin/docker-compose.yml and never pick up the
        // new containers. Hashing the user-data into the logical ID forces
        // a clean replacement → cloud-init re-runs. The data survives
        // because the EBS data volume is a separate RETAIN volume matched
        // by size/label, not part of this instance.
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
    const {
      config,
      storage,
      secrets,
      observability,
      imageTag,
      caddyImageTag,
    } = props;

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

      // ----- Fetch SSM secrets into /etc/braintwin/secrets.env -----
      // umask 077 → cat heredoc writes mode 0600 by default; we chmod
      // explicitly after as belt-and-suspenders. /etc/braintwin/ itself
      // is 0700 so non-root can't even list the secrets file.
      "mkdir -p /etc/braintwin",
      "chmod 700 /etc/braintwin",
      "umask 077",
      `ANTHROPIC_KEY=$(aws ssm get-parameter --name ${secrets.anthropicKeyName} --with-decryption --query Parameter.Value --output text)`,
      `BEARER_TOKEN=$(aws ssm get-parameter --name ${secrets.bearerTokenName} --with-decryption --query Parameter.Value --output text)`,
      `TELEGRAM_TOKEN=$(aws ssm get-parameter --name ${secrets.telegramTokenName} --with-decryption --query Parameter.Value --output text)`,
      `CLOUDFLARE_TOKEN=$(aws ssm get-parameter --name ${secrets.cloudflareApiTokenName} --with-decryption --query Parameter.Value --output text)`,

      // Heredoc writes the env file. Bash expands $VAR-style references
      // INSIDE the unquoted EOF; that's what we want — the values were
      // resolved by the aws-cli calls above.
      "cat > /etc/braintwin/secrets.env <<EOF",
      "ANTHROPIC_API_KEY=$ANTHROPIC_KEY",
      "BACKEND_BEARER_TOKEN=$BEARER_TOKEN",
      "TELEGRAM_BOT_TOKEN=$TELEGRAM_TOKEN",
      "CLOUDFLARE_API_TOKEN=$CLOUDFLARE_TOKEN",
      "EOF",
      "chmod 600 /etc/braintwin/secrets.env",
      "umask 022",

      // ----- ECR login -----
      // Token is good for 12h. The boot is one-shot, so re-login on
      // image refresh requires a redeploy — fine for M.3, automated
      // pull-and-restart is a Phase 4.0.6.1 concern. Single login
      // covers both ECR repos (same registry hostname, same auth).
      `ECR_REPO="${storage.appRepo.repositoryName}"`,
      `CADDY_REPO="${storage.caddyRepo.repositoryName}"`,
      'REGISTRY="$ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com"',
      'aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$REGISTRY"',

      // ----- Write docker-compose.yml -----
      // CDK substitutes ${imageTag}, ${caddyImageTag} and the log
      // group names at synth time (those are TypeScript template
      // literals reaching CDK tokens). The $-prefixed bash vars
      // ($REGISTRY, $ECR_REPO, $REGION, etc.) are expanded by bash
      // when the heredoc fires. Don't quote the EOF terminator - we
      // WANT bash to expand $-vars on this side.
      `IMAGE_TAG="${imageTag}"`,
      `CADDY_IMAGE_TAG="${caddyImageTag}"`,
      `APP_LOG_GROUP="${observability.appLogGroup.logGroupName}"`,
      `BOT_LOG_GROUP="${observability.botLogGroup.logGroupName}"`,
      `CADDY_LOG_GROUP="${observability.caddyLogGroup.logGroupName}"`,
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
      "      # ALLOWED_TELEGRAM_USER_IDS unset → bot rejects all messages",
      "      # but DMs the sender their own user ID. To activate, add the",
      "      # ID to /etc/braintwin/secrets.env and restart the bot.",
      "    volumes:",
      "      - /var/lib/braintwin/data:/data",
      "    logging:",
      "      driver: awslogs",
      "      options:",
      "        awslogs-region: $REGION",
      "        awslogs-group: $BOT_LOG_GROUP",
      "        awslogs-stream: bot",
      '    command: ["python", "-m", "backend.telegram_bot.bot"]',
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
      "COMPOSE_EOF",

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

      // ----- Pull images + start containers -----
      // -d so the user-data script exits cleanly; docker keeps the
      // containers running under its systemd unit. Pull is parallel
      // by default in compose v2, so the app + bot + caddy all
      // download together.
      "cd /etc/braintwin",
      "docker compose pull",
      "docker compose up -d",

      // ----- Done -----
      "echo '== braintwin user-data complete =='",
      "docker compose ps",
    );

    return ud;
  }
}

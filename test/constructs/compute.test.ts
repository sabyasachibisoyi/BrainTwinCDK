/**
 * ComputeConstruct unit tests — Phase 4.0.6 M.2.e + M.3.a.
 *
 * Validates the shape (M.2.e): per-AZ EC2+EBS, RETAIN policy on the
 * data volume, EIP association on the primary, IAM role with the
 * right managed policies, user-data that does the EBS mount and
 * UID 10001 ownership.
 *
 * Validates the app bring-up (M.3.a): user-data fetches the four
 * SSM secrets, ECR-logs-in, writes the docker-compose.yml with the
 * imageTag interpolated, references both CloudWatch log groups via
 * the awslogs driver, and runs `docker compose up -d`.
 *
 * If any of these assertions break, the next deploy could either
 * (a) be unreachable from Cloudflare, (b) silently lose the corpus
 * on a destroy, (c) drop SSM access, (d) leak secrets through a
 * world-readable env file, or (e) ship to a wrong log group — all of
 * which are real regressions the PR review should catch BEFORE merge.
 */
import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { BrainTwinStack } from "../../lib/braintwin-stack";
import { brandedName, CONFIG, getConfig } from "../../lib/stack-config";

function makeStack(): cdk.Stack {
  const app = new cdk.App();
  return new BrainTwinStack(app, "TestStack-us-west-2", {
    env: { account: "123456789012", region: "us-west-2" },
    config: getConfig("us-west-2"),
    imageTag: "test-tag",
    caddyImageTag: "test-caddy-tag",
  });
}

describe("ComputeConstruct", () => {
  describe("Instance shape", () => {
    test("one EC2 per AZ in config (single AZ for v1)", () => {
      const t = Template.fromStack(makeStack());
      t.resourceCountIs("AWS::EC2::Instance", 1);
    });

    test("instance type is t4g.small (ARM, design §3.1)", () => {
      const t = Template.fromStack(makeStack());
      t.hasResourceProperties("AWS::EC2::Instance", {
        InstanceType: "t4g.small",
      });
    });

    test("instance has Name tag = brandedName('EC2-0')", () => {
      const t = Template.fromStack(makeStack());
      t.hasResourceProperties("AWS::EC2::Instance", {
        Tags: Match.arrayWith([
          Match.objectLike({ Key: "Name", Value: brandedName("EC2-0") }),
        ]),
      });
    });

    test("IMDSv2 required — IMDSv1 is the metadata-exfil CVE source", () => {
      const t = Template.fromStack(makeStack());
      // CDK encodes this as a LaunchTemplate with MetadataOptions —
      // the Instance references the LT.
      t.hasResourceProperties("AWS::EC2::LaunchTemplate", {
        LaunchTemplateData: Match.objectLike({
          MetadataOptions: Match.objectLike({
            HttpTokens: "required",
          }),
        }),
      });
    });

    test("root volume is 10 GiB gp3, encrypted, delete-on-terminate", () => {
      // `blockDevices` on ec2.Instance render on the Instance resource;
      // the LaunchTemplate exists only to carry IMDSv2 MetadataOptions.
      const t = Template.fromStack(makeStack());
      t.hasResourceProperties("AWS::EC2::Instance", {
        BlockDeviceMappings: Match.arrayWith([
          Match.objectLike({
            DeviceName: "/dev/sda1",
            Ebs: Match.objectLike({
              VolumeSize: 10,
              VolumeType: "gp3",
              Encrypted: true,
              DeleteOnTermination: true,
            }),
          }),
        ]),
      });
    });
  });

  describe("EBS data volume", () => {
    test("one EBS volume per AZ", () => {
      const t = Template.fromStack(makeStack());
      // 1 data volume (per AZ); root volume rolls into LaunchTemplate
      // BlockDeviceMappings, so AWS::EC2::Volume count is just the
      // separate data volumes.
      t.resourceCountIs("AWS::EC2::Volume", 1);
    });

    test("EBS is gp3, 20 GiB, encrypted, AZ-pinned", () => {
      const t = Template.fromStack(makeStack());
      t.hasResourceProperties("AWS::EC2::Volume", {
        VolumeType: "gp3",
        Size: CONFIG["us-west-2"].ebsSizeGiB,
        Encrypted: true,
        AvailabilityZone: CONFIG["us-west-2"].availabilityZones[0],
      });
    });

    test("EBS has Name tag = brandedName('EBS-0')", () => {
      const t = Template.fromStack(makeStack());
      t.hasResourceProperties("AWS::EC2::Volume", {
        Tags: Match.arrayWith([
          Match.objectLike({ Key: "Name", Value: brandedName("EBS-0") }),
        ]),
      });
    });

    test("EBS volume has RETAIN deletion policy (data is precious)", () => {
      const t = Template.fromStack(makeStack());
      const volumes = t.findResources("AWS::EC2::Volume");
      for (const vol of Object.values(volumes)) {
        expect(vol.DeletionPolicy).toBe("Retain");
        expect(vol.UpdateReplacePolicy).toBe("Retain");
      }
    });

    test("EBS is attached to the EC2 at /dev/sdf", () => {
      const t = Template.fromStack(makeStack());
      t.resourceCountIs("AWS::EC2::VolumeAttachment", 1);
      t.hasResourceProperties("AWS::EC2::VolumeAttachment", {
        Device: "/dev/sdf",
      });
    });
  });

  describe("EIP association", () => {
    test("EIP is associated with the primary instance (index 0)", () => {
      const t = Template.fromStack(makeStack());
      t.resourceCountIs("AWS::EC2::EIPAssociation", 1);
    });
  });

  describe("IAM role", () => {
    test("role has AmazonSSMManagedInstanceCore (Session Manager access)", () => {
      const t = Template.fromStack(makeStack());
      t.hasResourceProperties("AWS::IAM::Role", {
        ManagedPolicyArns: Match.arrayWith([
          Match.objectLike({
            "Fn::Join": Match.arrayWith([
              Match.arrayWith([Match.stringLikeRegexp("AmazonSSMManagedInstanceCore")]),
            ]),
          }),
        ]),
      });
    });

    test("role has CloudWatchAgentServerPolicy (log/metric write)", () => {
      const t = Template.fromStack(makeStack());
      t.hasResourceProperties("AWS::IAM::Role", {
        ManagedPolicyArns: Match.arrayWith([
          Match.objectLike({
            "Fn::Join": Match.arrayWith([
              Match.arrayWith([Match.stringLikeRegexp("CloudWatchAgentServerPolicy")]),
            ]),
          }),
        ]),
      });
    });

    test("role name = brandedName('EC2-Role')", () => {
      const t = Template.fromStack(makeStack());
      t.hasResourceProperties("AWS::IAM::Role", {
        RoleName: brandedName("EC2-Role"),
      });
    });

    test("exactly one instance profile (CDK-created; no orphan duplicate)", () => {
      // Passing `role:` to ec2.Instance makes CDK create the instance
      // profile. A second, hand-rolled CfnInstanceProfile would be an
      // orphaned IAM resource attached to nothing.
      const t = Template.fromStack(makeStack());
      t.resourceCountIs("AWS::IAM::InstanceProfile", 1);
    });
  });

  describe("User-data", () => {
    function userDataAsString(t: Template): string {
      // CDK encodes user-data as a base64 Fn::Base64 wrapped Fn::Join
      // inside the LaunchTemplate. Easier: stringify the whole template
      // and grep for known strings.
      return JSON.stringify(t.toJSON());
    }

    test("installs Docker from Docker's apt repo (not Ubuntu's older fork)", () => {
      const t = Template.fromStack(makeStack());
      expect(userDataAsString(t)).toContain("download.docker.com");
    });

    test("creates braintwin user with UID 10001 matching the container", () => {
      const t = Template.fromStack(makeStack());
      const s = userDataAsString(t);
      expect(s).toContain("useradd");
      expect(s).toContain("10001");
    });

    test("braintwin user is NOT in the docker group (socket = root-equivalent)", () => {
      const t = Template.fromStack(makeStack());
      expect(userDataAsString(t)).not.toContain("usermod -aG docker");
    });

    test("EBS size in user-data comes from config (no hardcoded drift)", () => {
      // If this were hardcoded, bumping config.ebsSizeGiB would make
      // the boot-time lsblk size-match fail and abort first boot.
      const t = Template.fromStack(makeStack());
      expect(userDataAsString(t)).toContain(
        `EBS_SIZE_GIB=${CONFIG["us-west-2"].ebsSizeGiB}`,
      );
    });

    test("mounts the EBS volume at /var/lib/braintwin/data", () => {
      const t = Template.fromStack(makeStack());
      expect(userDataAsString(t)).toContain("/var/lib/braintwin/data");
    });

    test("does NOT reformat an existing filesystem", () => {
      // The script wraps mkfs.ext4 in `if ! blkid …; then`. If someone
      // removes that guard, the data volume could get nuked on a re-
      // attach. Grep for the guard string explicitly.
      const t = Template.fromStack(makeStack());
      expect(userDataAsString(t)).toContain("blkid");
    });

    test("chowns the mount to UID 10001 (matches container user)", () => {
      const t = Template.fromStack(makeStack());
      expect(userDataAsString(t)).toContain("chown -R 10001:10001");
    });

    test("creates /etc/caddy/ for the M.3 Caddyfile + AOP cert", () => {
      const t = Template.fromStack(makeStack());
      expect(userDataAsString(t)).toContain("/etc/caddy");
    });
  });

  describe("M.3.a — app bring-up in user-data", () => {
    function userDataAsString(t: Template): string {
      return JSON.stringify(t.toJSON());
    }

    test("fetches each of the four SSM secret parameters with decryption", () => {
      const t = Template.fromStack(makeStack());
      const s = userDataAsString(t);
      // The fetch uses `--with-decryption` on each parameter — without
      // it the SecureString would come back base64'd ciphertext.
      expect(s).toContain("--with-decryption");
      expect(s).toContain("/braintwin/anthropic_key");
      expect(s).toContain("/braintwin/bearer_token");
      expect(s).toContain("/braintwin/telegram_token");
      expect(s).toContain("/braintwin/cloudflare_api_token");
    });

    test("writes secrets.env with mode 0600 and umask 077", () => {
      // Defence in depth: umask 077 means the heredoc-written file is
      // 0600 by default; the explicit chmod is belt-and-suspenders. If
      // someone removes both, the secrets become world-readable.
      const t = Template.fromStack(makeStack());
      const s = userDataAsString(t);
      expect(s).toContain("umask 077");
      expect(s).toContain("chmod 600 /etc/braintwin/secrets.env");
    });

    test("ECR-logs-in before docker pull", () => {
      const t = Template.fromStack(makeStack());
      const s = userDataAsString(t);
      // The `aws ecr get-login-password | docker login` pattern.
      // Without this, `docker pull` against a private ECR fails with
      // "no basic auth credentials."
      expect(s).toContain("aws ecr get-login-password");
      expect(s).toContain("docker login");
      expect(s).toContain("--password-stdin");
    });

    test("docker-compose.yml templates the configured imageTag", () => {
      // The whole point of M.3 imageTag plumbing — verify it lands in
      // user-data. The JSON-stringified template escapes inner quotes
      // (IMAGE_TAG="test-tag" becomes IMAGE_TAG=\"test-tag\"), so
      // match the two pieces separately rather than the quoted whole.
      const t = Template.fromStack(makeStack());
      const s = userDataAsString(t);
      expect(s).toContain("IMAGE_TAG=");
      expect(s).toContain("test-tag");
    });

    test("docker-compose.yml references the ECR repo path", () => {
      const t = Template.fromStack(makeStack());
      const s = userDataAsString(t);
      // ECR_REPO is assigned from a CDK token (the repo's repositoryName);
      // we can't grep for the literal value, but we can confirm the
      // assignment is in there and the heredoc image line uses it.
      expect(s).toContain('ECR_REPO=');
      expect(s).toContain("$REGISTRY/$ECR_REPO:$IMAGE_TAG");
    });

    test("compose binds app on 127.0.0.1:8000 (loopback only — Caddy is M.4)", () => {
      // Public exposure on :443 lands in M.4 with Caddy. Until then,
      // smoke-test traffic comes via SSM Session Manager hitting
      // localhost. A literal "0.0.0.0:8000:8000" on the host would
      // open the app to anything that can reach the EC2 — a regression
      // that the Cloudflare-only SG would mostly catch, but defense in
      // depth.
      const t = Template.fromStack(makeStack());
      expect(userDataAsString(t)).toContain("127.0.0.1:8000:8000");
    });

    test("both services use the awslogs driver pointing at the right log groups", () => {
      const t = Template.fromStack(makeStack());
      const s = userDataAsString(t);
      // Driver pinned to awslogs (not the default json-file which
      // would fill the EBS); each service streams to its own group.
      expect(s).toContain("driver: awslogs");
      expect(s).toContain("APP_LOG_GROUP=");
      expect(s).toContain("BOT_LOG_GROUP=");
      // The CDK encodes the log group names as tokens, but the bash
      // var assignment + the heredoc reference should both be present.
      expect(s).toContain("awslogs-group: $APP_LOG_GROUP");
      expect(s).toContain("awslogs-group: $BOT_LOG_GROUP");
    });

    test("bot waits for app to be healthy before starting (depends_on)", () => {
      // Otherwise the bot's first POST to http://app:8000/capture races
      // the app's uvicorn startup and burns a retry budget on cold boot.
      const t = Template.fromStack(makeStack());
      expect(userDataAsString(t)).toContain("condition: service_healthy");
    });

    test("ends with `docker compose pull` then `docker compose up -d`", () => {
      const t = Template.fromStack(makeStack());
      const s = userDataAsString(t);
      expect(s).toContain("docker compose pull");
      expect(s).toContain("docker compose up -d");
    });

    test("hardens both containers: no-new-privileges + cap_drop ALL", () => {
      // Same hardening as the local docker-compose.yml in BrainTwin.
      // If anyone drops this from the cloud-side template the
      // hardening silently regresses.
      const t = Template.fromStack(makeStack());
      const s = userDataAsString(t);
      expect(s).toContain("no-new-privileges:true");
      expect(s).toContain("cap_drop:");
    });

    test("instance role gets ECR pull, SSM read, S3 RW, and CW log write", () => {
      // The four grants set up in braintwin-stack.ts AFTER compute is
      // constructed. Without these, the user-data's aws-cli calls
      // would all 403 at boot and the EC2 would never start the app.
      const t = Template.fromStack(makeStack());
      const policies = t.findResources("AWS::IAM::Policy");
      const concat = Object.values(policies)
        .map((p) => JSON.stringify(p.Properties.PolicyDocument))
        .join("\n");
      expect(concat).toContain("ecr:BatchGetImage");
      expect(concat).toContain("ssm:GetParameter");
      expect(concat).toContain("s3:PutObject");
      expect(concat).toContain("logs:PutLogEvents");
    });
  });

  describe("M.4.b — Caddy TLS edge in user-data", () => {
    function userDataAsString(t: Template): string {
      return JSON.stringify(t.toJSON());
    }

    test("downloads the Cloudflare Origin Pull CA cert at boot (for AOP)", () => {
      // Without the CA cert pre-loaded, Caddy's client_auth block
      // can't validate Cloudflare's per-zone client cert. The cert
      // URL is Cloudflare's public well-known location.
      const t = Template.fromStack(makeStack());
      expect(userDataAsString(t)).toContain(
        "developers.cloudflare.com/ssl/static/authenticated_origin_pull_ca.pem",
      );
    });

    test("persists Caddy data + config on EBS (no cert re-issue on restart)", () => {
      // /var/lib/braintwin/data/caddy/{data,config} must exist before
      // the container starts so Caddy's ACME state survives container
      // restarts AND instance replacements. Without persistence,
      // every restart re-issues certs and quickly hits the Let's
      // Encrypt rate limit.
      const t = Template.fromStack(makeStack());
      const s = userDataAsString(t);
      expect(s).toContain("/var/lib/braintwin/data/caddy/data");
      expect(s).toContain("/var/lib/braintwin/data/caddy/config");
    });

    test("docker-compose includes the caddy service with both image tags", () => {
      const t = Template.fromStack(makeStack());
      const s = userDataAsString(t);
      expect(s).toContain("CADDY_IMAGE_TAG=");
      expect(s).toContain("test-caddy-tag");
      // The compose image: line references $CADDY_REPO and $CADDY_IMAGE_TAG.
      expect(s).toContain("$REGISTRY/$CADDY_REPO:$CADDY_IMAGE_TAG");
      expect(s).toContain("braintwin-caddy");
    });

    test("caddy binds host :80 AND :443 (public TLS edge)", () => {
      const t = Template.fromStack(makeStack());
      const s = userDataAsString(t);
      // Both must be present - :443 for production TLS, :80 for the
      // ACME HTTP fallback + Caddy's automatic-HTTPS redirect. The
      // JSON-stringified template escapes literal quotes, so match
      // the unquoted forms (which still uniquely identify these
      // strings - "443:443" appears nowhere else in CDK output).
      expect(s).toContain("443:443");
      expect(s).toContain("80:80");
    });

    test("caddy has cap_add NET_BIND_SERVICE (drops everything else)", () => {
      // Privileged ports + non-root container = the one cap we must
      // keep. Removing this without doing something else (root in
      // container, or different ports) means Caddy can't open 80/443.
      const t = Template.fromStack(makeStack());
      expect(userDataAsString(t)).toContain("NET_BIND_SERVICE");
    });

    test("Caddyfile reverse-proxies to app:8000 over the Docker network", () => {
      // Caddy reaches the app container by service name on the
      // compose-internal bridge, NOT via 127.0.0.1 on the host. This
      // is the whole point of running them in the same compose.
      const t = Template.fromStack(makeStack());
      expect(userDataAsString(t)).toContain("reverse_proxy app:8000");
    });

    test("Caddyfile site block targets the configured publicHostname", () => {
      // publicHostname comes from stack-config.ts (api.braintwin.net
      // for both regions today). If anyone changes it without
      // updating Cloudflare DNS the cert would still issue (DNS-01
      // uses the API token) but no traffic would route here.
      const t = Template.fromStack(makeStack());
      expect(userDataAsString(t)).toContain("api.braintwin.net");
    });

    test("Caddyfile uses ACME DNS-01 via Cloudflare (not HTTP-01)", () => {
      // DNS-01 sidesteps the Cloudflare-proxy-vs-HTTP-01 cache trap.
      // The acme_dns directive + the cloudflare provider is what
      // makes Caddy's xcaddy-compiled plugin actually used.
      const t = Template.fromStack(makeStack());
      const s = userDataAsString(t);
      expect(s).toContain("acme_dns cloudflare");
      expect(s).toContain("{env.CLOUDFLARE_API_TOKEN}");
    });

    test("Caddyfile enforces Authenticated Origin Pulls (client cert required)", () => {
      // The SG already restricts source IPs to Cloudflare egress,
      // but AOP is the cryptographic proof - someone running a
      // server inside Cloudflare's network can't impersonate our
      // zone's origin without the per-zone client cert. Both the
      // mode AND the trust pool path must be present.
      const t = Template.fromStack(makeStack());
      const s = userDataAsString(t);
      expect(s).toContain("require_and_verify");
      expect(s).toContain("/etc/caddy/cloudflare-origin-ca.pem");
    });

    test("HSTS header is set (compensates for .net not having HSTS preload)", () => {
      // braintwin.net is a .net domain. Unlike .app / .dev which
      // ship in the browser HSTS-preload list, .net relies on the
      // header to force HTTPS for clients that haven't seen it yet.
      const t = Template.fromStack(makeStack());
      expect(userDataAsString(t)).toContain("Strict-Transport-Security");
    });

    test("caddy logs ship to the /braintwin/caddy CloudWatch group", () => {
      // Separate group from app/bot so the "what did Caddy do?" tail
      // doesn't drown in app request logs.
      const t = Template.fromStack(makeStack());
      const s = userDataAsString(t);
      expect(s).toContain("CADDY_LOG_GROUP=");
      expect(s).toContain("awslogs-group: $CADDY_LOG_GROUP");
    });

    test("caddy depends on the app being healthy before starting", () => {
      // Caddy's reverse-proxy to a non-existent backend would error
      // and burn restart attempts. depends_on with healthcheck
      // condition makes the cold-boot ordering deterministic.
      const t = Template.fromStack(makeStack());
      const s = userDataAsString(t);
      // Two depends_on blocks exist after M.4.b: bot->app, caddy->app.
      // We can't easily count from the stringified template; assert
      // both braintwin-bot AND braintwin-caddy appear AFTER an app
      // service_healthy reference.
      const count = (s.match(/condition: service_healthy/g) || []).length;
      expect(count).toBeGreaterThanOrEqual(2);
    });
  });

  describe("CloudFormation outputs", () => {
    test("primary instance ID is output (for `aws ssm start-session`)", () => {
      const t = Template.fromStack(makeStack());
      const outputs = t.findOutputs("*");
      const found = Object.entries(outputs).find(([key]) =>
        key.toLowerCase().includes("primaryinstance"),
      );
      expect(found).toBeDefined();
    });

    test("primary EBS volume ID is output", () => {
      const t = Template.fromStack(makeStack());
      const outputs = t.findOutputs("*");
      const found = Object.entries(outputs).find(([key]) =>
        key.toLowerCase().includes("primaryebs"),
      );
      expect(found).toBeDefined();
    });
  });
});

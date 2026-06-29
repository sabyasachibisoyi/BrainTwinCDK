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

    test("IMDS hop limit is 2 (so Docker containers can reach the metadata svc)", () => {
      // CDK's `requireImdsv2: true` shortcut defaults the hop limit to 1.
      // A hop limit of 1 means in-container processes (one extra hop via
      // docker0) get NoCredentialProviders when the AWS SDK falls back
      // to IMDS - which is exactly how Litestream errors at M.5. We use
      // a CDK Aspect to bump this to 2; if anyone reverts that, the
      // next deploy ships with Litestream broken at boot.
      const t = Template.fromStack(makeStack());
      t.hasResourceProperties("AWS::EC2::LaunchTemplate", {
        LaunchTemplateData: Match.objectLike({
          MetadataOptions: Match.objectLike({
            HttpPutResponseHopLimit: 2,
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

    // Just the EC2 user-data (not the whole template), so we can assert a
    // value is ABSENT from the boot script even when it legitimately
    // appears elsewhere in the template — e.g. as an SSM parameter value.
    function userDataOnly(t: Template): string {
      const instances = t.findResources("AWS::EC2::Instance");
      return Object.values(instances)
        .map((r) => JSON.stringify(r.Properties.UserData))
        .join("\n");
    }

    test("discovers secrets via get-parameters-by-path under /braintwin/ (M.10)", () => {
      // M.10 replaced 5 hardcoded `get-parameter` calls with a single
      // `get-parameters-by-path /braintwin/ --recursive --with-decryption`.
      // The refresh script then loops over discovered params, applies
      // a small alias table for the 3 env var renames, and writes
      // secrets.env. If anyone reverts this back to hardcoded
      // get-parameter calls, adding a new secret regresses to "needs
      // CDK edit + EBS-deadlock dance" again.
      const t = Template.fromStack(makeStack());
      const s = userDataAsString(t);
      // Discovery is in place
      expect(s).toContain("get-parameters-by-path");
      expect(s).toContain("--path /braintwin/");
      expect(s).toContain("--recursive");
      // Still using decryption (SecureStrings)
      expect(s).toContain("--with-decryption");
      // Parsing goes through `jq -r @tsv`, not the CLI's `--output
      // text` (newline-separated rows would corrupt a secret value that
      // itself contains a newline). The json+jq pair is the guard; we
      // can't assert absence of "--output text" globally because the
      // image_tag/account-id get-parameter calls legitimately use it.
      expect(s).toContain("--output json");
      expect(s).toContain("jq -r '.[] | @tsv'");
      // The image_tag + caddy_image_tag params must be skipped — they
      // live under /braintwin/ but are NOT secrets, and would leak
      // into secrets.env if the filter were dropped.
      expect(s).toContain("image_tag|caddy_image_tag");
      // The 3 alias renames must be present (basename uppercased
      // doesn't match the app-side env var name for these three).
      expect(s).toContain("ANTHROPIC_KEY)");
      expect(s).toContain("ANTHROPIC_API_KEY");
      expect(s).toContain("BEARER_TOKEN)");
      expect(s).toContain("BACKEND_BEARER_TOKEN");
      expect(s).toContain("TELEGRAM_TOKEN)");
      expect(s).toContain("TELEGRAM_BOT_TOKEN");
    });

    test("refresh script fails loud if a required env var is missing from SSM (M.10 defensive check)", () => {
      // The defensive grep loop after the discovery: if put-secrets.sh
      // wasn't run on a fresh account or a rotation typo'd a name,
      // secrets.env would be missing one of the 5 expected app-side
      // env vars and downstream containers would crash on missing env
      // with a much less actionable error. The defensive check fails
      // boot with a clear "Did you run scripts/put-secrets.sh?" message.
      const t = Template.fromStack(makeStack());
      const s = userDataAsString(t);
      expect(s).toContain("ANTHROPIC_API_KEY BACKEND_BEARER_TOKEN TELEGRAM_BOT_TOKEN CLOUDFLARE_API_TOKEN ALLOWED_TELEGRAM_USER_IDS");
      expect(s).toContain("FATAL");
      expect(s).toContain("put-secrets.sh");
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

    test("publishes imageTag to SSM and does NOT bake it into user-data", () => {
      // Option A: the tag lives in an SSM parameter and is read at runtime
      // by the refresh script. That decoupling is what stops an image bump
      // from rewriting user-data (which would replace the instance and
      // deadlock on the single RETAIN EBS volume).
      const t = Template.fromStack(makeStack());
      t.hasResourceProperties("AWS::SSM::Parameter", {
        Name: "/braintwin/image_tag",
        Type: "String",
        Value: "test-tag",
      });
      // user-data reads the parameter by NAME at runtime; the literal tag
      // value must NOT appear in the boot script.
      const ud = userDataOnly(t);
      expect(ud).toContain("/braintwin/image_tag");
      expect(ud).toContain("aws ssm get-parameter");
      expect(ud).not.toContain("test-tag");
    });

    test("writes a reusable refresh script that deploy.sh re-runs over SSM", () => {
      // The script is the mechanism that makes image bumps in-place:
      // deploy.sh sends `braintwin-refresh.sh` via SSM RunCommand instead
      // of replacing the box.
      const ud = userDataOnly(Template.fromStack(makeStack()));
      expect(ud).toContain("/usr/local/bin/braintwin-refresh.sh");
      expect(ud).toContain("docker compose pull");
      expect(ud).toContain("docker compose up -d");
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

    test("bot has a /proc-cmdline healthcheck (not the inherited uvicorn HTTP probe)", () => {
      // 4.0.6.1 M.0 — the bot service inherits the app Dockerfile's
      // HEALTHCHECK against http://localhost:8000/health, which the
      // bot never serves. Override with a process check so
      // `docker compose ps` stops reporting "Up (unhealthy)" forever.
      //
      // We grep against /proc/*/cmdline rather than pgrep because the
      // python:slim base image doesn't include procps. /proc is
      // kernel-provided, always present on Linux. If anyone reverts
      // this back to pgrep without also adding procps to the image,
      // the bot goes back to perpetually-unhealthy.
      //
      // The pattern MUST be bracketed ([b]ackend) so the probe can't
      // match the shell running it (whose own cmdline contains the
      // pattern string) and report healthy when the bot is dead. The
      // unbracketed `backend.telegram_bot` is the false-positive bug.
      const t = Template.fromStack(makeStack());
      const s = userDataAsString(t);
      expect(s).toContain("/proc/*/cmdline");
      expect(s).toContain("[b]ackend.telegram_bot");
      // Guard the self-matching unbracketed form from regressing in.
      expect(s).not.toContain("grep -l backend.telegram_bot");
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

    function userDataOnly(t: Template): string {
      const instances = t.findResources("AWS::EC2::Instance");
      return Object.values(instances)
        .map((r) => JSON.stringify(r.Properties.UserData))
        .join("\n");
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

    test("docker-compose includes the caddy service; caddy tag lives in SSM", () => {
      const t = Template.fromStack(makeStack());
      t.hasResourceProperties("AWS::SSM::Parameter", {
        Name: "/braintwin/caddy_image_tag",
        Type: "String",
        Value: "test-caddy-tag",
      });
      const s = userDataAsString(t);
      expect(s).toContain("CADDY_IMAGE_TAG=");
      // The compose image: line references $CADDY_REPO and $CADDY_IMAGE_TAG.
      expect(s).toContain("$REGISTRY/$CADDY_REPO:$CADDY_IMAGE_TAG");
      expect(s).toContain("braintwin-caddy");
      // Tag value is not baked into the boot script.
      expect(userDataOnly(t)).not.toContain("test-caddy-tag");
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

  describe("M.5 — backups + system metrics in user-data", () => {
    function userDataAsString(t: Template): string {
      return JSON.stringify(t.toJSON());
    }

    test("Litestream service is in the docker-compose template", () => {
      const t = Template.fromStack(makeStack());
      const s = userDataAsString(t);
      expect(s).toContain("litestream/litestream:");
      expect(s).toContain("braintwin-litestream");
    });

    test("Litestream runs as UID 10001 (matches DB file owner; avoids cap_drop DAC trap)", () => {
      // The Litestream image runs as root by default. With our
      // `cap_drop: ALL` hardening, root inside the container loses
      // CAP_DAC_OVERRIDE and can no longer write to files owned by
      // UID 10001 (which the app container produces). SQLite reports
      // that as "attempt to write a readonly database" - a confusing
      // error for what is really a permissions issue. Pinning the
      // Litestream service to UID 10001 dodges the whole capability
      // dance. See design doc §14.
      const t = Template.fromStack(makeStack());
      // JSON.stringify escapes the inner double quotes, so we search
      // for the unescaped form.
      expect(userDataAsString(t)).toContain('user: \\"10001:10001\\"');
    });

    test("litestream.yml points at the project's S3 state bucket + litestream/ prefix", () => {
      const t = Template.fromStack(makeStack());
      const s = userDataAsString(t);
      // The bucket name is templated at runtime using $ACCOUNT_ID/$REGION
      // resolved by IMDS in the refresh script.
      expect(s).toContain("bucket: braintwin-state-$ACCOUNT_ID-$REGION");
      expect(s).toContain("path: litestream/braintwin.db");
    });

    test("Litestream retention matches the S3 lifecycle rule (7d / 168h)", () => {
      // If anyone bumps retention up here, they need to bump the s3
      // lifecycle rule on litestream/ in storage.ts to match.
      const t = Template.fromStack(makeStack());
      expect(userDataAsString(t)).toContain("retention: 168h");
    });

    test("CloudWatch Agent is installed + started", () => {
      const t = Template.fromStack(makeStack());
      const s = userDataAsString(t);
      expect(s).toContain("amazon-cloudwatch-agent.deb");
      expect(s).toContain("amazon-cloudwatch-agent-ctl");
      // Config landed in the right place
      expect(s).toContain("/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json");
    });

    test("CW Agent collects CPU + memory + disk + diskio + netstat + swap", () => {
      // M.12 — the JSON config moved out of user-data into an s3.Asset.
      // The test now asserts against the source-of-truth file rather
      // than the synthesized user-data string. Any regression here
      // means the metric set actually shipping differs from intent.
      const fs = require("fs");
      const path = require("path");
      const cfg = fs.readFileSync(
        path.join(__dirname, "..", "..", "assets", "amazon-cloudwatch-agent.json"),
        "utf8",
      );
      expect(cfg).toContain("cpu_usage_idle");
      expect(cfg).toContain("mem_used_percent");
      expect(cfg).toContain("used_percent");
      expect(cfg).toContain("io_time");
      expect(cfg).toContain("tcp_established");
      expect(cfg).toContain("swap_used_percent");
    });

    test("CW Agent metrics land in the BrainTwin/System namespace", () => {
      // M.12 — assert against the asset file, same reason as above.
      const fs = require("fs");
      const path = require("path");
      const cfg = fs.readFileSync(
        path.join(__dirname, "..", "..", "assets", "amazon-cloudwatch-agent.json"),
        "utf8",
      );
      expect(cfg).toContain("BrainTwin/System");
    });

    test("Chroma backup script + systemd timer are installed", () => {
      const t = Template.fromStack(makeStack());
      const s = userDataAsString(t);
      expect(s).toContain("/usr/local/bin/braintwin-chroma-backup.sh");
      expect(s).toContain("/etc/systemd/system/braintwin-chroma-backup.timer");
      expect(s).toContain("systemctl enable --now braintwin-chroma-backup.timer");
    });

    test("Chroma timer fires at 03:30 UTC (30min after DLM snapshots at 03:00)", () => {
      // M.12 — timer file is now an s3.Asset, assert against source.
      // Stacking the snapshot + the tarball on the same minute would
      // double the disk-io burst. 30 minutes of breathing room is plenty.
      const fs = require("fs");
      const path = require("path");
      const timer = fs.readFileSync(
        path.join(__dirname, "..", "..", "assets", "braintwin-chroma-backup.timer"),
        "utf8",
      );
      expect(timer).toContain("OnCalendar=*-*-* 03:30:00");
    });

    test("Chroma tarball uploads to s3://...-state-...-region/chroma-nightly/", () => {
      // M.12 — backup script is now an s3.Asset. Assert the script body
      // resolves the bucket name from IMDS at runtime and writes to the
      // chroma-nightly/ prefix.
      const fs = require("fs");
      const path = require("path");
      const script = fs.readFileSync(
        path.join(__dirname, "..", "..", "assets", "braintwin-chroma-backup.sh"),
        "utf8",
      );
      expect(script).toContain("braintwin-state-");
      expect(script).toContain("chroma-nightly/");
      expect(script).toContain("169.254.169.254"); // IMDS for account/region
    });

    test("M.12: heavy config files are served from s3.Asset, not inlined", () => {
      // Regression guard for M.12. If anyone reverts the s3.Asset
      // refactor by re-embedding these files in user-data, the
      // user-data will blow past the 16 KB limit again.
      //
      // We can't easily match `s3cp_retry s3://BUCKET/KEY DEST` as a
      // single regex because the JSON-stringified template breaks the
      // s3:// URL across CDK Ref fragments. Instead, count the download
      // commands and assert each destination path is present. Downloads
      // go through the s3cp_retry helper (backoff wrapper) rather than a
      // bare `aws s3 cp`.
      const t = Template.fromStack(makeStack());
      const s = userDataAsString(t);
      // Expect at least 4 `s3cp_retry s3://` occurrences (one per asset).
      // The substring is stable even though the bucket/key are tokens.
      const cpCount = (s.match(/s3cp_retry s3:/g) || []).length;
      expect(cpCount).toBeGreaterThanOrEqual(4);
      // The retry helper itself must be defined before any use.
      expect(s).toContain("s3cp_retry() {");
      // Each target path must appear.
      expect(s).toContain("/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json");
      expect(s).toContain("/usr/local/bin/braintwin-chroma-backup.sh");
      expect(s).toContain("/etc/systemd/system/braintwin-chroma-backup.service");
      expect(s).toContain("/etc/systemd/system/braintwin-chroma-backup.timer");
      // And the JSON config must NOT be inlined any more — the canary
      // strings from the old inline content (the JSON namespace literal
      // and the chroma backup shebang) should be absent.
      expect(s).not.toContain("metrics_collection_interval");
      expect(s).not.toContain("CB_EOF");
    });

    test("M.12: instance role can read assets from the CDK bootstrap bucket", () => {
      // The Asset.grantRead() calls produce an IAM policy that gives
      // the instance role s3:GetObject on the bootstrap bucket's
      // cdk-hnb659fds-assets-... bucket. Without this, every asset
      // cp in user-data 403s at boot and the instance never starts.
      const t = Template.fromStack(makeStack());
      const policies = t.findResources("AWS::IAM::Policy");
      const concat = Object.values(policies)
        .map((p) => JSON.stringify(p.Properties.PolicyDocument))
        .join("\n");
      // CDK references the bootstrap bucket by its synthesized name
      // (which contains "cdk-hnb659fds-assets-" - the default qualifier
      // for the bootstrap stack).
      expect(concat).toContain("cdk-hnb659fds-assets-");
      expect(concat).toContain("s3:GetObject");
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

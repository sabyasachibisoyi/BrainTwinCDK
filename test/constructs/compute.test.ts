/**
 * ComputeConstruct unit tests — Phase 4.0.6 M.2.e.
 *
 * Validates the shape: per-AZ EC2+EBS, RETAIN policy on the data
 * volume, EIP association on the primary, IAM role with the right
 * managed policies, user-data that actually does the EBS mount and
 * UID 10001 ownership.
 *
 * If any of these assertions break, the next deploy could either
 * (a) be unreachable from Cloudflare, (b) silently lose the corpus
 * on a destroy, or (c) drop SSM access — all of which are real
 * regressions the PR review should catch BEFORE merge.
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

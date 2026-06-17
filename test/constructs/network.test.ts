/**
 * NetworkConstruct unit tests — Phase 4.0.6 M.2.d.
 *
 * Asserts the CloudFormation template contains exactly what we
 * promised: custom VPC (no NAT), Security Group with Cloudflare-only
 * ingress, Elastic IP. The point is to catch accidental over-
 * exposure — if someone "helpfully" adds an inbound :22 rule or
 * deletes a Cloudflare CIDR, this test fails before the PR merges.
 */
import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { BrainTwinStack } from "../../lib/braintwin-stack";
import { CLOUDFLARE_IPV4_RANGES } from "../../lib/cloudflare-ips";
import { brandedName, getConfig } from "../../lib/stack-config";

function makeStack(): cdk.Stack {
  const app = new cdk.App();
  return new BrainTwinStack(app, "TestStack-us-west-2", {
    env: { account: "123456789012", region: "us-west-2" },
    config: getConfig("us-west-2"),
    imageTag: "test-tag",
    caddyImageTag: "test-caddy-tag",
  });
}

describe("NetworkConstruct", () => {
  describe("VPC", () => {
    test("creates exactly one VPC", () => {
      const t = Template.fromStack(makeStack());
      t.resourceCountIs("AWS::EC2::VPC", 1);
    });

    test("VPC uses the 10.10.0.0/16 CIDR (not the default-VPC 172.31)", () => {
      const t = Template.fromStack(makeStack());
      t.hasResourceProperties("AWS::EC2::VPC", {
        CidrBlock: "10.10.0.0/16",
      });
    });

    test("VPC has Name tag = brandedName('Vpc')", () => {
      const t = Template.fromStack(makeStack());
      t.hasResourceProperties("AWS::EC2::VPC", {
        Tags: Match.arrayWith([
          Match.objectLike({ Key: "Name", Value: brandedName("Vpc") }),
        ]),
      });
    });

    test("NO NAT gateways — the cost-killer is absent", () => {
      const t = Template.fromStack(makeStack());
      t.resourceCountIs("AWS::EC2::NatGateway", 0);
    });

    test("one public subnet per AZ in config (single AZ for v1)", () => {
      const t = Template.fromStack(makeStack());
      // us-west-2 config has one AZ → one public subnet
      t.resourceCountIs("AWS::EC2::Subnet", 1);
    });

    test("subnet is pinned to the AZ named in config, not CDK's pick", () => {
      const t = Template.fromStack(makeStack());
      t.hasResourceProperties("AWS::EC2::Subnet", {
        AvailabilityZone: getConfig("us-west-2").availabilityZones[0],
      });
    });

    test("Internet Gateway is attached (no IGW = air-gapped VPC)", () => {
      const t = Template.fromStack(makeStack());
      t.resourceCountIs("AWS::EC2::InternetGateway", 1);
      t.resourceCountIs("AWS::EC2::VPCGatewayAttachment", 1);
    });
  });

  describe("Security Group", () => {
    test("Security Group has explicit GroupName = brandedName('SG')", () => {
      const t = Template.fromStack(makeStack());
      // GroupName makes the resource discoverable in the console by name,
      // not just by tag. CDK passes the value as the Name parameter on
      // the AWS::EC2::SecurityGroup resource.
      t.hasResourceProperties("AWS::EC2::SecurityGroup", {
        GroupName: brandedName("SG"),
      });
    });

    test("created with allowAllOutbound=true (egress is wide open)", () => {
      const t = Template.fromStack(makeStack());
      // The egress rule is implicit on a SecurityGroup with
      // allowAllOutbound. CDK renders it as a SecurityGroupEgress
      // with CidrIp: 0.0.0.0/0 on port -1 (all).
      t.hasResourceProperties("AWS::EC2::SecurityGroup", {
        SecurityGroupEgress: Match.arrayWith([
          Match.objectLike({ CidrIp: "0.0.0.0/0", IpProtocol: "-1" }),
        ]),
      });
    });

    test("ingress allows :443 from EVERY Cloudflare CIDR", () => {
      const t = Template.fromStack(makeStack());
      for (const cidr of CLOUDFLARE_IPV4_RANGES) {
        t.hasResourceProperties("AWS::EC2::SecurityGroup", {
          SecurityGroupIngress: Match.arrayWith([
            Match.objectLike({
              CidrIp: cidr,
              FromPort: 443,
              ToPort: 443,
              IpProtocol: "tcp",
            }),
          ]),
        });
      }
    });

    // A rule is checked as a RANGE (FromPort ≤ port ≤ ToPort), not by
    // exact match — otherwise a sloppy "tcp 0–1024" rule would expose
    // the port while sailing past an equality assertion. IpProtocol
    // "-1" (all traffic) has no FromPort/ToPort and covers every port.
    function ingressRulesCovering(t: Template, port: number) {
      const sgs = t.findResources("AWS::EC2::SecurityGroup");
      return Object.values(sgs).flatMap((sg) => {
        const ingress = (sg.Properties?.SecurityGroupIngress ?? []) as Array<{
          IpProtocol?: string;
          FromPort?: number;
          ToPort?: number;
        }>;
        return ingress.filter(
          (rule) =>
            rule.IpProtocol === "-1" ||
            (rule.FromPort !== undefined &&
              rule.ToPort !== undefined &&
              rule.FromPort <= port &&
              port <= rule.ToPort),
        );
      });
    }

    test("NO ingress rule covers :22 (SSH is disabled, SSM only)", () => {
      const t = Template.fromStack(makeStack());
      expect(ingressRulesCovering(t, 22)).toHaveLength(0);
    });

    test("NO ingress rule covers :80 (Cloudflare proxy handles HTTP→HTTPS)", () => {
      const t = Template.fromStack(makeStack());
      expect(ingressRulesCovering(t, 80)).toHaveLength(0);
    });
  });

  describe("Elastic IP", () => {
    test("exactly one EIP, allocated to the VPC", () => {
      const t = Template.fromStack(makeStack());
      t.resourceCountIs("AWS::EC2::EIP", 1);
      t.hasResourceProperties("AWS::EC2::EIP", {
        Domain: "vpc",
      });
    });

    test("EIP has Name tag = brandedName('EIP')", () => {
      const t = Template.fromStack(makeStack());
      t.hasResourceProperties("AWS::EC2::EIP", {
        Tags: Match.arrayWith([
          Match.objectLike({ Key: "Name", Value: brandedName("EIP") }),
        ]),
      });
    });

    test("EIP value is exported as CloudFormation output", () => {
      const t = Template.fromStack(makeStack());
      const outputs = t.findOutputs("*");
      const eipOutput = Object.entries(outputs).find(([key]) =>
        key.toLowerCase().includes("elasticip"),
      );
      expect(eipOutput).toBeDefined();
    });
  });
});

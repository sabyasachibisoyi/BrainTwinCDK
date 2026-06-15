/**
 * ObservabilityConstruct — CloudWatch logs + AWS Budgets + DLM snapshots.
 *
 * Phase 4.0.6 M.2.h. The final M.2 construct. Three independent
 * pieces, all about "knowing what's happening (or what it'll cost)
 * before it bites you":
 *
 *   1. **CloudWatch Log Groups** — one per docker-compose service
 *      (app, bot). M.3 user-data wires the Docker daemon's awslogs
 *      driver to send container stdout straight here. 30-day
 *      retention bounds the bill while leaving enough history to
 *      diagnose a "this started failing last Tuesday" report.
 *
 *   2. **AWS Budgets** — cost alarm at each threshold in
 *      `config.budgetThresholdsUSD` ($50, $100, $150, $180 by default).
 *      Email goes to `config.budgetAlertEmail` (sourced from the
 *      BRAINTWIN_ALERT_EMAIL env var so an operator's address never
 *      lands in git history). The alarms fire on FORECASTED monthly
 *      spend AND ACTUAL — early-warning + safety-net.
 *
 *   3. **DLM EBS snapshot policy** — daily snapshots of the data
 *      volume, 7-day retention. Independent of Litestream (covers
 *      Chroma + image dir + anything else on the volume) and
 *      independent of S3 lifecycle (covers a corruption that survived
 *      the daily Chroma tarball cadence).
 *
 * ## Why all three live in one construct
 *
 * They share a theme — "things that watch the stack so the operator
 * doesn't have to" — and they're all small. Splitting them into three
 * separate constructs would dilute the value with three more files
 * and one-line wirings. If observability grows substantially in Phase
 * 4.0.6.1 (CloudWatch dashboard, X-Ray traces, etc.), split then.
 *
 * ## What this construct does NOT do
 *
 * Deferred or out of scope:
 *
 *   - Application-level metrics (request count, latency histograms).
 *     M.3 wires the CloudWatch agent inside the EC2 to ship those.
 *   - Dashboards. Defer to Phase 4.0.6.1; for v1 you read CloudWatch
 *     Logs Insights queries and use the Budgets dashboard.
 *   - X-Ray / OpenTelemetry traces. Phase 4.0.5 (eval) introduces
 *     Langfuse self-hosted for LLM-call traces; for HTTP traces we'd
 *     add AWS X-Ray then.
 *   - UptimeRobot external probe. That's an external service (free
 *     tier covers /health every 5 min); operator sets it up post-deploy.
 */
import * as cdk from "aws-cdk-lib";
import * as budgets from "aws-cdk-lib/aws-budgets";
import * as dlm from "aws-cdk-lib/aws-dlm";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";
import { brandedName, brandedPath, RegionConfig } from "../stack-config";

export interface ObservabilityConstructProps {
  readonly config: RegionConfig;
}

export class ObservabilityConstruct extends Construct {
  /** CloudWatch log group the FastAPI app's stdout flows to. */
  public readonly appLogGroup: logs.LogGroup;

  /** CloudWatch log group the Telegram bot's stdout flows to. */
  public readonly botLogGroup: logs.LogGroup;

  /**
   * IAM role assumed by the Data Lifecycle Manager service to take
   * the EBS snapshots. Exposed for tests; the service consumes it
   * via the DLM lifecycle policy.
   */
  public readonly dlmRole: iam.Role;

  constructor(scope: Construct, id: string, props: ObservabilityConstructProps) {
    super(scope, id);

    // -----------------------------------------------------------------
    // 1) CloudWatch Log Groups — one per docker-compose service
    // -----------------------------------------------------------------
    // Capture the literal names: `logGroup.logGroupName` is a CFN token
    // ({ Ref: ... }), not the string we passed. We need the literal for
    // the CfnOutput below (so `cdk synth` shows /braintwin/app, not a
    // ref) and to keep the runbook tail-command in sync.
    const appLogGroupName = brandedPath("app");
    const botLogGroupName = brandedPath("bot");

    this.appLogGroup = new logs.LogGroup(this, "AppLogGroup", {
      logGroupName: appLogGroupName,
      // 30 days: enough to diagnose "this started failing last week"
      // without growing the bill indefinitely. Logs Insights queries
      // get pricey on TB-scale searches; bounded retention keeps
      // search costs predictable too.
      retention: logs.RetentionDays.ONE_MONTH,
      // RETAIN: if the stack is destroyed, the logs survive for
      // post-incident analysis. CloudWatch charges $0.03/GB/month for
      // storage; an orphan log group costs cents.
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.botLogGroup = new logs.LogGroup(this, "BotLogGroup", {
      logGroupName: botLogGroupName,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // -----------------------------------------------------------------
    // 2) AWS Budgets — cost alarm at every threshold from config
    // -----------------------------------------------------------------
    //
    // We create ONE budget for the whole project (filtered by Tag
    // Project=BrainTwin), with multiple notification thresholds.
    // Could be split into per-service budgets (compute, storage, etc.)
    // but for a single-app project that's noise without value.
    //
    // Each threshold gets TWO notifications:
    //   - FORECASTED >= threshold → "hey, you're going to overshoot"
    //   - ACTUAL >= threshold → "you actually hit it"
    // The forecast is the early-warning; the actual is the receipt.
    // BRAINTWIN_ALERT_EMAIL is injected from the environment (never
    // committed), so it can be "" during `cdk synth` / unit tests. AWS
    // Budgets requires a syntactically valid subscriber address — the
    // old "ALERT_EMAIL_UNSET" sentinel would hard-fail the CloudFormation
    // deploy with an opaque error. Fall back to a reserved `.invalid`
    // address (RFC 2606) so synth/tests pass, and raise a synth-time
    // warning so an operator deploying for real can't miss it.
    const configuredEmail = props.config.budgetAlertEmail;
    const email = configuredEmail || "braintwin-alerts-unset@example.invalid";
    if (!configuredEmail) {
      cdk.Annotations.of(this).addWarning(
        "BRAINTWIN_ALERT_EMAIL is not set - budget alerts will be sent to a " +
          "placeholder (@example.invalid) address that goes nowhere. Set the " +
          "env var and redeploy before relying on cost alerts.",
      );
    }
    const thresholds = props.config.budgetThresholdsUSD;
    const maxBudget = Math.max(...thresholds);

    const notifications: budgets.CfnBudget.NotificationWithSubscribersProperty[] =
      [];

    for (const threshold of thresholds) {
      // Percentage of the monthly budget that this threshold represents.
      // E.g. with maxBudget = $180 and threshold = $100 → 55.6%.
      const pct = Math.round((threshold / maxBudget) * 100);

      // FORECASTED — fires when AWS Cost Explorer predicts you'll spend this.
      notifications.push({
        notification: {
          notificationType: "FORECASTED",
          comparisonOperator: "GREATER_THAN",
          threshold: pct,
          thresholdType: "PERCENTAGE",
        },
        subscribers: [{ subscriptionType: "EMAIL", address: email }],
      });

      // ACTUAL — fires when you actually crossed it.
      notifications.push({
        notification: {
          notificationType: "ACTUAL",
          comparisonOperator: "GREATER_THAN",
          threshold: pct,
          thresholdType: "PERCENTAGE",
        },
        subscribers: [{ subscriptionType: "EMAIL", address: email }],
      });
    }

    new budgets.CfnBudget(this, "Budget", {
      budget: {
        budgetName: brandedName("Budget"),
        budgetType: "COST",
        timeUnit: "MONTHLY",
        budgetLimit: {
          amount: maxBudget,
          unit: "USD",
        },
        costFilters: {
          // Scope the budget to resources tagged Project=BrainTwin.
          // Universal stack-level tag was set in braintwin-stack.ts.
          // Without this filter the budget would track the WHOLE account.
          TagKeyValue: ["user:Project$BrainTwin"],
        },
      },
      notificationsWithSubscribers: notifications,
    });

    // -----------------------------------------------------------------
    // 3) DLM EBS snapshot policy — daily, 7-day retention
    // -----------------------------------------------------------------
    //
    // Independent of Litestream (which covers SQLite WAL) and the
    // nightly Chroma tarball (which covers vector data). DLM snapshots
    // the whole EBS volume — captures Chroma + images + anything else
    // on /var/lib/braintwin/data. Cheap insurance: ~$0.05/GB/month for
    // snapshot storage, so 7 × 20GiB snapshots = ~$7/month.
    //
    // Targets the data volume by tag (BrainTwin-EBS-0). DLM finds it
    // via tag selector — no direct reference, so the policy doesn't
    // care if the volume gets replaced.
    this.dlmRole = new iam.Role(this, "DlmRole", {
      assumedBy: new iam.ServicePrincipal("dlm.amazonaws.com"),
      roleName: brandedName("DLM-Role"),
      description: "Lets DLM call EC2 to create/delete EBS snapshots.",
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "service-role/AWSDataLifecycleManagerServiceRole",
        ),
      ],
    });

    new dlm.CfnLifecyclePolicy(this, "EbsSnapshotPolicy", {
      description: brandedName("EBS Daily Snapshots"),
      state: "ENABLED",
      executionRoleArn: this.dlmRole.roleArn,
      policyDetails: {
        policyType: "EBS_SNAPSHOT_MANAGEMENT",
        resourceTypes: ["VOLUME"],
        // Select the data volume(s) by the stack-wide Project tag, which
        // covers every data volume across AZs (BrainTwin-EBS-0, -1, …)
        // without naming each one. This relies on the EC2 ROOT volumes
        // NOT carrying this tag — they're inline blockDevices in
        // compute.ts and CDK does not propagate instance tags to them by
        // default, so only the standalone ec2.Volume data disks match.
        // If you ever enable volume tag propagation on the instance, add
        // a dedicated `Backup: daily` tag here (and on the data volumes)
        // to keep root disks out of the snapshot set.
        targetTags: [{ key: "Project", value: "BrainTwin" }],
        schedules: [
          {
            name: "Daily",
            tagsToAdd: [
              { key: "Name", value: brandedName("EBS-Snapshot") },
              { key: "Source", value: "DLM" },
            ],
            copyTags: true,
            createRule: {
              // Daily, in a low-traffic window (03:00 UTC = 20:00 PDT).
              // Snapshots are crash-consistent — fine for our data
              // since we don't need application-quiesced snapshots
              // (SQLite WAL replays cleanly from any consistent state).
              interval: 24,
              intervalUnit: "HOURS",
              times: ["03:00"],
            },
            retainRule: {
              // 7 daily snapshots. Older than that, you'd prefer
              // Litestream's WAL or the Chroma tarball anyway.
              count: 7,
            },
          },
        ],
      },
    });

    // -----------------------------------------------------------------
    // 4) Outputs — for ops runbooks
    // -----------------------------------------------------------------
    new cdk.CfnOutput(this, "AppLogGroupName", {
      value: appLogGroupName,
      description:
        `CloudWatch log group for the FastAPI app. ` +
        `Tail via: aws logs tail ${appLogGroupName} --follow --profile braintwin`,
    });

    new cdk.CfnOutput(this, "BotLogGroupName", {
      value: botLogGroupName,
      description:
        `CloudWatch log group for the Telegram bot. ` +
        `Tail via: aws logs tail ${botLogGroupName} --follow --profile braintwin`,
    });
  }

  /**
   * Grant the EC2 instance role permission to write to the log groups
   * via the Docker awslogs log driver. M.3 user-data templates the
   * driver config; this permission makes the writes work.
   */
  public grantLogWrite(role: iam.IRole): void {
    this.appLogGroup.grantWrite(role);
    this.botLogGroup.grantWrite(role);
  }
}

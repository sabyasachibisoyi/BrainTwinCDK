/**
 * ObservabilityConstruct unit tests — Phase 4.0.6 M.2.h.
 *
 * Three independent concerns to validate:
 *
 *   - Log groups: correct names, retention, RETAIN policy.
 *   - Budget: thresholds from config, scoped by Project tag (not
 *     account-wide), forecasted AND actual notifications per threshold.
 *   - DLM: daily schedule, 7-day retention, scoped by Project tag.
 *
 * Regression classes these catch: silent budget removal (operator
 * stops getting alerts → surprise bill), log retention dropping to
 * NEVER (silent unbounded log storage growth), DLM tag filter
 * mismatching the volume's tag (silent backup gap).
 */
import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { BrainTwinStack } from "../../lib/braintwin-stack";
import { brandedName, brandedPath, getConfig } from "../../lib/stack-config";

function makeStack(): cdk.Stack {
  const app = new cdk.App();
  return new BrainTwinStack(app, "TestStack-us-west-2", {
    env: { account: "123456789012", region: "us-west-2" },
    config: getConfig("us-west-2"),
    imageTag: "test-tag",
    caddyImageTag: "test-caddy-tag",
  });
}

describe("ObservabilityConstruct", () => {
  describe("CloudWatch log groups", () => {
    test("creates exactly three log groups (app + bot + caddy as of M.4.b)", () => {
      const t = Template.fromStack(makeStack());
      t.resourceCountIs("AWS::Logs::LogGroup", 3);
    });

    test("caddy log group is at /braintwin/caddy", () => {
      const t = Template.fromStack(makeStack());
      t.hasResourceProperties("AWS::Logs::LogGroup", {
        LogGroupName: brandedPath("caddy"),
      });
    });

    test("app log group is at /braintwin/app", () => {
      const t = Template.fromStack(makeStack());
      t.hasResourceProperties("AWS::Logs::LogGroup", {
        LogGroupName: brandedPath("app"),
      });
    });

    test("bot log group is at /braintwin/bot", () => {
      const t = Template.fromStack(makeStack());
      t.hasResourceProperties("AWS::Logs::LogGroup", {
        LogGroupName: brandedPath("bot"),
      });
    });

    test("retention is 30 days (bounded cost + enough history)", () => {
      const t = Template.fromStack(makeStack());
      const groups = t.findResources("AWS::Logs::LogGroup");
      for (const group of Object.values(groups)) {
        // RetentionDays.ONE_MONTH = 30
        expect(group.Properties.RetentionInDays).toBe(30);
      }
    });

    test("log groups have RETAIN policy (survives cdk destroy for post-mortems)", () => {
      const t = Template.fromStack(makeStack());
      const groups = t.findResources("AWS::Logs::LogGroup");
      for (const group of Object.values(groups)) {
        expect(group.DeletionPolicy).toBe("Retain");
        expect(group.UpdateReplacePolicy).toBe("Retain");
      }
    });
  });

  describe("AWS Budget", () => {
    test("exactly one budget is created", () => {
      const t = Template.fromStack(makeStack());
      t.resourceCountIs("AWS::Budgets::Budget", 1);
    });

    test("budget is scoped to Project=BrainTwin tag (not account-wide)", () => {
      const t = Template.fromStack(makeStack());
      t.hasResourceProperties("AWS::Budgets::Budget", {
        Budget: Match.objectLike({
          CostFilters: Match.objectLike({
            TagKeyValue: Match.arrayWith(["user:Project$BrainTwin"]),
          }),
        }),
      });
    });

    test("budget amount = max threshold from config", () => {
      const t = Template.fromStack(makeStack());
      // Derive the expected cap from config so this doesn't drift when
      // the thresholds change (the max threshold is the budget limit).
      const maxBudget = Math.max(...getConfig("us-west-2").budgetThresholdsUSD);
      t.hasResourceProperties("AWS::Budgets::Budget", {
        Budget: Match.objectLike({
          BudgetLimit: { Amount: maxBudget, Unit: "USD" },
        }),
      });
    });

    test("each threshold creates FORECASTED + ACTUAL notifications (= 2× thresholds)", () => {
      const t = Template.fromStack(makeStack());
      const budgets = t.findResources("AWS::Budgets::Budget");
      const budget = Object.values(budgets)[0];
      const notifications =
        budget.Properties.NotificationsWithSubscribers ?? [];
      // 4 thresholds × 2 notification types = 8
      expect(notifications.length).toBe(8);
    });

    test("notifications include BOTH FORECASTED and ACTUAL types", () => {
      const t = Template.fromStack(makeStack());
      const budgets = t.findResources("AWS::Budgets::Budget");
      const notifications =
        Object.values(budgets)[0].Properties.NotificationsWithSubscribers ??
        [];
      const types = new Set(
        notifications.map(
          (n: { Notification: { NotificationType: string } }) =>
            n.Notification.NotificationType,
        ),
      );
      expect(types.has("FORECASTED")).toBe(true);
      expect(types.has("ACTUAL")).toBe(true);
    });

    test("budget name = brandedName('Budget')", () => {
      const t = Template.fromStack(makeStack());
      t.hasResourceProperties("AWS::Budgets::Budget", {
        Budget: Match.objectLike({ BudgetName: brandedName("Budget") }),
      });
    });
  });

  describe("DLM EBS snapshot policy", () => {
    test("exactly one lifecycle policy", () => {
      const t = Template.fromStack(makeStack());
      t.resourceCountIs("AWS::DLM::LifecyclePolicy", 1);
    });

    test("policy targets EBS Volumes (not snapshots or instances)", () => {
      const t = Template.fromStack(makeStack());
      t.hasResourceProperties("AWS::DLM::LifecyclePolicy", {
        PolicyDetails: Match.objectLike({
          PolicyType: "EBS_SNAPSHOT_MANAGEMENT",
          ResourceTypes: ["VOLUME"],
        }),
      });
    });

    test("targets volumes by Project=BrainTwin tag", () => {
      const t = Template.fromStack(makeStack());
      t.hasResourceProperties("AWS::DLM::LifecyclePolicy", {
        PolicyDetails: Match.objectLike({
          TargetTags: Match.arrayWith([
            Match.objectLike({ Key: "Project", Value: "BrainTwin" }),
          ]),
        }),
      });
    });

    test("schedule is daily (24h interval) in low-traffic window", () => {
      const t = Template.fromStack(makeStack());
      t.hasResourceProperties("AWS::DLM::LifecyclePolicy", {
        PolicyDetails: Match.objectLike({
          Schedules: Match.arrayWith([
            Match.objectLike({
              CreateRule: Match.objectLike({
                Interval: 24,
                IntervalUnit: "HOURS",
                Times: Match.arrayWith(["03:00"]),
              }),
            }),
          ]),
        }),
      });
    });

    test("retain rule keeps last 7 snapshots", () => {
      const t = Template.fromStack(makeStack());
      t.hasResourceProperties("AWS::DLM::LifecyclePolicy", {
        PolicyDetails: Match.objectLike({
          Schedules: Match.arrayWith([
            Match.objectLike({
              RetainRule: Match.objectLike({ Count: 7 }),
            }),
          ]),
        }),
      });
    });

    test("policy is ENABLED (not disabled by default)", () => {
      const t = Template.fromStack(makeStack());
      t.hasResourceProperties("AWS::DLM::LifecyclePolicy", {
        State: "ENABLED",
      });
    });

    test("DLM role can be assumed by the dlm service principal", () => {
      const t = Template.fromStack(makeStack());
      // Find the role assumed by dlm.amazonaws.com
      const roles = t.findResources("AWS::IAM::Role");
      const dlmRoleEntry = Object.entries(roles).find(([, role]) => {
        const stmts = role.Properties.AssumeRolePolicyDocument.Statement;
        return stmts.some((s: { Principal: { Service: string } }) =>
          JSON.stringify(s.Principal).includes("dlm.amazonaws.com"),
        );
      });
      expect(dlmRoleEntry).toBeDefined();
    });
  });

  describe("Stack-level wiring (logs grant to compute.instanceRole)", () => {
    test("instance role can write to BOTH log groups", () => {
      const t = Template.fromStack(makeStack());
      const policies = t.findResources("AWS::IAM::Policy");
      const policyTexts = Object.values(policies).map((p) =>
        JSON.stringify(p.Properties.PolicyDocument),
      );
      const concat = policyTexts.join("\n");
      // CDK encodes log group ARNs as Fn::GetAtt references rather
      // than literal names, so check for the relevant action.
      expect(concat).toContain("logs:CreateLogStream");
      expect(concat).toContain("logs:PutLogEvents");
    });
  });

  describe("CloudFormation outputs", () => {
    test("both log group names are advertised in outputs", () => {
      const t = Template.fromStack(makeStack());
      const outputs = t.findOutputs("*");
      const found = Object.values(outputs).filter(
        (o) =>
          typeof o.Value === "string" &&
          (o.Value as string).startsWith("/braintwin/"),
      );
      // app + bot log group names
      expect(found.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("M.11 — CloudWatch dashboard for app-level EMF metrics", () => {
    test("creates exactly one CloudWatch dashboard named BrainTwin-App", () => {
      const t = Template.fromStack(makeStack());
      t.resourceCountIs("AWS::CloudWatch::Dashboard", 1);
      t.hasResourceProperties("AWS::CloudWatch::Dashboard", {
        DashboardName: brandedName("App"),
      });
    });

    test("dashboard body references BrainTwin/App namespace + all 3 metric names", () => {
      // CDK stringifies the DashboardBody as an Fn::Join of literal
      // strings + CFN tokens; we stringify the whole resource and grep
      // for substrings. If a metric name regresses (e.g., the app
      // renames anthropic_latency_ms but the dashboard doesn't
      // follow), this catches it at PR time.
      const t = Template.fromStack(makeStack());
      const dashboards = t.findResources("AWS::CloudWatch::Dashboard");
      const blob = JSON.stringify(Object.values(dashboards)[0]);
      expect(blob).toContain("BrainTwin/App");
      expect(blob).toContain("latency_ms");
      expect(blob).toContain("anthropic_latency_ms");
      expect(blob).toContain("chroma_query_latency_ms");
    });

    test("dashboard widgets pin specific routes and Anthropic endpoints", () => {
      // The widgets pin specific dimension values (route=/capture,
      // route=/recall, endpoint=enrich, etc.). If anyone strips them
      // out into a single un-dimensioned graph, the per-route signal
      // gets averaged into uselessness.
      const t = Template.fromStack(makeStack());
      const dashboards = t.findResources("AWS::CloudWatch::Dashboard");
      const blob = JSON.stringify(Object.values(dashboards)[0]);
      expect(blob).toContain("/capture");
      expect(blob).toContain("/recall");
      expect(blob).toContain("enrich");
      expect(blob).toContain("complete_json");
    });

    test("dashboard also surfaces BrainTwin/System metrics via SEARCH (no pinned InstanceId)", () => {
      // System metrics (CPU/mem/disk/diskio from M.5 CW Agent) live in
      // a separate namespace and carry a dynamic InstanceId dimension.
      // Pinning a specific InstanceId would break the chart on every
      // §14.1 instance replacement. The dashboard uses SEARCH math
      // expressions instead — bound by metric name + dimension schema,
      // not by a particular id. If anyone replaces SEARCH with a
      // hardcoded metric query, the chart goes blank the next time
      // CFN replaces the instance.
      const t = Template.fromStack(makeStack());
      const dashboards = t.findResources("AWS::CloudWatch::Dashboard");
      const blob = JSON.stringify(Object.values(dashboards)[0]);
      expect(blob).toContain("BrainTwin/System");
      // Specific metric names from M.5's CW Agent config — these
      // identify what's actually being charted.
      expect(blob).toContain("cpu_usage_idle");
      expect(blob).toContain("mem_used_percent");
      expect(blob).toContain("used_percent");   // disk
      expect(blob).toContain("write_bytes");    // diskio
      // SEARCH math expression in use (across-InstanceId resilience)
      expect(blob).toContain("SEARCH(");
    });

    test("dashboard SEARCH schemas do NOT include InstanceId or host (instance-lifetime cardinality guard)", () => {
      // Pairs with the assets/amazon-cloudwatch-agent.json config that
      // drops `append_dimensions` (InstanceId) and sets `omit_hostname:
      // true`. Both decisions exist to keep custom-metric cardinality
      // bounded across instance replacements (§14.1 EBS-deadlock dance
      // mints a new InstanceId/hostname each time, and CW retains them
      // for 15 months → ghost lines + drifting cost).
      //
      // The dashboard side of the contract: SEARCH schemas must NOT
      // reference these dimensions. If anyone adds them back (e.g., to
      // distinguish multi-AZ instances) they have to update BOTH the
      // agent config AND every SEARCH expression — and ideally pick a
      // STABLE label (az, node-role) over the ephemeral InstanceId.
      const t = Template.fromStack(makeStack());
      const dashboards = t.findResources("AWS::CloudWatch::Dashboard");
      const blob = JSON.stringify(Object.values(dashboards)[0]);
      // The SEARCH schema appears as `{BrainTwin/System,...} MetricName`
      // — check no schema includes InstanceId or host.
      expect(blob).not.toMatch(/BrainTwin\/System[^}]*InstanceId/);
      expect(blob).not.toMatch(/BrainTwin\/System[^}]*\bhost\b/);
    });

    test("dashboard URL is in outputs (operator runbook needs it)", () => {
      // The Value is a CFN token (it embeds Stack.region as a Ref so
      // the URL stays correct across regions), so `typeof === "string"`
      // returns false. Match on the output KEY + the literal
      // Description instead, both of which stay as strings at synth.
      const t = Template.fromStack(makeStack());
      const outputs = t.findOutputs("*");
      const found = Object.entries(outputs).find(
        ([key, o]) =>
          key.toLowerCase().includes("dashboard") &&
          typeof o.Description === "string" &&
          (o.Description as string).includes("dashboard for app-level"),
      );
      expect(found).toBeDefined();
    });

    test("dashboard surfaces Anthropic error counts by class (auth + rate + connection + status + bad-request)", () => {
      // The success-latency widget pins `error=none`, hiding failures.
      // The error-widget row (3.5) shows one line per Anthropic SDK
      // exception class. If someone strips this widget or renames the
      // classes, the operator loses visibility into WHY calls are
      // failing — the AuthenticationError alarm still fires but the
      // dashboard no longer distinguishes credit-out from network
      // blips from rate limits, forcing a console dive at incident
      // time. This test locks the five error classes we know about.
      const t = Template.fromStack(makeStack());
      const dashboards = t.findResources("AWS::CloudWatch::Dashboard");
      const blob = JSON.stringify(Object.values(dashboards)[0]);
      expect(blob).toContain("AuthenticationError");
      expect(blob).toContain("RateLimitError");
      expect(blob).toContain("APIConnectionError");
      expect(blob).toContain("APIStatusError");
      expect(blob).toContain("BadRequestError");
    });
  });

  describe("Anthropic AuthenticationError alarm (credit-exhaustion signal)", () => {
    test("exactly one SNS topic is created for operational alerts", () => {
      const t = Template.fromStack(makeStack());
      t.resourceCountIs("AWS::SNS::Topic", 1);
      t.hasResourceProperties("AWS::SNS::Topic", {
        TopicName: brandedName("Alerts"),
      });
    });

    test("no email subscription is created when BRAINTWIN_ALERT_EMAIL is unset (test env)", () => {
      // jest.setup.ts pins BRAINTWIN_ALERT_EMAIL="" so we never spam a
      // real address at test time. Under that config the SNS topic
      // MUST exist without any subscribers — the topic is still useful
      // (alarm state visible in console, subscribable post-deploy via
      // CLI), but no @example.invalid ghost subscription should leak
      // in. If someone forgets the guard and always subscribes, this
      // test catches it.
      const t = Template.fromStack(makeStack());
      t.resourceCountIs("AWS::SNS::Subscription", 0);
    });

    test("exactly one CloudWatch alarm is created", () => {
      const t = Template.fromStack(makeStack());
      t.resourceCountIs("AWS::CloudWatch::Alarm", 1);
    });

    test("alarm name is BrainTwin-Anthropic-AuthError", () => {
      const t = Template.fromStack(makeStack());
      t.hasResourceProperties("AWS::CloudWatch::Alarm", {
        AlarmName: brandedName("Anthropic-AuthError"),
      });
    });

    test("alarm uses metric-math over enumerated (endpoint, model) metrics filtered to error=AuthenticationError", () => {
      // The alarm metric must be a MathExpression backed by explicit
      // Metric queries. Two constraints drive this:
      //   1. CloudFormation rejects SEARCH() inside alarms
      //      ("SEARCH is not supported on Metric Alarms") — SEARCH
      //      returns a variable set of metrics, alarms need
      //      deterministic bindings.
      //   2. FILL(m, 0) turns missing samples into 0 so the sum
      //      evaluates when only ONE of the two Anthropic call paths
      //      hits an auth error in a given window.
      // If someone reintroduces SEARCH — this test fails at PR time,
      // before CloudFormation rejects it at deploy time.
      const t = Template.fromStack(makeStack());
      const alarms = t.findResources("AWS::CloudWatch::Alarm");
      const alarm = Object.values(alarms)[0];
      const metrics = alarm.Properties.Metrics ?? [];
      // Split into expression queries and raw MetricStat queries.
      const exprs = metrics
        .map((m: { Expression?: string }) => m.Expression)
        .filter((e: string | undefined): e is string => typeof e === "string");
      expect(exprs.length).toBeGreaterThan(0);
      const exprBlob = exprs.join(" ");
      // The math expression uses FILL, not SEARCH.
      expect(exprBlob).toContain("FILL");
      expect(exprBlob).not.toContain("SEARCH");
      // The underlying metric queries must reference anthropic_latency_ms
      // with SampleCount statistic AND the AuthenticationError dimension.
      const metricStats = metrics
        .map(
          (m: {
            MetricStat?: {
              Metric?: {
                MetricName?: string;
                Dimensions?: { Name: string; Value: string }[];
              };
              Stat?: string;
            };
          }) => m.MetricStat,
        )
        .filter((s: unknown): s is NonNullable<typeof s> => Boolean(s));
      // Two (endpoint, model) tuples → two MetricStat queries.
      expect(metricStats.length).toBe(2);
      for (const s of metricStats) {
        expect(s.Metric?.MetricName).toBe("anthropic_latency_ms");
        expect(s.Stat).toBe("SampleCount");
        const dimBlob = JSON.stringify(s.Metric?.Dimensions ?? []);
        expect(dimBlob).toContain("AuthenticationError");
      }
    });

    test("alarm threshold = 1 (single AuthenticationError triggers)", () => {
      const t = Template.fromStack(makeStack());
      t.hasResourceProperties("AWS::CloudWatch::Alarm", {
        Threshold: 1,
        ComparisonOperator: "GreaterThanOrEqualToThreshold",
        EvaluationPeriods: 1,
        DatapointsToAlarm: 1,
      });
    });

    test("alarm treats missing data as NOT_BREACHING (silent-app-is-OK)", () => {
      // Sustained missing data (no auth errors in a window) must NOT
      // hold the alarm in ALARM state — that would be a permanent
      // false-positive as soon as auth errors stopped. NOT_BREACHING
      // (== "notBreaching" in CFN JSON) is the correct choice for a
      // rare-event error metric.
      const t = Template.fromStack(makeStack());
      t.hasResourceProperties("AWS::CloudWatch::Alarm", {
        TreatMissingData: "notBreaching",
      });
    });

    test("alarm publishes to the SNS alerts topic (not a stray topic)", () => {
      // The alarm action MUST reference the same SNS topic we created,
      // otherwise the alarm is decorative — it enters ALARM state but
      // no email ever fires.
      const t = Template.fromStack(makeStack());
      const alarms = t.findResources("AWS::CloudWatch::Alarm");
      const alarm = Object.values(alarms)[0];
      const actions = alarm.Properties.AlarmActions ?? [];
      expect(actions.length).toBe(1);
      // CDK renders topic ARNs as { Ref: "AlertsTopic..." } tokens.
      // Stringify and match the logical id prefix.
      const actionBlob = JSON.stringify(actions[0]);
      expect(actionBlob).toContain("AlertsTopic");
    });

    test("alarm description mentions credit exhaustion + recharge URL (runbook-in-a-tooltip)", () => {
      // The description is what shows in the SNS email body. If it
      // just says "AlarmName ALARM state", the operator has to hunt
      // through CloudWatch to figure out what to do. Bake the fix into
      // the description so email → recharge is one click.
      const t = Template.fromStack(makeStack());
      const alarms = t.findResources("AWS::CloudWatch::Alarm");
      const alarm = Object.values(alarms)[0];
      const desc = alarm.Properties.AlarmDescription as string;
      expect(desc).toContain("credit");
      expect(desc).toContain("console.anthropic.com");
    });

    test("alerts-topic ARN + alarm name are in outputs (post-deploy discovery)", () => {
      const t = Template.fromStack(makeStack());
      const outputs = t.findOutputs("*");
      const keys = Object.keys(outputs);
      expect(
        keys.some((k) => k.toLowerCase().includes("alertstopic")),
      ).toBe(true);
      expect(
        keys.some((k) => k.toLowerCase().includes("anthropicautherror")),
      ).toBe(true);
    });
  });
});

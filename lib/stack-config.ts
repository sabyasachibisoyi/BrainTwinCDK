/**
 * Per-region typed configuration for BrainTwinStack.
 *
 * Why this file is *separate* from braintwin-stack.ts:
 *   - Lets `bin/braintwin.ts` look up CONFIG[region] BEFORE instantiating
 *     the stack — so an unknown region fails fast at synth time with a
 *     clear message, not deep inside CDK.
 *   - No imports from `aws-cdk-lib` here on purpose: this file is pure
 *     data. Adding new regions doesn't touch the stack code.
 *
 * AZ parameterization (design §3.0.1):
 *   `availabilityZones` is a list. Today every region ships with a
 *   single-AZ value because Phase 4.0.6 is single-EC2. Tomorrow,
 *   *cold-standby* multi-AZ DR is one line — flip to
 *   `['us-west-2a', 'us-west-2b']` and `compute.ts` iterates.
 *
 *   What this design does NOT magically enable: active-active multi-AZ.
 *   That requires Postgres RDS + ALB + externalised conversation store
 *   and is explicitly Phase 5+ work (see design §3.0.1).
 */

export interface RegionConfig {
  /** AWS region slug (e.g. "us-west-2"). Doubles as the CDK env.region. */
  readonly region: string;

  /**
   * Availability Zones to deploy into. Length 1 for v1 (single EC2).
   * Adding a second AZ here creates a second EC2 + EBS pair via the
   * iteration pattern in lib/constructs/compute.ts (M.2.e).
   */
  readonly availabilityZones: string[];

  /**
   * EC2 instance type, written as the AWS instance string
   * (e.g. "t4g.small"). Parsed into a `ec2.InstanceType` inside
   * compute.ts to keep this config file free of CDK imports.
   */
  readonly instanceType: string;

  /** Root + data EBS size, gibibytes. 20 GiB is the §3.1 starting point. */
  readonly ebsSizeGiB: number;

  /** Budget alarm thresholds in USD. Email is wired in observability.ts. */
  readonly budgetThresholdsUSD: number[];

  /**
   * Email that AWS Budgets pages when a threshold trips. Sourced at
   * runtime from BRAINTWIN_ALERT_EMAIL (see .env.example) — never
   * hardcode a personal address here, it would land in git history.
   * Empty string at synth time is fine; observability.ts validates it
   * is set before wiring the actual Budgets subscription at deploy.
   */
  readonly budgetAlertEmail: string;
}

/**
 * Alert email is operator PII, so it is injected from the environment
 * rather than committed. Resolves to "" when unset, which keeps `cdk
 * synth` / tests working without leaking an address into source.
 */
const ALERT_EMAIL = process.env.BRAINTWIN_ALERT_EMAIL ?? "";

/**
 * The full region catalogue. `cdk deploy --context region=…` looks up
 * a key here. Add a new region by appending an entry — no other code
 * change required (design §3.0 multi-region from day one).
 */
export const CONFIG: Record<string, RegionConfig> = {
  "us-west-2": {
    region: "us-west-2",
    // Single AZ today. Add 'us-west-2b' here later for cold-standby DR.
    availabilityZones: ["us-west-2a"],
    instanceType: "t4g.small",
    ebsSizeGiB: 20,
    budgetThresholdsUSD: [50, 100, 150, 180],
    budgetAlertEmail: ALERT_EMAIL,
  },
  // Phase 5+ — NOT deployed on day one. The config sits here so
  // `cdk deploy --context region=ap-south-1` is a one-flag invocation
  // when (if) we ever stand up the second region.
  "ap-south-1": {
    region: "ap-south-1",
    availabilityZones: ["ap-south-1a"],
    instanceType: "t4g.small",
    ebsSizeGiB: 20,
    budgetThresholdsUSD: [50, 100, 150, 180],
    budgetAlertEmail: ALERT_EMAIL,
  },
};

/**
 * Helper used by bin/braintwin.ts. Centralises the "unknown region"
 * error so the CDK App entrypoint stays small.
 */
export function getConfig(region: string): RegionConfig {
  const cfg = CONFIG[region];
  if (!cfg) {
    const known = Object.keys(CONFIG).join(", ");
    throw new Error(
      `Unknown region '${region}'. Known regions: ${known}. ` +
        `Add an entry to lib/stack-config.ts to deploy to a new region.`,
    );
  }
  return cfg;
}

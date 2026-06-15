/**
 * Jest setup — runs before each test file's modules are imported.
 *
 * Purpose: make the synthesized template byte-stable regardless of the
 * operator's shell env. stack-config.ts reads BRAINTWIN_ALERT_EMAIL at
 * import time; if the test runner picks that up from a `.env` or an
 * exported shell var, the committed snapshot ends up baking a personal
 * email into git history (yikes) AND fails on any machine without the
 * same env. Forcing "" here means the runtime fallback to
 * "braintwin-alerts-unset@example.invalid" kicks in deterministically.
 *
 * Note: `setupFiles` (NOT `setupFilesAfterEach`) is the right hook —
 * it runs BEFORE the test file's imports, so by the time stack-config
 * reads `process.env.BRAINTWIN_ALERT_EMAIL` it sees the unset string.
 */
process.env.BRAINTWIN_ALERT_EMAIL = "";

/**
 * Jest config — covers both snapshot tests of the synthesized
 * CloudFormation template (test/braintwin-stack.test.ts) and unit
 * tests on individual constructs (test/constructs/*.test.ts).
 *
 * Snapshot mismatch = "you changed the template" — review the diff,
 * decide if intended, then `npm test -- -u` to update.
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.ts$': 'ts-jest',
  },
  moduleFileExtensions: ['ts', 'js'],
  collectCoverageFrom: [
    'lib/**/*.ts',
    'bin/**/*.ts',
    '!**/node_modules/**',
  ],
  // Snapshot files live alongside their test
  snapshotResolver: undefined,
  // Pin env-derived stack inputs to deterministic values BEFORE
  // stack-config.ts is loaded (which reads BRAINTWIN_ALERT_EMAIL at
  // module-import time). Without this the synth snapshot would either
  // leak an operator's real email into git OR drift between machines
  // that happen to have the env var set.
  setupFiles: ['<rootDir>/test/jest.setup.ts'],
};

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
};

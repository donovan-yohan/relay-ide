import {
  findFixtureTargetViolations,
  findOrphanFixtures,
  formatFixtureTargetViolations,
  formatOrphanFixtures,
} from './fixture-targets.js';

/**
 * Playwright global setup: refuse to start a run whose specs cannot execute.
 *
 * Failing here rather than inside each spec is deliberate — a spec pointed at a
 * missing fixture page reports "passed" for assertions it never reached, and a
 * green run is exactly the signal #1299 showed cannot be trusted. Aborting the
 * whole run makes the breakage impossible to read as coverage.
 */
export default function globalSetup(): void {
  const violations = findFixtureTargetViolations();
  if (violations.length > 0) {
    throw new Error(formatFixtureTargetViolations(violations));
  }
  const orphans = findOrphanFixtures();
  if (orphans.length > 0) {
    throw new Error(formatOrphanFixtures(orphans));
  }
}

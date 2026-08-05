import { describe, it, expect } from 'vitest';
import {
  findFixtureTargetViolations,
  findOrphanFixtures,
  formatFixtureTargetViolations,
  formatOrphanFixtures,
  listSpecFiles,
  readRegisteredFixtures,
  readSpecTargets,
} from './e2e/fixture-targets.js';

/**
 * #1299: 56 of 65 Playwright specs navigated to fixture pages that did not
 * exist, so they had never executed a single assertion while reading as
 * coverage. This is the gate that keeps that from happening again — it runs in
 * `npm test`, which is a required CI job, unlike the e2e suite itself.
 */
describe('e2e fixture target gate (#1299)', () => {
  it('every test/e2e spec navigates to a fixture page that exists and is built', () => {
    const violations = findFixtureTargetViolations();
    expect(
      violations,
      violations.length > 0 ? formatFixtureTargetViolations(violations) : ''
    ).toEqual([]);
  });

  it('every built fixture page is navigated to by at least one spec', () => {
    const orphans = findOrphanFixtures();
    expect(
      orphans,
      orphans.length > 0 ? formatOrphanFixtures(orphans) : ''
    ).toEqual([]);
  });

  // The checks above pass trivially if the scanner matches nothing. These pin
  // the scanner to the navigation forms actually used in the suite.
  it('scans real specs and both navigation forms', () => {
    const specs = listSpecFiles();
    expect(specs.length).toBeGreaterThan(0);

    const byTarget = new Map(
      readSpecTargets().map(({ spec, targets }) => [spec, targets])
    );
    // Plain literal: page.goto('/test-terminal.html').
    expect(byTarget.get('test/e2e/components/Terminal.spec.ts')).toEqual([
      'test-terminal.html',
    ]);
    // Template literal with a query string: `/test-channel-thread.html?${params}`.
    expect(byTarget.get('test/e2e/channel-thread.spec.ts')).toEqual([
      'test-channel-thread.html',
    ]);
  });

  it('reads fixture registrations out of frontend/vite.config.ts', () => {
    const registered = readRegisteredFixtures();
    expect(registered.has('test-terminal.html')).toBe(true);
    expect(registered.has('test-channel-thread.html')).toBe(true);
    expect(registered.has('test-this-page-never-existed.html')).toBe(false);
  });

  it('flags a spec whose fixture page does not exist', () => {
    const violations = findFixtureTargetViolations([
      {
        spec: 'test/e2e/components/Ghost.spec.ts',
        targets: ['test-ghost.html'],
      },
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.spec).toBe('test/e2e/components/Ghost.spec.ts');
    expect(violations[0]?.reason).toContain('does not exist');
    expect(formatFixtureTargetViolations(violations)).toContain(
      'test/e2e/components/Ghost.spec.ts'
    );
  });

  it('flags a fixture page that exists on disk but is not a build input', () => {
    const violations = findFixtureTargetViolations(
      [
        {
          spec: 'test/e2e/components/Unregistered.spec.ts',
          targets: ['test-terminal.html'],
        },
      ],
      new Set()
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.reason).toContain('frontend/vite.config.ts');
  });

  it('flags a built fixture page that no spec navigates to', () => {
    const orphans = findOrphanFixtures([
      {
        spec: 'test/e2e/components/Terminal.spec.ts',
        targets: ['test-terminal.html'],
      },
    ]);
    expect(orphans).toContain('test-channel-thread.html');
    expect(orphans).not.toContain('test-terminal.html');
    expect(formatOrphanFixtures(orphans)).toContain('frontend/');
  });
});

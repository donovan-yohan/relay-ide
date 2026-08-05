import { describe, it, expect } from 'vitest';
import {
  findFixtureTargetViolations,
  findOrphanFixtures,
  formatFixtureTargetViolations,
  formatOrphanFixtures,
  listScannedFiles,
  listSpecFiles,
  readRegisteredFixtures,
  readSpecTargets,
  staticNavigationPath,
  type ScannedFile,
} from './e2e/fixture-targets.js';

/**
 * #1299: 57 of 69 Playwright specs navigated to fixture pages that did not
 * exist, so they had never executed a single assertion while reading as
 * coverage. This is the gate that keeps that from happening again — it runs in
 * `npm test`, which is a required CI job, unlike the e2e suite itself.
 *
 * Half of this file is the gate's own escape hatches. Review broke the first
 * version by hoisting the fixture name into a `const`, moving the navigation
 * into an unscanned helper, and renaming the page so it no longer started with
 * `test-`; each produced a spec with zero recognised targets, which the gate
 * treated as "nothing to check". Those three are pinned below as failing cases.
 */

function scanned(overrides: Partial<ScannedFile> = {}): ScannedFile {
  return {
    file: 'test/e2e/components/Example.spec.ts',
    isSpec: true,
    targets: [],
    appRoot: false,
    foreign: [],
    unverifiable: [],
    imports: [],
    ...overrides,
  };
}

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
    expect(listSpecFiles().length).toBeGreaterThan(0);

    const byFile = new Map(
      readSpecTargets().map((entry) => [entry.file, entry])
    );
    // Plain literal: page.goto('/test-terminal.html').
    expect(byFile.get('test/e2e/components/Terminal.spec.ts')?.targets).toEqual([
      'test-terminal.html',
    ]);
    // Template literal with a query string: `/test-channel-thread.html?${params}`.
    expect(byFile.get('test/e2e/channel-thread.spec.ts')?.targets).toEqual([
      'test-channel-thread.html',
    ]);
    // App root: page.goto('/').
    expect(byFile.get('test/e2e/basic.spec.ts')?.appRoot).toBe(true);
  });

  it('scans helper modules, not only specs', () => {
    const files = listScannedFiles();
    expect(files).toContain('test/e2e/basic.spec.ts');
    // The harness itself is excluded; it documents goto() forms in prose.
    expect(files).not.toContain('test/e2e/fixture-targets.ts');
    expect(files).not.toContain('test/e2e/isolated-config.ts');
    // Every scanned file lives under test/e2e, spec or helper alike.
    expect(files.every((file) => file.startsWith('test/e2e/'))).toBe(true);
  });

  it('reads fixture registrations out of frontend/vite.config.ts', () => {
    const registered = readRegisteredFixtures();
    expect(registered.has('test-terminal.html')).toBe(true);
    expect(registered.has('test-channel-thread.html')).toBe(true);
    expect(registered.has('test-this-page-never-existed.html')).toBe(false);
  });

  it('flags a spec whose fixture page does not exist', () => {
    const violations = findFixtureTargetViolations([
      scanned({
        file: 'test/e2e/components/Ghost.spec.ts',
        targets: ['test-ghost.html'],
      }),
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
        scanned({
          file: 'test/e2e/components/Unregistered.spec.ts',
          targets: ['test-terminal.html'],
        }),
      ],
      new Set()
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.reason).toContain('frontend/vite.config.ts');
  });

  it('flags a built fixture page that no spec navigates to', () => {
    const orphans = findOrphanFixtures([
      scanned({
        file: 'test/e2e/components/Terminal.spec.ts',
        targets: ['test-terminal.html'],
      }),
    ]);
    expect(orphans).toContain('test-channel-thread.html');
    expect(orphans).not.toContain('test-terminal.html');
    expect(formatOrphanFixtures(orphans)).toContain('frontend/');
  });
});

describe('e2e fixture target gate — the three ways review broke it', () => {
  it('fails a spec that navigates nowhere it can recognise', () => {
    // Escape 1: `const FIXTURE = 'test-x'; page.goto(`/${FIXTURE}.html`)`.
    // The literal never appears, so the old gate saw zero targets and skipped
    // the spec entirely. Zero targets is now the finding.
    const violations = findFixtureTargetViolations([
      scanned({ file: 'test/e2e/components/Hoisted.spec.ts' }),
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.reason).toContain('no recognised navigation target');
  });

  it('accepts a spec whose navigation lives in a helper it imports', () => {
    // Escape 2: the navigation moved into an unscanned helper. Helpers are
    // scanned now, and a spec inherits their targets — so the honest version of
    // this pattern passes while the broken one still fails.
    const violations = findFixtureTargetViolations(
      [
        scanned({
          file: 'test/e2e/components/ViaHelper.spec.ts',
          imports: ['test/e2e/helpers/open.ts'],
        }),
        scanned({
          file: 'test/e2e/helpers/open.ts',
          isSpec: false,
          targets: ['test-terminal.html'],
        }),
      ],
      new Set(['test-terminal.html'])
    );
    expect(violations).toEqual([]);
  });

  it('flags a bad target reached only through a helper', () => {
    const violations = findFixtureTargetViolations([
      scanned({
        file: 'test/e2e/components/ViaHelper.spec.ts',
        imports: ['test/e2e/helpers/open.ts'],
      }),
      scanned({
        file: 'test/e2e/helpers/open.ts',
        isSpec: false,
        targets: ['test-ghost.html'],
      }),
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.spec).toBe('test/e2e/helpers/open.ts');
    expect(violations[0]?.reason).toContain('does not exist');
  });

  it('flags a static path that is not the app root or a test-*.html page', () => {
    // Escape 3: `page.goto('/fixture-ghost.html')` — a real navigation to a
    // page nothing builds, invisible to a `test-`-prefixed pattern.
    const violations = findFixtureTargetViolations([
      scanned({
        file: 'test/e2e/components/Foreign.spec.ts',
        foreign: ['/fixture-ghost.html'],
      }),
    ]);
    // Two findings, both true: the page is unbuildable AND the spec is left
    // with nothing it can be asserting against.
    expect(violations.map((violation) => violation.reason)).toEqual([
      expect.stringContaining('neither the app root'),
      expect.stringContaining('no recognised navigation target'),
    ]);
  });

  it('flags a navigation target it cannot resolve statically', () => {
    const violations = findFixtureTargetViolations([
      scanned({
        file: 'test/e2e/components/Dynamic.spec.ts',
        unverifiable: ['`/${FIXTURE}.html`'],
      }),
    ]);
    expect(violations.map((violation) => violation.reason)).toEqual([
      expect.stringContaining('not a static literal'),
      expect.stringContaining('no recognised navigation target'),
    ]);
  });

  it('lets a helper navigate nowhere', () => {
    expect(
      findFixtureTargetViolations([
        scanned({ file: 'test/e2e/helpers/util.ts', isSpec: false }),
      ])
    ).toEqual([]);
  });
});

describe('staticNavigationPath', () => {
  it('reads plain string literals', () => {
    expect(staticNavigationPath("'/test-terminal.html'")).toBe(
      '/test-terminal.html'
    );
    expect(staticNavigationPath('"/"')).toBe('/');
  });

  it('reads a template literal with no interpolation', () => {
    expect(staticNavigationPath('`/test-terminal.html`')).toBe(
      '/test-terminal.html'
    );
  });

  it('reads a template literal whose path is complete before the query', () => {
    expect(staticNavigationPath('`/test-channel-thread.html?${params}`')).toBe(
      '/test-channel-thread.html?'
    );
  });

  it('refuses a template literal whose path itself is interpolated', () => {
    expect(staticNavigationPath('`/${FIXTURE}.html`')).toBeNull();
    expect(staticNavigationPath('`/test-${name}.html`')).toBeNull();
  });

  it('refuses identifiers, calls, and concatenations', () => {
    expect(staticNavigationPath('FIXTURE_URL')).toBeNull();
    expect(staticNavigationPath('fixtureUrl()')).toBeNull();
    expect(staticNavigationPath("'/test-' + name + '.html'")).toBeNull();
  });
});

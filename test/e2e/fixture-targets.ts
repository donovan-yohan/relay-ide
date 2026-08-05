/**
 * Backpressure for the e2e fixture-page contract (#1299).
 *
 * A Playwright spec that navigates to `/test-<name>.html` only executes when
 * two independent things are true:
 *
 *   1. `frontend/test-<name>.html` exists on disk, and
 *   2. that page is a Rollup input in `frontend/vite.config.ts`, so
 *      `npm run build` actually emits it into `dist/frontend/`.
 *
 * When either is false the navigation 404s (or serves `index.html`) and every
 * assertion in the spec quietly stops describing the component it names. #1299
 * found 56 such specs — permanent no-ops that read like coverage for years.
 *
 * Prose cannot stop that from recurring, so this module is the machine-checked
 * form of the rule. It is consumed by:
 *   - `test/playwright-fixture-target-gate.test.ts` (vitest, runs in `npm test`)
 *   - `test/e2e/global-setup.ts` (Playwright, aborts `npm run test:e2e`)
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));

/** Repo root, resolved from this file so worktrees and CWD never matter. */
export const REPO_ROOT = join(HERE, '..', '..');
export const E2E_DIR = join(REPO_ROOT, 'test', 'e2e');
export const FRONTEND_DIR = join(REPO_ROOT, 'frontend');
export const VITE_CONFIG_PATH = join(FRONTEND_DIR, 'vite.config.ts');

const SPEC_FILE = /\.spec\.tsx?$/;
/** `page.goto('/test-foo.html')`, template literals, and URL consts alike. */
const NAVIGATION_TARGET = /\/(test-[a-z0-9-]+\.html)/g;
/** Every `'test-foo.html'` literal used as a Rollup input filename. */
const REGISTERED_INPUT = /'(test-[a-z0-9-]+\.html)'/g;

export interface SpecTargets {
  /** Repo-relative spec path, e.g. `test/e2e/components/Terminal.spec.ts`. */
  spec: string;
  /** Distinct `test-*.html` pages the spec navigates to, sorted. */
  targets: string[];
}

export interface FixtureTargetViolation {
  spec: string;
  target: string;
  reason: string;
}

function walkSpecFiles(dir: string, found: string[]): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkSpecFiles(full, found);
    else if (SPEC_FILE.test(entry.name)) found.push(full);
  }
  return found;
}

/** Every Playwright spec under `test/e2e/`, repo-relative and sorted. */
export function listSpecFiles(): string[] {
  return walkSpecFiles(E2E_DIR, [])
    .map((file) => relative(REPO_ROOT, file))
    .sort();
}

/** Specs paired with the fixture pages they navigate to (specs with none are omitted). */
export function readSpecTargets(): SpecTargets[] {
  const results: SpecTargets[] = [];
  for (const spec of listSpecFiles()) {
    const source = readFileSync(join(REPO_ROOT, spec), 'utf8');
    const targets = [
      ...new Set(
        [...source.matchAll(NAVIGATION_TARGET)].map(
          (match) => match[1] as string
        )
      ),
    ].sort();
    if (targets.length > 0) results.push({ spec, targets });
  }
  return results;
}

/**
 * Fixture pages registered as build inputs in `frontend/vite.config.ts`.
 *
 * Read textually rather than by importing the config: the config pulls in the
 * whole Vite/React plugin graph, and this check must stay usable from a bare
 * vitest run and from Playwright's global setup alike.
 */
export function readRegisteredFixtures(): Set<string> {
  const source = readFileSync(VITE_CONFIG_PATH, 'utf8');
  return new Set(
    [...source.matchAll(REGISTERED_INPUT)].map((match) => match[1] as string)
  );
}

/**
 * One entry per (spec, unresolvable target) pair. Empty means the suite is honest.
 *
 * Both inputs are injectable so the gate's own tests can prove it still flags a
 * bad target — a checker that silently matches nothing is the failure mode this
 * whole module exists to prevent.
 */
export function findFixtureTargetViolations(
  specTargets: readonly SpecTargets[] = readSpecTargets(),
  registered: ReadonlySet<string> = readRegisteredFixtures()
): FixtureTargetViolation[] {
  const violations: FixtureTargetViolation[] = [];
  for (const { spec, targets } of specTargets) {
    for (const target of targets) {
      if (!existsSync(join(FRONTEND_DIR, target))) {
        violations.push({
          spec,
          target,
          reason: `frontend/${target} does not exist — the spec navigates to a 404 and never asserts anything`,
        });
        continue;
      }
      if (!registered.has(target)) {
        violations.push({
          spec,
          target,
          reason: `frontend/${target} is not a build input in frontend/vite.config.ts — it is missing from dist/frontend/`,
        });
      }
    }
  }
  return violations;
}

/** Fixture pages that are built but no spec navigates to: dead build weight. */
export function findOrphanFixtures(
  specTargets: readonly SpecTargets[] = readSpecTargets()
): string[] {
  const navigated = new Set(specTargets.flatMap(({ targets }) => targets));
  return [...readRegisteredFixtures()]
    .filter((fixture) => !navigated.has(fixture))
    .sort();
}

export function formatFixtureTargetViolations(
  violations: readonly FixtureTargetViolation[]
): string {
  const bySpec = new Map<string, FixtureTargetViolation[]>();
  for (const violation of violations) {
    const bucket = bySpec.get(violation.spec) ?? [];
    bucket.push(violation);
    bySpec.set(violation.spec, bucket);
  }
  const lines = [
    `${violations.length} e2e fixture target(s) do not resolve (#1299).`,
    'A spec whose fixture page is missing or unbuilt is a no-op that reads like coverage.',
    'Fix by adding the page under frontend/ AND registering it in frontend/vite.config.ts,',
    'or by deleting the spec and noting the uncovered flow in docs/QUALITY.md.',
    '',
  ];
  for (const [spec, specViolations] of [...bySpec].sort()) {
    lines.push(`  ${spec}`);
    for (const { target, reason } of specViolations) {
      lines.push(`    -> /${target}: ${reason}`);
    }
  }
  return lines.join('\n');
}

export function formatOrphanFixtures(orphans: readonly string[]): string {
  return [
    `${orphans.length} fixture page(s) are built but no test/e2e/ spec navigates to them (#1299).`,
    'Delete the page (plus its entry module and frontend/vite.config.ts input) or add the spec that uses it.',
    '',
    ...orphans.map((fixture) => `  frontend/${fixture}`),
  ].join('\n');
}

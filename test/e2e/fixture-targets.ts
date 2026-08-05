/**
 * Backpressure for the e2e fixture-page contract (#1299).
 *
 * A Playwright spec only executes what it claims to when the page it navigates
 * to actually resolves:
 *
 *   1. `frontend/test-<name>.html` exists on disk, and
 *   2. that page is a Rollup input in `frontend/vite.config.ts`, so
 *      `npm run build` emits it into `dist/frontend/`.
 *
 * When either is false the navigation 404s (or serves `index.html`) and every
 * assertion in the spec quietly stops describing the component it names. The
 * #1299 audit found 57 such specs — permanent no-ops that read like coverage.
 *
 * The first version of this gate matched literal `/test-*.html` substrings in
 * `*.spec.ts(x)` files, which review broke in three moves: hoist the page name
 * into a `const`, put the navigation in a helper (helpers were not scanned),
 * or name the page anything not starting with `test-`. All three produced a
 * spec with zero recognised targets, and zero targets meant "nothing to check".
 *
 * So the check is positive now, and it covers every `.ts`/`.tsx` file under
 * `test/e2e/` rather than only specs:
 *
 *   - every `.goto(...)` argument must be a *static, resolvable* path — the app
 *     root or a built fixture page. A dynamic argument is reported as an
 *     unverifiable target, never ignored.
 *   - every spec must end up with at least one recognised target, counting the
 *     `test/e2e/` helpers it imports. A spec that navigates nowhere fails.
 *
 * Consumed by:
 *   - `test/playwright-fixture-target-gate.test.ts` (vitest, runs in `npm test`)
 *   - `test/e2e/global-setup.ts` (Playwright, aborts `npm run test:e2e`)
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));

/** Repo root, resolved from this file so worktrees and CWD never matter. */
export const REPO_ROOT = join(HERE, '..', '..');
export const E2E_DIR = join(REPO_ROOT, 'test', 'e2e');
export const FRONTEND_DIR = join(REPO_ROOT, 'frontend');
export const VITE_CONFIG_PATH = join(FRONTEND_DIR, 'vite.config.ts');

const SOURCE_FILE = /\.tsx?$/;
const SPEC_FILE = /\.spec\.tsx?$/;

/**
 * Harness modules under `test/e2e/`. They are scanned for nothing: this file
 * documents navigation forms in prose, and a doc comment is not a navigation.
 */
const HARNESS_MODULES: ReadonlySet<string> = new Set([
  'test/e2e/fixture-targets.ts',
  'test/e2e/global-setup.ts',
  'test/e2e/global-teardown.ts',
  'test/e2e/isolated-config.ts',
]);

/** `page.goto(`, `reducedMotionPage.goto(`, … — any receiver. */
const GOTO_CALL = /\.goto\s*\(/g;
/** Relative import specifiers, used to follow a spec into its helpers. */
const IMPORT_SPECIFIER = /(?:\bfrom|\bimport)\s*\(?\s*['"](\.[^'"]+)['"]/g;
/** Every `'test-foo.html'` literal used as a Rollup input filename. */
const REGISTERED_INPUT = /'(test-[a-z0-9-]+\.html)'/g;
/** A fixture page path: `/test-foo.html`. */
const FIXTURE_PATH = /^\/(test-[a-z0-9-]+\.html)$/;

export interface ScannedFile {
  /** Repo-relative path, e.g. `test/e2e/components/Terminal.spec.ts`. */
  file: string;
  /** True for `*.spec.ts(x)`; helpers are scanned but never required to navigate. */
  isSpec: boolean;
  /** Distinct `test-*.html` pages this file navigates to, sorted. */
  targets: string[];
  /** True when this file navigates to the app root (`/`). */
  appRoot: boolean;
  /** Static paths that are neither the app root nor a `test-*.html` page. */
  foreign: string[];
  /** `.goto()` arguments that are not static literals, verbatim. */
  unverifiable: string[];
  /** Repo-relative `test/e2e/` modules this file imports. */
  imports: string[];
}

export interface FixtureTargetViolation {
  spec: string;
  /** The offending target, or `''` when the whole file is the finding. */
  target: string;
  reason: string;
}

function walkSourceFiles(dir: string, found: string[]): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkSourceFiles(full, found);
    else if (SOURCE_FILE.test(entry.name)) found.push(full);
  }
  return found;
}

function toRepoRelative(file: string): string {
  return relative(REPO_ROOT, file).split(/[\\/]/).join('/');
}

/** Every `.ts`/`.tsx` under `test/e2e/` except the harness, repo-relative. */
export function listScannedFiles(): string[] {
  return walkSourceFiles(E2E_DIR, [])
    .map(toRepoRelative)
    .filter((file) => !HARNESS_MODULES.has(file))
    .sort();
}

/** Every Playwright spec under `test/e2e/`, repo-relative and sorted. */
export function listSpecFiles(): string[] {
  return listScannedFiles().filter((file) => SPEC_FILE.test(file));
}

/**
 * Read the argument expression of a call whose `(` sits at `open`.
 *
 * Deliberately small: it tracks quotes and nesting far enough to find the end
 * of the first argument, and anything it cannot read confidently comes back as
 * a non-literal, which the gate reports rather than skips.
 */
function readFirstArgument(source: string, open: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < source.length; i++) {
    const char = source[i] as string;
    if (quote) {
      if (char === '\\') i++;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === '(' || char === '[' || char === '{') depth++;
    else if (char === ')' || char === ']' || char === '}') {
      depth--;
      if (depth === 0) return source.slice(open + 1, i).trim();
    } else if (char === ',' && depth === 1) {
      return source.slice(open + 1, i).trim();
    }
  }
  return source.slice(open + 1).trim();
}

/**
 * The static path a `.goto()` argument resolves to, or `null` when it does not
 * resolve statically.
 *
 * Template literals count only when the static prefix already contains the
 * whole path — `` `/test-channel-thread.html?${params}` `` does,
 * `` `/${FIXTURE}.html` `` does not.
 */
export function staticNavigationPath(expression: string): string | null {
  const trimmed = expression.trim();
  const quote = trimmed[0];
  if (quote === "'" || quote === '"') {
    const end = trimmed.indexOf(quote, 1);
    if (end !== trimmed.length - 1) return null;
    return trimmed.slice(1, end);
  }
  if (quote !== '`') return null;
  const interpolation = trimmed.indexOf('${');
  if (interpolation === -1) {
    if (!trimmed.endsWith('`')) return null;
    return trimmed.slice(1, -1);
  }
  const prefix = trimmed.slice(1, interpolation);
  // Usable only if the path is already complete before the first `${`.
  return /[?#]/.test(prefix) ? prefix : null;
}

function resolveE2eImport(fromFile: string, specifier: string): string | null {
  const base = resolve(dirname(join(REPO_ROOT, fromFile)), specifier);
  for (const candidate of [
    base.replace(/\.jsx$/, '.tsx'),
    base.replace(/\.js$/, '.ts'),
    base.replace(/\.js$/, '.tsx'),
    `${base}.ts`,
    `${base}.tsx`,
  ]) {
    if (!existsSync(candidate)) continue;
    const rel = toRepoRelative(candidate);
    return rel.startsWith('test/e2e/') ? rel : null;
  }
  return null;
}

function scanFile(file: string): ScannedFile {
  const source = readFileSync(join(REPO_ROOT, file), 'utf8');
  const targets = new Set<string>();
  const foreign = new Set<string>();
  const unverifiable: string[] = [];
  let appRoot = false;

  for (const match of source.matchAll(GOTO_CALL)) {
    const open = (match.index as number) + match[0].length - 1;
    const argument = readFirstArgument(source, open);
    const path = staticNavigationPath(argument);
    if (path === null) {
      unverifiable.push(argument.replace(/\s+/g, ' ').slice(0, 80));
      continue;
    }
    const bare = path.split(/[?#]/)[0] as string;
    if (bare === '/' || bare === '') {
      appRoot = true;
      continue;
    }
    const fixture = FIXTURE_PATH.exec(bare);
    if (fixture) targets.add(fixture[1] as string);
    else foreign.add(bare);
  }

  const imports = new Set<string>();
  for (const match of source.matchAll(IMPORT_SPECIFIER)) {
    const resolved = resolveE2eImport(file, match[1] as string);
    if (resolved && resolved !== file) imports.add(resolved);
  }

  return {
    file,
    isSpec: SPEC_FILE.test(file),
    targets: [...targets].sort(),
    appRoot,
    foreign: [...foreign].sort(),
    unverifiable,
    imports: [...imports].sort(),
  };
}

/** Every scanned `test/e2e/` file with the navigation it performs. */
export function readSpecTargets(): ScannedFile[] {
  return listScannedFiles().map(scanFile);
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

/** Targets a spec reaches directly or through the `test/e2e/` helpers it imports. */
function reachableNavigation(
  file: ScannedFile,
  byFile: ReadonlyMap<string, ScannedFile>
): { targets: string[]; appRoot: boolean } {
  const seen = new Set<string>([file.file]);
  const queue = [...file.imports];
  const targets = new Set(file.targets);
  let appRoot = file.appRoot;
  while (queue.length > 0) {
    const next = queue.pop() as string;
    if (seen.has(next)) continue;
    seen.add(next);
    const scanned = byFile.get(next);
    if (!scanned) continue;
    for (const target of scanned.targets) targets.add(target);
    appRoot ||= scanned.appRoot;
    queue.push(...scanned.imports);
  }
  return { targets: [...targets].sort(), appRoot };
}

/**
 * Everything wrong with the suite's navigation. Empty means the suite is honest.
 *
 * Both inputs are injectable so the gate's own tests can prove it still flags a
 * bad target — a checker that silently matches nothing is the failure mode this
 * whole module exists to prevent.
 */
export function findFixtureTargetViolations(
  scanned: readonly ScannedFile[] = readSpecTargets(),
  registered: ReadonlySet<string> = readRegisteredFixtures()
): FixtureTargetViolation[] {
  const violations: FixtureTargetViolation[] = [];
  const byFile = new Map(scanned.map((entry) => [entry.file, entry]));

  for (const entry of scanned) {
    for (const target of entry.targets) {
      if (!existsSync(join(FRONTEND_DIR, target))) {
        violations.push({
          spec: entry.file,
          target,
          reason: `frontend/${target} does not exist — the spec navigates to a 404 and never asserts anything`,
        });
        continue;
      }
      if (!registered.has(target)) {
        violations.push({
          spec: entry.file,
          target,
          reason: `frontend/${target} is not a build input in frontend/vite.config.ts — it is missing from dist/frontend/`,
        });
      }
    }

    for (const path of entry.foreign) {
      violations.push({
        spec: entry.file,
        target: path,
        reason: `${path} is neither the app root nor a test-*.html fixture page, so nothing checks that it resolves`,
      });
    }

    for (const expression of entry.unverifiable) {
      violations.push({
        spec: entry.file,
        target: expression,
        reason:
          'navigation target is not a static literal, so the page it lands on cannot be verified — inline the path',
      });
    }

    if (!entry.isSpec) continue;
    const reachable = reachableNavigation(entry, byFile);
    if (reachable.targets.length === 0 && !reachable.appRoot) {
      violations.push({
        spec: entry.file,
        target: '',
        reason:
          'spec has no recognised navigation target (directly or through a test/e2e helper) — it cannot be asserting against any page',
      });
    }
  }
  return violations;
}

/** Fixture pages that are built but no spec navigates to: dead build weight. */
export function findOrphanFixtures(
  scanned: readonly ScannedFile[] = readSpecTargets()
): string[] {
  const navigated = new Set(scanned.flatMap(({ targets }) => targets));
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
    `${violations.length} e2e navigation target(s) do not resolve (#1299).`,
    'A spec whose fixture page is missing, unbuilt, or dynamic is a no-op that reads like coverage.',
    'Fix by adding the page under frontend/ AND registering it in frontend/vite.config.ts,',
    'by inlining a static path in the goto() call,',
    'or by deleting the spec and noting the uncovered flow in docs/QUALITY.md.',
    '',
  ];
  for (const [spec, specViolations] of [...bySpec].sort()) {
    lines.push(`  ${spec}`);
    for (const { target, reason } of specViolations) {
      lines.push(`    -> ${target ? `${target}: ` : ''}${reason}`);
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

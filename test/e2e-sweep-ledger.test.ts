import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { listSpecFiles } from './e2e/fixture-targets.js';
import {
  countByGroup,
  frontendImportersOf,
  frontendModulesReachedBy,
  KEPT_SPEC_COUNT,
  NEVER_EXISTING_TARGET_SPECS,
  POST_SWEEP_SPEC_COUNT,
  REPO_ROOT,
  SWEPT_SPECS,
  type SweptSpec,
} from './e2e-sweep-ledger.js';

/**
 * #1299 review follow-up: the sweep's "why each spec was deleted" ledger was
 * prose, and three of its eighteen "already covered" claims were wrong — one
 * module no longer exists at all, and one credited suite `vi.mock`s the module
 * away. Prose cannot fail, so the ledger is data now and this is the check.
 */

const QUALITY_DOC = join(REPO_ROOT, 'docs', 'QUALITY.md');

function modulePath(entry: SweptSpec): string {
  if (!entry.module) throw new Error(`${entry.component} has no module`);
  return join(REPO_ROOT, entry.module);
}

const byGroup = (group: SweptSpec['group']): SweptSpec[] =>
  SWEPT_SPECS.filter((entry) => entry.group === group);

describe('#1299 sweep ledger', () => {
  it('has one entry per swept spec and no duplicates', () => {
    const names = SWEPT_SPECS.map((entry) => entry.component);
    expect(new Set(names).size).toBe(names.length);
    expect(SWEPT_SPECS).toHaveLength(58);
  });

  it('accounts for all 69 specs the audit started from', () => {
    // 11 kept + 57 with a target that never existed + CipherText, whose target
    // resolved but whose assertions raced a 300ms boot screen.
    expect(KEPT_SPEC_COUNT + SWEPT_SPECS.length).toBe(69);
    expect(SWEPT_SPECS.length - NEVER_EXISTING_TARGET_SPECS).toBe(1);
  });

  it('kept exactly the specs the ledger claims were kept', () => {
    expect(listSpecFiles()).toHaveLength(
      KEPT_SPEC_COUNT + POST_SWEEP_SPEC_COUNT
    );
  });

  it('never re-lists a component that still has a live e2e spec', () => {
    const live = new Set(
      listSpecFiles().map(
        (spec) =>
          spec
            .split('/')
            .pop()
            ?.replace(/\.spec\.tsx?$/, '') ?? ''
      )
    );
    const overlap = SWEPT_SPECS.map((entry) => entry.component).filter((name) =>
      live.has(name)
    );
    expect(overlap).toEqual([]);
  });
});

describe('#1299 sweep ledger — dead surface', () => {
  it('names only modules that are gone or have no importer left', () => {
    const wrong: string[] = [];
    for (const entry of byGroup('dead-surface')) {
      if (!entry.module) {
        // Claimed gone: prove no module of that name survives anywhere.
        const survivors = frontendImportersOf(
          join(REPO_ROOT, 'frontend', 'src', `${entry.component}.tsx`)
        );
        if (survivors.length > 0) wrong.push(`${entry.component}: still live`);
        continue;
      }
      if (!existsSync(modulePath(entry))) {
        wrong.push(`${entry.component}: module ${entry.module} does not exist`);
        continue;
      }
      const importers = frontendImportersOf(modulePath(entry));
      if (importers.length > 0) {
        wrong.push(
          `${entry.component}: still imported by ${importers.join(', ')} — not dead surface`
        );
      }
    }
    expect(wrong).toEqual([]);
  });

  it('does not claim a module that is missing from the tree', () => {
    for (const entry of byGroup('dead-surface')) {
      if (entry.module) expect(existsSync(modulePath(entry))).toBe(true);
    }
  });
});

describe('#1299 sweep ledger — covered elsewhere', () => {
  it('names live modules', () => {
    const wrong: string[] = [];
    for (const entry of byGroup('covered-elsewhere')) {
      if (!entry.module || !existsSync(modulePath(entry))) {
        wrong.push(`${entry.component}: module ${entry.module} does not exist`);
        continue;
      }
      if (frontendImportersOf(modulePath(entry)).length === 0) {
        wrong.push(
          `${entry.component}: no importer in frontend/src — this is dead surface, not covered surface`
        );
      }
    }
    expect(wrong).toEqual([]);
  });

  it('credits only vitest files that actually reach the module', () => {
    const wrong: string[] = [];
    for (const entry of byGroup('covered-elsewhere')) {
      const credits = entry.coveredBy ?? [];
      if (credits.length === 0) {
        wrong.push(`${entry.component}: no coveredBy entry`);
        continue;
      }
      for (const credit of credits) {
        const creditPath = join(REPO_ROOT, credit);
        if (!existsSync(creditPath)) {
          wrong.push(`${entry.component}: credited ${credit} does not exist`);
          continue;
        }
        const reached = frontendModulesReachedBy(creditPath);
        if (!reached.has(entry.module as string)) {
          wrong.push(
            `${entry.component}: ${credit} never reaches ${entry.module} (missing import, or the module is vi.mock'd away)`
          );
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  it('does not count the structural leaf-component migration test as coverage', () => {
    const structural = 'test/components/leaf-component-migration.test.ts';
    const offenders = SWEPT_SPECS.filter((entry) =>
      (entry.coveredBy ?? []).includes(structural)
    ).map((entry) => entry.component);
    // That suite asserts a file exists and exports the expected symbols. It
    // says nothing about behaviour, so it can never justify a deletion.
    expect(offenders).toEqual([]);
  });
});

describe('#1299 sweep ledger — recorded gaps', () => {
  it('names live modules with no credited coverage', () => {
    const wrong: string[] = [];
    for (const entry of byGroup('uncovered-gap')) {
      if (!entry.module || !existsSync(modulePath(entry))) {
        wrong.push(`${entry.component}: module ${entry.module} does not exist`);
        continue;
      }
      if (frontendImportersOf(modulePath(entry)).length === 0) {
        wrong.push(
          `${entry.component}: no importer in frontend/src — record it as dead surface, not a gap`
        );
      }
      if ((entry.coveredBy ?? []).length > 0) {
        wrong.push(`${entry.component}: has coveredBy but is filed as a gap`);
      }
    }
    expect(wrong).toEqual([]);
  });
});

describe('#1299 sweep ledger — docs/QUALITY.md stays in sync', () => {
  const doc = readFileSync(QUALITY_DOC, 'utf8');
  const counts = countByGroup();

  it('cites the ledger totals', () => {
    expect(doc).toContain(
      `**kept ${KEPT_SPEC_COUNT} / rewritten 0 / deleted ${SWEPT_SPECS.length}.**`
    );
    expect(doc).toContain(
      `${NEVER_EXISTING_TARGET_SPECS} of ${KEPT_SPEC_COUNT + SWEPT_SPECS.length} specs`
    );
  });

  it('cites each group count', () => {
    expect(doc).toContain(`Nothing to re-cover (${counts['dead-surface']}):`);
    expect(doc).toContain(
      `imports the same module (${counts['covered-elsewhere']}):`
    );
    expect(doc).toContain(
      `recorded here as a real gap (${counts['uncovered-gap']}):`
    );
  });

  it('names every ledger entry in the doc', () => {
    const missing = SWEPT_SPECS.map((entry) => entry.component).filter(
      (name) => !doc.includes(`\`${name}\``)
    );
    expect(missing).toEqual([]);
  });
});

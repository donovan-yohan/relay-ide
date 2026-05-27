import { describe, expect, it } from 'vitest';

import {
  getPromptFanoutRunFixture,
  promptFanoutRunFixtures,
  type PromptFanoutFixtureKey,
} from '../shared/prompt-fanout-fixtures.js';
import {
  PROMPT_FANOUT_RUN_SCHEMA_VERSION,
  promptFanoutHasPartialFailure,
  promptFanoutStatusCounts,
  selectedPromptFanoutTargets,
  unselectedPromptFanoutTargets,
  type PromptFanoutRun,
} from '../shared/prompt-fanout-run.js';

const expectedFixtures: PromptFanoutFixtureKey[] = [
  'all-success',
  'mixed-success-failure',
  'denied-target',
  'timeout',
  'empty-no-eligible-targets',
  'loading',
];

function assertSchema(run: PromptFanoutRun) {
  expect(run.schemaVersion).toBe(PROMPT_FANOUT_RUN_SCHEMA_VERSION);
  expect(run.id).toMatch(/^pfr:/);
  expect(run.workContextId).toMatch(/^wc:/);
  expect(run.prompt.id).toMatch(/^prompt:/);
  expect(run.prompt.dryRun).toBe(true);
  expect(Array.isArray(run.allTargets)).toBe(true);
  expect(Array.isArray(run.selectedTargetIds)).toBe(true);
  expect(Array.isArray(run.results)).toBe(true);
  expect(Array.isArray(run.errors)).toBe(true);
  expect(run.createdAt).toBeTruthy();
  expect(run.updatedAt).toBeTruthy();
}

describe('PromptFanoutRun fixtures', () => {
  it('exports every issue #705 acceptance fixture', () => {
    expect(Object.keys(promptFanoutRunFixtures).sort()).toEqual(
      [...expectedFixtures].sort()
    );
  });

  it('each fixture satisfies the shared run schema shape', () => {
    for (const key of expectedFixtures) {
      assertSchema(promptFanoutRunFixtures[key]);
    }
  });

  it('all-success fixture has selected targets but not every session selected', () => {
    const run = getPromptFanoutRunFixture('all-success');
    const selected = selectedPromptFanoutTargets(run);
    const unselected = unselectedPromptFanoutTargets(run);
    expect(selected.length).toBeGreaterThan(0);
    expect(unselected.length).toBeGreaterThan(0);
    expect(selected.length).toBeLessThan(run.allTargets.length);
    expect(run.results.every((result) => result.status === 'succeeded')).toBe(
      true
    );
  });

  it('mixed fixture reports partial failure', () => {
    const run = getPromptFanoutRunFixture('mixed-success-failure');
    expect(run.state).toBe('partial-failure');
    expect(promptFanoutHasPartialFailure(run)).toBe(true);
    const counts = promptFanoutStatusCounts(run);
    expect(counts.succeeded).toBe(1);
    expect(counts.failed).toBe(1);
  });

  it('denied fixture exposes target and run-level errors', () => {
    const run = getPromptFanoutRunFixture('denied-target');
    expect(run.state).toBe('denied');
    expect(run.errors.some((error) => error.code === 'TARGET_DENIED')).toBe(
      true
    );
    expect(
      run.results.some((result) => result.status === 'denied' && result.error)
    ).toBe(true);
  });

  it('timeout fixture exposes timeout status and retryable error', () => {
    const run = getPromptFanoutRunFixture('timeout');
    expect(run.state).toBe('timeout');
    expect(
      run.results.some(
        (result) => result.status === 'timeout' && result.error?.retryable
      )
    ).toBe(true);
  });

  it('empty fixture has no selected targets and no broadcast-to-all default', () => {
    const run = getPromptFanoutRunFixture('empty-no-eligible-targets');
    expect(run.state).toBe('empty');
    expect(selectedPromptFanoutTargets(run)).toHaveLength(0);
    expect(run.selectedTargetIds).toEqual([]);
    expect(run.allTargets.every((target) => !target.eligible)).toBe(true);
  });
});

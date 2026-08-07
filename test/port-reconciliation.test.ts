import { describe, expect, it, vi } from 'vitest';

import {
  createPortReconciliationWarningLogger,
  filterPortReconciliationRepoPaths,
} from '../server/port-reconciliation.js';

describe('filterPortReconciliationRepoPaths', () => {
  it('keeps only unique configured git repo paths', () => {
    const existing = new Set([
      '/repos/relay-ide/.git',
      '/repos/plugin/.git',
      '/repos/worktree/.git',
    ]);

    expect(
      filterPortReconciliationRepoPaths(
        [
          '/repos/relay-ide',
          '/repos',
          '/repos/plugin',
          '/repos/relay-ide',
          '   /repos/worktree   ',
          '',
        ],
        (candidate) => existing.has(candidate)
      )
    ).toEqual(['/repos/relay-ide', '/repos/plugin', '/repos/worktree']);
  });
});

describe('createPortReconciliationWarningLogger', () => {
  it('warns once per key without downgrading repeats into debug spam', () => {
    const warn = vi.fn();
    const logOnce = createPortReconciliationWarningLogger({ warn });

    logOnce('list:/repos', 'failed %s', '/repos');
    logOnce('list:/repos', 'failed %s', '/repos');
    logOnce('list:/repos/relay-ide', 'failed %s', '/repos/relay-ide');

    expect(warn.mock.calls).toEqual([
      ['failed %s', '/repos'],
      ['failed %s', '/repos/relay-ide'],
    ]);
  });

  it('does not clear the warning set and re-emit storms after the cap', () => {
    const warn = vi.fn();
    const logOnce = createPortReconciliationWarningLogger({ warn }, 2);

    logOnce('a', 'first');
    logOnce('b', 'second');
    logOnce('c', 'third');
    logOnce('d', 'fourth');
    logOnce('a', 'first again');

    expect(warn.mock.calls).toEqual([
      ['first'],
      ['second'],
      [
        'Suppressing additional port reconciliation warnings after %d unique keys.',
        2,
      ],
    ]);
  });
});

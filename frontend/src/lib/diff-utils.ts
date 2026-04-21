import type { DiffSource, FileChangeStatus } from './types.js';

export const statusIcon: Record<FileChangeStatus, string> = {
  added: '+',
  modified: '~',
  deleted: '-',
  renamed: '→',
  untracked: '?',
};

export const statusColor: Record<FileChangeStatus, string> = {
  added: 'var(--status-success)',
  modified: 'var(--status-warning)',
  deleted: 'var(--status-error)',
  renamed: 'var(--status-info)',
  untracked: 'var(--text-muted)',
};

export function diffSourceToBase(
  source: DiffSource,
  defaultBranch: string
): string | undefined {
  return source === 'staged'
    ? 'cached'
    : source === 'branch'
      ? defaultBranch
      : undefined;
}

import { test, describe, expect } from 'vitest';
import {
  buildChangedFilesTree,
  flattenVisibleNodes,
  findMostRecentlyChanged,
  parseLineReference,
  statusToBadge,
  statusToBadgeColor,
} from '../frontend/src/lib/file-tree-utils.js';
import type { ChangedFile } from '../frontend/src/lib/types.js';

describe('buildChangedFilesTree', () => {
  test('returns empty array for no files', () => {
    expect(buildChangedFilesTree([])).toEqual([]);
  });

  test('builds tree from flat file list', () => {
    const files: ChangedFile[] = [
      {
        path: 'src/index.ts',
        status: 'modified',
        additions: 5,
        deletions: 2,
        directory: 'src',
      },
      {
        path: 'src/utils.ts',
        status: 'added',
        additions: 10,
        deletions: 0,
        directory: 'src',
      },
    ];
    const tree = buildChangedFilesTree(files);
    expect(tree.length).toBe(1); // single "src" directory
    expect(tree[0]!.name).toBe('src');
    expect(tree[0]!.isDirectory).toBe(true);
    expect(tree[0]!.children.length).toBe(2);
    expect(tree[0]!.fileCount).toBe(2);
    expect(tree[0]!.additions).toBe(15);
    expect(tree[0]!.deletions).toBe(2);
  });

  test('collapses single-child directories', () => {
    const files: ChangedFile[] = [
      {
        path: 'a/b/c/file.ts',
        status: 'modified',
        additions: 1,
        deletions: 0,
        directory: 'a/b/c',
      },
    ];
    const tree = buildChangedFilesTree(files);
    // a/b/c should collapse into one node "a/b/c"
    expect(tree.length).toBe(1);
    expect(tree[0]!.name).toContain('a');
    expect(tree[0]!.name).toContain('c');
  });

  test('sorts directories before files', () => {
    const files: ChangedFile[] = [
      {
        path: 'z-file.ts',
        status: 'modified',
        additions: 1,
        deletions: 0,
        directory: '',
      },
      {
        path: 'a-dir/inner.ts',
        status: 'added',
        additions: 1,
        deletions: 0,
        directory: 'a-dir',
      },
    ];
    const tree = buildChangedFilesTree(files);
    expect(tree[0]!.isDirectory).toBe(true);
    expect(tree[1]!.isDirectory).toBe(false);
  });

  test('aggregates stats to parent directories', () => {
    const files: ChangedFile[] = [
      {
        path: 'src/a.ts',
        status: 'modified',
        additions: 3,
        deletions: 1,
        directory: 'src',
      },
      {
        path: 'src/b.ts',
        status: 'added',
        additions: 7,
        deletions: 0,
        directory: 'src',
      },
    ];
    const tree = buildChangedFilesTree(files);
    const srcNode = tree[0]!;
    expect(srcNode.additions).toBe(10);
    expect(srcNode.deletions).toBe(1);
    expect(srcNode.fileCount).toBe(2);
  });
});

describe('flattenVisibleNodes', () => {
  test('returns empty for empty tree', () => {
    expect(flattenVisibleNodes([])).toEqual([]);
  });

  test('flattens expanded directories', () => {
    const files: ChangedFile[] = [
      {
        path: 'src/index.ts',
        status: 'modified',
        additions: 1,
        deletions: 0,
        directory: 'src',
      },
    ];
    const tree = buildChangedFilesTree(files);
    const flat = flattenVisibleNodes(tree);
    expect(flat.length).toBe(2); // src dir + index.ts file
  });

  test('hides children of collapsed directories', () => {
    const files: ChangedFile[] = [
      {
        path: 'src/index.ts',
        status: 'modified',
        additions: 1,
        deletions: 0,
        directory: 'src',
      },
    ];
    const tree = buildChangedFilesTree(files);
    tree[0]!.expanded = false;
    const flat = flattenVisibleNodes(tree);
    expect(flat.length).toBe(1); // only src dir, child hidden
  });
});

describe('findMostRecentlyChanged', () => {
  test('returns new files not in previous set', () => {
    const prev = ['a.ts', 'b.ts'];
    const curr = ['a.ts', 'b.ts', 'c.ts'];
    expect(findMostRecentlyChanged(prev, curr)).toEqual(['c.ts']);
  });

  test('returns empty when no new files', () => {
    const prev = ['a.ts', 'b.ts'];
    const curr = ['a.ts', 'b.ts'];
    expect(findMostRecentlyChanged(prev, curr)).toEqual([]);
  });

  test('returns all files when previous is empty', () => {
    const result = findMostRecentlyChanged([], ['a.ts', 'b.ts']);
    expect(result).toEqual(['a.ts', 'b.ts']);
  });
});

describe('parseLineReference', () => {
  test('formats as backtick-wrapped filepath:linenum', () => {
    expect(parseLineReference('src/index.ts', 42)).toBe('`src/index.ts:42`');
  });
});

describe('statusToBadge', () => {
  test('maps all statuses to single characters', () => {
    expect(statusToBadge('added')).toBe('A');
    expect(statusToBadge('modified')).toBe('M');
    expect(statusToBadge('deleted')).toBe('D');
    expect(statusToBadge('renamed')).toBe('R');
    expect(statusToBadge('untracked')).toBe('?');
  });
});

describe('statusToBadgeColor', () => {
  test('maps all statuses to CSS variables', () => {
    expect(statusToBadgeColor('added')).toBe('var(--status-success)');
    expect(statusToBadgeColor('modified')).toBe('var(--status-warning)');
    expect(statusToBadgeColor('deleted')).toBe('var(--status-error)');
    expect(statusToBadgeColor('renamed')).toBe('var(--status-info)');
    expect(statusToBadgeColor('untracked')).toBe('var(--text-muted)');
  });
});

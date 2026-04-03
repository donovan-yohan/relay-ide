import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
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
    assert.deepStrictEqual(buildChangedFilesTree([]), []);
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
    assert.equal(tree.length, 1); // single "src" directory
    assert.equal(tree[0]!.name, 'src');
    assert.equal(tree[0]!.isDirectory, true);
    assert.equal(tree[0]!.children.length, 2);
    assert.equal(tree[0]!.fileCount, 2);
    assert.equal(tree[0]!.additions, 15);
    assert.equal(tree[0]!.deletions, 2);
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
    assert.equal(tree.length, 1);
    assert.ok(tree[0]!.name.includes('a'));
    assert.ok(tree[0]!.name.includes('c'));
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
    assert.equal(tree[0]!.isDirectory, true);
    assert.equal(tree[1]!.isDirectory, false);
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
    assert.equal(srcNode.additions, 10);
    assert.equal(srcNode.deletions, 1);
    assert.equal(srcNode.fileCount, 2);
  });
});

describe('flattenVisibleNodes', () => {
  test('returns empty for empty tree', () => {
    assert.deepStrictEqual(flattenVisibleNodes([]), []);
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
    assert.equal(flat.length, 2); // src dir + index.ts file
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
    assert.equal(flat.length, 1); // only src dir, child hidden
  });
});

describe('findMostRecentlyChanged', () => {
  test('returns new files not in previous set', () => {
    const prev = ['a.ts', 'b.ts'];
    const curr = ['a.ts', 'b.ts', 'c.ts'];
    assert.deepStrictEqual(findMostRecentlyChanged(prev, curr), ['c.ts']);
  });

  test('returns empty when no new files', () => {
    const prev = ['a.ts', 'b.ts'];
    const curr = ['a.ts', 'b.ts'];
    assert.deepStrictEqual(findMostRecentlyChanged(prev, curr), []);
  });

  test('returns all files when previous is empty', () => {
    const result = findMostRecentlyChanged([], ['a.ts', 'b.ts']);
    assert.deepStrictEqual(result, ['a.ts', 'b.ts']);
  });
});

describe('parseLineReference', () => {
  test('formats as backtick-wrapped filepath:linenum', () => {
    assert.equal(parseLineReference('src/index.ts', 42), '`src/index.ts:42`');
  });
});

describe('statusToBadge', () => {
  test('maps all statuses to single characters', () => {
    assert.equal(statusToBadge('added'), 'A');
    assert.equal(statusToBadge('modified'), 'M');
    assert.equal(statusToBadge('deleted'), 'D');
    assert.equal(statusToBadge('renamed'), 'R');
    assert.equal(statusToBadge('untracked'), '?');
  });
});

describe('statusToBadgeColor', () => {
  test('maps all statuses to CSS variables', () => {
    assert.equal(statusToBadgeColor('added'), 'var(--status-success)');
    assert.equal(statusToBadgeColor('modified'), 'var(--status-warning)');
    assert.equal(statusToBadgeColor('deleted'), 'var(--status-error)');
    assert.equal(statusToBadgeColor('renamed'), 'var(--status-info)');
    assert.equal(statusToBadgeColor('untracked'), 'var(--text-muted)');
  });
});

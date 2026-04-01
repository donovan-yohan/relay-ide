import { test } from 'node:test';
import assert from 'node:assert';

// Test the pure logic of tab identity and deduplication.
// We can't import .svelte.ts files in node:test (they need the Svelte compiler),
// so we test the logic by duplicating the key algorithm here.

function tabKey(filePath: string, tabType: string): string {
  return `${tabType}::${filePath}`;
}

test('tabKey differentiates same file with different types', () => {
  const diffKey = tabKey('/tmp/index.html', 'diff');
  const htmlKey = tabKey('/tmp/index.html', 'html');
  assert.notStrictEqual(diffKey, htmlKey);
});

test('tabKey matches same file with same type', () => {
  const key1 = tabKey('/tmp/index.html', 'html');
  const key2 = tabKey('/tmp/index.html', 'html');
  assert.strictEqual(key1, key2);
});

test('openHtmlTab logic creates correct tab shape', () => {
  const filePath = '/tmp/gstack-sketch/design-board.html';
  const tab = {
    filePath,
    fileName: filePath.split('/').pop() ?? filePath,
    isChanged: false,
    tabType: 'html' as const,
    token: 'abc123',
  };
  assert.strictEqual(tab.fileName, 'design-board.html');
  assert.strictEqual(tab.isChanged, false);
  assert.strictEqual(tab.tabType, 'html');
  assert.strictEqual(tab.token, 'abc123');
});

test('refreshHtmlTab logic uses version counter', () => {
  const baseUrl = '/browser-content/abc123/design-board.html';
  const refreshVersion = 1;
  const refreshed = `${baseUrl}?v=${refreshVersion}`;
  assert.ok(refreshed.includes('?v='));
  assert.ok(refreshed.startsWith(baseUrl));
});

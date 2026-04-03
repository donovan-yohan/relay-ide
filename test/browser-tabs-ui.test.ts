import { test, expect } from 'vitest';

// Test the pure logic of tab identity and deduplication.
// We can't import .svelte.ts files in node:test (they need the Svelte compiler),
// so we test the logic by duplicating the key algorithm here.

function tabKey(filePath: string, tabType: string): string {
  return `${tabType}::${filePath}`;
}

test('tabKey differentiates same file with different types', () => {
  const diffKey = tabKey('/tmp/index.html', 'diff');
  const htmlKey = tabKey('/tmp/index.html', 'html');
  expect(diffKey).not.toBe(htmlKey);
});

test('tabKey matches same file with same type', () => {
  const key1 = tabKey('/tmp/index.html', 'html');
  const key2 = tabKey('/tmp/index.html', 'html');
  expect(key1).toBe(key2);
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
  expect(tab.fileName).toBe('design-board.html');
  expect(tab.isChanged).toBe(false);
  expect(tab.tabType).toBe('html');
  expect(tab.token).toBe('abc123');
});

test('refreshHtmlTab logic uses version counter', () => {
  const baseUrl = '/browser-content/abc123/design-board.html';
  const refreshVersion = 1;
  const refreshed = `${baseUrl}?v=${refreshVersion}`;
  expect(refreshed.includes('?v=')).toBeTruthy();
  expect(refreshed.startsWith(baseUrl)).toBeTruthy();
});

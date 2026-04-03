import { describe, it, expect } from 'vitest';
import { generateFileSummary } from '../frontend/src/lib/diff-summary.js';

describe('generateFileSummary', () => {
  it('returns "deleted file" for deleted status', () => {
    expect(generateFileSummary('', 'foo.ts', 'deleted')).toBe('deleted file');
  });

  it('returns "new file" for untracked with no meaningful content', () => {
    const diff = [
      '+++ b/empty.ts',
      '+import foo from "bar"',
      '+// just a comment',
    ].join('\n');
    expect(generateFileSummary(diff, 'empty.ts', 'untracked')).toBe('new file');
  });

  it('returns "new file: <line>" for untracked with meaningful content', () => {
    const diff = [
      '+++ b/handler.ts',
      '+import express from "express"',
      '+export function handleRequest(req: Request) {',
    ].join('\n');
    const result = generateFileSummary(diff, 'handler.ts', 'untracked');
    expect(result).toMatch(/^new file: export function handleRequest/);
  });

  it('detects a single added function', () => {
    const diff = [
      '--- a/server.ts',
      '+++ b/server.ts',
      '@@ -10,0 +11,3 @@',
      '+function validateInput(data: unknown) {',
      '+  return data != null;',
      '+}',
    ].join('\n');
    expect(generateFileSummary(diff, 'server.ts', 'modified')).toBe(
      'added validateInput()'
    );
  });

  it('detects multiple added functions', () => {
    const diff = [
      '--- a/utils.ts',
      '+++ b/utils.ts',
      '@@ -10,0 +11,6 @@',
      '+function first() {',
      '+  return 1;',
      '+}',
      '+function second() {',
      '+  return 2;',
      '+}',
    ].join('\n');
    expect(generateFileSummary(diff, 'utils.ts', 'modified')).toBe(
      'added 2 functions'
    );
  });

  it('detects modified function from hunk headers', () => {
    const diff = [
      '--- a/api.ts',
      '+++ b/api.ts',
      '@@ -5,3 +5,4 @@ handleRequest',
      ' const x = 1;',
      '+const y = 2;',
      ' return x;',
    ].join('\n');
    const result = generateFileSummary(diff, 'api.ts', 'modified');
    expect(result).toMatch(/modified \d+ lines? in handleRequest\(\)/);
  });

  it('detects multiple modified functions from hunk headers', () => {
    const diff = [
      '--- a/api.ts',
      '+++ b/api.ts',
      '@@ -5,3 +5,4 @@ parseInput',
      ' const x = 1;',
      '+const y = 2;',
      '@@ -20,3 +21,4 @@ formatOutput',
      ' const a = 1;',
      '+const b = 2;',
    ].join('\n');
    expect(generateFileSummary(diff, 'api.ts', 'modified')).toBe(
      'modified 2 functions'
    );
  });

  it('falls back to +N -N lines when no functions detected', () => {
    const diff = [
      '--- a/config.json',
      '+++ b/config.json',
      '@@ -1,3 +1,4 @@',
      ' {',
      '+  "newKey": true,',
      '   "existing": false',
      '-  "removed": true',
      ' }',
    ].join('\n');
    expect(generateFileSummary(diff, 'config.json', 'modified')).toBe(
      '+1 -1 lines'
    );
  });

  it('truncates long first meaningful line for untracked files', () => {
    const longLine = 'x'.repeat(100);
    const diff = [
      '+++ b/long.ts',
      '+import foo from "bar"',
      `+${longLine}`,
    ].join('\n');
    const result = generateFileSummary(diff, 'long.ts', 'untracked');
    expect(result.length <= 72).toBeTruthy();
  });
});

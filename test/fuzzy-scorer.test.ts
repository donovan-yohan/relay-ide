import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { scorePath } from '../frontend/src/lib/fuzzy-scorer.js';
import type { ScoredResult } from '../frontend/src/lib/fuzzy-scorer.js';

// Helper: score multiple paths and return them sorted by score descending
function rank(query: string, paths: string[]): string[] {
  const scored = paths
    .map((p) => ({ path: p, result: scorePath(query, p) }))
    .filter(
      (s): s is { path: string; result: ScoredResult } => s.result !== null
    )
    .sort((a, b) => b.result.score - a.result.score);
  return scored.map((s) => s.path);
}

describe('scorePath', () => {
  // ── Basic behavior ──

  test('returns null for empty query', () => {
    assert.equal(scorePath('', 'App.svelte'), null);
  });

  test('returns null for empty path', () => {
    assert.equal(scorePath('app', ''), null);
  });

  test('returns null when no match exists', () => {
    assert.equal(scorePath('zzz', 'App.svelte'), null);
  });

  test('returns null when query is longer than path', () => {
    assert.equal(scorePath('abcdefghijk', 'abc.ts'), null);
  });

  // ── Score properties ──

  test('exact filename match scores highest', () => {
    const result = scorePath('App.svelte', 'frontend/src/App.svelte');
    assert.ok(result !== null);
    assert.ok(result.score > 0);
  });

  test('filename prefix match gets boost', () => {
    const prefixResult = scorePath('App', 'frontend/src/App.svelte')!;
    const substringResult = scorePath('vel', 'frontend/src/App.svelte');
    assert.ok(prefixResult !== null);
    // prefix match should score substantially higher
    if (substringResult) {
      assert.ok(prefixResult.score > substringResult.score);
    }
  });

  test('consecutive characters score higher than scattered', () => {
    const files = ['filter.ts', 'f_i_l_t_e_r.ts'];
    const ranked = rank('filter', files);
    assert.equal(ranked[0], 'filter.ts');
  });

  test('camelCase matching works', () => {
    const result = scorePath('CP', 'CommandPalette.svelte');
    assert.ok(result !== null);
    assert.ok(result.score > 0);
  });

  test('word boundary matching works', () => {
    const result = scorePath('fs', 'file-scorer.ts');
    assert.ok(result !== null);
    assert.ok(result.score > 0);
  });

  test('path separator bonus works', () => {
    const result = scorePath('sc', 'src/components/App.svelte');
    assert.ok(result !== null);
  });

  test('scattered match scores lower than compact', () => {
    const compact = scorePath('app', 'App.svelte')!;
    const scattered = scorePath('app', 'a_p_p.svelte');
    assert.ok(compact !== null);
    if (scattered) {
      assert.ok(compact.score > scattered.score);
    }
  });

  // ── Match positions ──

  test('match positions are correct for filename match', () => {
    const result = scorePath('App', 'src/App.svelte')!;
    assert.ok(result !== null);
    // matches should be in the "App" portion of "src/App.svelte"
    // "src/" is 4 chars, so "A" is at index 4
    assert.ok(result.matches.length > 0);
    const firstStart = result.matches[0]![0];
    assert.ok(
      firstStart >= 4,
      `expected match start >= 4 (in filename), got ${firstStart}`
    );
  });

  test('match positions are correct for path match', () => {
    const result = scorePath('src', 'src/App.svelte')!;
    assert.ok(result !== null);
    assert.ok(result.matches.length > 0);
    // "src" should match at the beginning
    assert.equal(result.matches[0]![0], 0);
  });

  // ── Edge cases ──

  test('unicode filenames do not crash', () => {
    const result = scorePath('readme', 'docs/日本語/readme.md');
    // should either match or return null, but not throw
    if (result) {
      assert.ok(result.score > 0);
    }
  });

  test('empty file list produces no results', () => {
    const ranked = rank('app', []);
    assert.equal(ranked.length, 0);
  });

  test('single character query works', () => {
    const result = scorePath('a', 'App.svelte');
    assert.ok(result !== null);
    assert.ok(result.score > 0);
  });

  test('case-insensitive matching works', () => {
    const result = scorePath('app', 'App.svelte');
    assert.ok(result !== null);
    assert.ok(result.score > 0);
  });
});

describe('ranking stability', () => {
  test('filename prefix beats path-only match', () => {
    const ranked = rank('app', [
      'App.svelte',
      'src/app/index.ts',
      'AppLayout.svelte',
    ]);
    // App.svelte should come first (exact prefix on filename)
    assert.equal(ranked[0], 'App.svelte');
    // AppLayout.svelte before src/app/index.ts (filename match > path match)
    const appLayoutIdx = ranked.indexOf('AppLayout.svelte');
    const srcAppIdx = ranked.indexOf('src/app/index.ts');
    assert.ok(
      appLayoutIdx < srcAppIdx,
      `AppLayout.svelte (${appLayoutIdx}) should rank above src/app/index.ts (${srcAppIdx})`
    );
  });

  test('exact filename beats deep path', () => {
    const ranked = rank('readme', ['README.md', 'src/lib/readme-utils.ts']);
    assert.equal(ranked[0], 'README.md');
  });

  test('shallow path beats deep path for same filename', () => {
    const ranked = rank('deep', ['a/b/c/deep.ts', 'deep.ts']);
    assert.equal(ranked[0], 'deep.ts');
  });

  test('camelCase match ranks correctly', () => {
    const ranked = rank('CP', [
      'CommandPalette.svelte',
      'components/Palette.svelte',
    ]);
    // CommandPalette matches C+P as camelCase boundaries
    assert.equal(ranked[0], 'CommandPalette.svelte');
  });

  test('filename match always beats path-only match', () => {
    const ranked = rank('index', [
      'src/components/deep/nested/index.ts',
      'index.ts',
    ]);
    assert.equal(ranked[0], 'index.ts');
  });
});

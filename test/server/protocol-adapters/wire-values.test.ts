import { describe, expect, it } from 'vitest';
import {
  diffCounts,
  isRecord,
  nowIso,
  numberOr,
  objectField,
  queueCount,
  safeJson,
  stringField,
} from '../../../server/protocol-adapters/wire-values.js';

/**
 * These helpers replaced hand-copied definitions in claude, codex-native,
 * pi-agent, prime-agent, and hermes. The cases below are the ones where the
 * copies COULD have disagreed — the edges that decide whether a shared
 * definition is a safe substitute — not a restatement of the happy path.
 */
describe('wire-values', () => {
  it('nowIso stamps an ISO-8601 UTC instant', () => {
    const stamp = nowIso();
    expect(stamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(new Date(stamp).toISOString()).toBe(stamp);
  });

  describe('isRecord', () => {
    it('accepts a plain object', () => {
      expect(isRecord({ a: 1 })).toBe(true);
      expect(isRecord(Object.create(null))).toBe(true);
    });

    it('rejects null, arrays, and primitives — the JSON shapes that lie', () => {
      // `typeof null === 'object'` is the trap every copy guarded against.
      expect(isRecord(null)).toBe(false);
      expect(isRecord([])).toBe(false);
      expect(isRecord([{ a: 1 }])).toBe(false);
      expect(isRecord(undefined)).toBe(false);
      expect(isRecord('')).toBe(false);
      expect(isRecord(0)).toBe(false);
      expect(isRecord(false)).toBe(false);
    });
  });

  describe('objectField', () => {
    it('passes a record through by identity, never a copy', () => {
      const source = { a: 1 };
      expect(objectField(source)).toBe(source);
    });

    it('substitutes {} for every non-record, including falsy ones', () => {
      // pi/prime spelled this `value && typeof value === 'object' && ...`;
      // claude spelled it `isRecord(value) ? value : {}`. Both must agree here.
      for (const value of [null, undefined, [], '', 0, false, NaN, 'x', 7]) {
        expect(objectField(value)).toEqual({});
      }
    });
  });

  describe('stringField', () => {
    it('returns the string, empty strings included', () => {
      expect(stringField('hello')).toBe('hello');
      expect(stringField('', 'fallback')).toBe('');
    });

    it('falls back to "" by default and to the argument when given', () => {
      expect(stringField(undefined)).toBe('');
      expect(stringField(42)).toBe('');
      expect(stringField(null, 'fallback')).toBe('fallback');
      expect(stringField({ toString: () => 'coerced' }, 'fallback')).toBe(
        'fallback'
      );
    });
  });

  describe('safeJson', () => {
    it('serializes ordinary values', () => {
      expect(safeJson({ a: 1 })).toBe('{"a":1}');
      expect(safeJson([1, 'two'])).toBe('[1,"two"]');
    });

    it('returns the marker instead of throwing on a cycle', () => {
      const cyclic: Record<string, unknown> = {};
      cyclic.self = cyclic;
      expect(safeJson(cyclic)).toBe('[unserializable]');
    });

    it('returns the marker instead of throwing on a BigInt', () => {
      expect(safeJson({ big: 1n })).toBe('[unserializable]');
    });
  });

  describe('numberOr', () => {
    it('accepts finite numbers including 0 and negatives', () => {
      expect(numberOr(0, 9)).toBe(0);
      expect(numberOr(-3.5, 9)).toBe(-3.5);
    });

    it('rejects NaN and Infinity, which JSON.parse can still produce via math', () => {
      expect(numberOr(NaN, 9)).toBe(9);
      expect(numberOr(Infinity, 9)).toBe(9);
      expect(numberOr(-Infinity, 9)).toBe(9);
    });

    it('rejects numeric strings — no coercion', () => {
      expect(numberOr('5', 9)).toBe(9);
    });
  });

  describe('queueCount', () => {
    it('is stricter than numberOr: safe non-negative integers only', () => {
      expect(queueCount(0)).toBe(0);
      expect(queueCount(3)).toBe(3);
      // These all reach a rendered queue depth, so they collapse to 0.
      expect(queueCount(-1)).toBe(0);
      expect(queueCount(1.5)).toBe(0);
      expect(queueCount(Number.MAX_SAFE_INTEGER + 2)).toBe(0);
      expect(queueCount(NaN)).toBe(0);
      expect(queueCount('3')).toBe(0);
      expect(queueCount(undefined)).toBe(0);
    });
  });

  describe('diffCounts', () => {
    it('counts content lines and skips +++/--- file headers', () => {
      const diff = [
        '--- a/file.ts',
        '+++ b/file.ts',
        '@@ -1,2 +1,2 @@',
        '-old line',
        '+new line',
        '+another added',
        ' context',
      ].join('\n');
      expect(diffCounts(diff)).toEqual({ additions: 2, deletions: 1 });
    });

    it('counts a bare +/- line and returns zeroes for an empty diff', () => {
      expect(diffCounts('+')).toEqual({ additions: 1, deletions: 0 });
      expect(diffCounts('-')).toEqual({ additions: 0, deletions: 1 });
      expect(diffCounts('')).toEqual({ additions: 0, deletions: 0 });
    });

    it('treats ++++ as content, matching the pre-extraction copies', () => {
      // `startsWith('+++')` excludes it, so a 4-plus line is NOT counted.
      // Both the codex and hermes copies behaved this way; pinning it here
      // stops a "tidier" rewrite from silently changing a rendered number.
      expect(diffCounts('++++')).toEqual({ additions: 0, deletions: 0 });
      expect(diffCounts('++')).toEqual({ additions: 1, deletions: 0 });
    });
  });
});

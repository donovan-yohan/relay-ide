import { describe, expect, it } from 'vitest';
import { renderInlineSkillTokens } from '../../frontend/src/components/chat/skillTokens.js';
import type { SkillTokenSegment } from '../../frontend/src/components/chat/skillTokens.js';

function makeIndex(...names: string[]): Set<string> {
  return new Set(names.map((n) => n.toLowerCase()));
}

function isToken(seg: string | SkillTokenSegment): seg is SkillTokenSegment {
  return typeof seg !== 'string';
}

describe('renderInlineSkillTokens', () => {
  it('plain text with no tokens returns single string segment', () => {
    const result = renderInlineSkillTokens('hello world', makeIndex('review'));
    expect(result).toEqual(['hello world']);
  });

  it('empty text returns single empty string segment', () => {
    const result = renderInlineSkillTokens('', makeIndex('review'));
    expect(result).toEqual(['']);
  });

  it('empty command index returns text as-is', () => {
    const result = renderInlineSkillTokens('/review some text', new Set());
    expect(result).toEqual(['/review some text']);
  });

  it('single $skill mid-text is segmented correctly', () => {
    const result = renderInlineSkillTokens('run $skill now', makeIndex('skill'));
    expect(result).toHaveLength(3);
    expect(result[0]).toBe('run ');
    expect(isToken(result[1]!)).toBe(true);
    expect((result[1] as SkillTokenSegment).text).toBe('$skill');
    expect((result[1] as SkillTokenSegment).prefix).toBe('$');
    expect(result[2]).toBe(' now');
  });

  it('single /skill at start is segmented correctly', () => {
    const result = renderInlineSkillTokens('/review some text', makeIndex('review'));
    expect(result).toHaveLength(2);
    expect(isToken(result[0]!)).toBe(true);
    expect((result[0] as SkillTokenSegment).text).toBe('/review');
    expect((result[0] as SkillTokenSegment).prefix).toBe('/');
    expect(result[1]).toBe(' some text');
  });

  it('$unknown (not in catalog) renders plain', () => {
    const result = renderInlineSkillTokens('hello $unknown world', makeIndex('review'));
    expect(result).toEqual(['hello $unknown world']);
  });

  it('/unknown not in catalog renders plain', () => {
    const result = renderInlineSkillTokens('/unknown', makeIndex('review'));
    expect(result).toEqual(['/unknown']);
  });

  it('multiple tokens in one string are all segmented', () => {
    const result = renderInlineSkillTokens('/review and $plan together', makeIndex('review', 'plan'));
    const tokens = result.filter(isToken) as SkillTokenSegment[];
    expect(tokens).toHaveLength(2);
    expect(tokens[0]!.text).toBe('/review');
    expect(tokens[1]!.text).toBe('$plan');
  });

  it('token at start of string', () => {
    const result = renderInlineSkillTokens('/skill', makeIndex('skill'));
    expect(result).toHaveLength(1);
    expect(isToken(result[0]!)).toBe(true);
    expect((result[0] as SkillTokenSegment).text).toBe('/skill');
  });

  it('token at end of string (after whitespace)', () => {
    const result = renderInlineSkillTokens('do /review', makeIndex('review'));
    expect(result[0]).toBe('do ');
    expect(isToken(result[1]!)).toBe(true);
    expect((result[1] as SkillTokenSegment).text).toBe('/review');
  });

  it('token adjacent to whitespace boundaries on both sides', () => {
    const result = renderInlineSkillTokens('a /skill b', makeIndex('skill'));
    const tokens = result.filter(isToken) as SkillTokenSegment[];
    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.text).toBe('/skill');
  });

  it('non-whitespace preceding token renders plain (e.g. url/path)', () => {
    const result = renderInlineSkillTokens('http://skill', makeIndex('skill'));
    // "//skill" - the second '/' is preceded by '/' which is not whitespace
    // so it won't be recognized as a valid token
    const tokens = result.filter(isToken);
    expect(tokens).toHaveLength(0);
  });

  it('token preceded by newline is recognized', () => {
    const result = renderInlineSkillTokens('intro\n/skill done', makeIndex('skill'));
    const tokens = result.filter(isToken) as SkillTokenSegment[];
    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.text).toBe('/skill');
  });

  it('token name is case-insensitive against index', () => {
    const result = renderInlineSkillTokens('/REVIEW text', makeIndex('review'));
    // The token regex matches /REVIEW, and we lowercase for lookup
    const tokens = result.filter(isToken);
    expect(tokens).toHaveLength(1);
  });

  it('mixed known and unknown tokens — only known are highlighted', () => {
    const result = renderInlineSkillTokens('/review $unknown /plan', makeIndex('review', 'plan'));
    const tokens = result.filter(isToken) as SkillTokenSegment[];
    expect(tokens).toHaveLength(2);
    expect(tokens[0]!.text).toBe('/review');
    expect(tokens[1]!.text).toBe('/plan');
    // $unknown is in the plain text parts
    const plains = result.filter((s) => typeof s === 'string');
    expect(plains.join('')).toContain('$unknown');
  });
});

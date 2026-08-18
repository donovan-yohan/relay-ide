import { describe, expect, it } from 'vitest';

import {
  CHANNEL_SEARCH_SCOPE_MAX_ALIASES,
  normalizeChannelSearchAlias,
  parseChannelSearchQuery,
} from '../shared/channel-search-query.js';

describe('channel search query grammar', () => {
  it('strips case-insensitive in: aliases before the FTS text', () => {
    expect(parseChannelSearchQuery('deployment IN:relay-ide error')).toEqual({
      text: 'deployment error',
      aliases: ['relay-ide'],
    });
  });

  it('preserves repeated scopes for conjunctive server resolution', () => {
    expect(
      parseChannelSearchQuery(
        'migration in:"Relay Project" details in:"Release Notes"'
      )
    ).toEqual({
      text: 'migration details',
      aliases: ['relay project', 'release notes'],
    });
  });

  it('accepts quoted aliases and escaped quote characters', () => {
    expect(
      parseChannelSearchQuery('"migration plan" in:"Release Notes"')
    ).toEqual({ text: '"migration plan"', aliases: ['release notes'] });
    expect(parseChannelSearchQuery('needle in:"A \\"quoted\\" room"')).toEqual({
      text: 'needle',
      aliases: ['a "quoted" room'],
    });
  });

  it('fails closed for incomplete, empty, or overlong scope clauses', () => {
    expect(parseChannelSearchQuery('needle in:')).toMatchObject({
      text: 'needle',
      invalidAlias: '',
    });
    expect(parseChannelSearchQuery('needle in:"unterminated')).toMatchObject({
      text: 'needle',
      invalidAlias: 'unterminated',
    });
    const scopes = Array.from(
      { length: CHANNEL_SEARCH_SCOPE_MAX_ALIASES + 1 },
      (_, index) => `in:scope-${index}`
    ).join(' ');
    expect(parseChannelSearchQuery(`needle ${scopes}`)).toMatchObject({
      text: 'needle',
      aliases: Array.from(
        { length: CHANNEL_SEARCH_SCOPE_MAX_ALIASES },
        (_, index) => `scope-${index}`
      ),
      invalidAlias: 'scope-8',
    });
  });

  it('normalizes only case, compatibility glyphs, and whitespace', () => {
    expect(normalizeChannelSearchAlias('  ＲＥＬＡＹ-ＩＤＥ  ')).toBe(
      'relay-ide'
    );
    expect(normalizeChannelSearchAlias('Release   Notes')).toBe(
      'release notes'
    );
  });
});

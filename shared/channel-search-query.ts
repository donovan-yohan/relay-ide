// Channel-search query grammar. This is intentionally separate from FTS query
// construction: `in:<alias>` is routing syntax, never transcript text.

export const CHANNEL_SEARCH_SCOPE_MAX_ALIASES = 8;

export interface ParsedChannelSearchQuery {
  /** Text sent to the FTS MATCH builder after scope directives are removed. */
  text: string;
  /** Exact human-readable aliases requested through `in:<alias>`. */
  aliases: string[];
  /** An incomplete/empty directive must fail closed rather than broaden. */
  invalidAlias?: string;
}

/**
 * Normalize a human-facing scope alias for exact, case-insensitive matching.
 *
 * Punctuation remains significant: `relay-ide` and `relay ide` are different
 * human aliases, which keeps the resolver deterministic and avoids treating a
 * typo as permission to search a broader project.
 */
export function normalizeChannelSearchAlias(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Parse Slack/Discord-like `in:<alias>` clauses out of search text.
 *
 * Scope clauses are whitespace-delimited. Quoted aliases support spaces and a
 * backslash escapes the following character, so `in:"Release Notes"` and
 * `in:"a \\"quoted\\" name"` remain one exact alias. Everything else remains
 * ordinary FTS input and is deliberately not given an operator language.
 */
export function parseChannelSearchQuery(raw: string): ParsedChannelSearchQuery {
  const aliases: string[] = [];
  const text: string[] = [];
  let cursor = 0;

  while (cursor < raw.length) {
    while (cursor < raw.length && /\s/.test(raw[cursor] ?? '')) cursor += 1;
    if (cursor >= raw.length) break;

    const tokenStart = cursor;
    const isScope = raw.slice(cursor, cursor + 3).toLowerCase() === 'in:';
    if (!isScope) {
      while (cursor < raw.length && !/\s/.test(raw[cursor] ?? '')) cursor += 1;
      text.push(raw.slice(tokenStart, cursor));
      continue;
    }

    cursor += 3;
    let alias = '';
    if (raw[cursor] === '"') {
      cursor += 1;
      let closed = false;
      while (cursor < raw.length) {
        const character = raw[cursor] ?? '';
        if (character === '\\' && cursor + 1 < raw.length) {
          alias += raw[cursor + 1] ?? '';
          cursor += 2;
          continue;
        }
        if (character === '"') {
          cursor += 1;
          closed = true;
          break;
        }
        alias += character;
        cursor += 1;
      }
      // `in:"foo"bar` is not two directives; accepting it would make the
      // scope depend on a parser ambiguity. Treat it as invalid and fail closed.
      if (!closed || (cursor < raw.length && !/\s/.test(raw[cursor] ?? ''))) {
        return { text: text.join(' ').trim(), aliases, invalidAlias: alias };
      }
    } else {
      while (cursor < raw.length && !/\s/.test(raw[cursor] ?? '')) {
        alias += raw[cursor] ?? '';
        cursor += 1;
      }
    }

    const normalized = normalizeChannelSearchAlias(alias);
    if (!normalized || aliases.length >= CHANNEL_SEARCH_SCOPE_MAX_ALIASES) {
      return { text: text.join(' ').trim(), aliases, invalidAlias: alias };
    }
    aliases.push(normalized);
  }

  return { text: text.join(' ').trim(), aliases };
}

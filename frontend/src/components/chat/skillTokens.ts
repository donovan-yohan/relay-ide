/** A resolved skill token segment. */
export interface SkillTokenSegment {
  kind: 'skillToken';
  text: string;
  prefix: '/' | '$';
}

/**
 * Segment `text` into plain strings and skill tokens.
 * Tokens are `/<name>` or `$<name>` that resolve against `commandIndex`.
 * Tokens that are not in the index are rendered as plain text.
 *
 * `commandIndex` is a Set of lowercased command names (without prefix chars).
 * Tokens must be preceded by start-of-string or whitespace to be recognized.
 */
export function renderInlineSkillTokens(
  text: string,
  commandIndex: Set<string>
): (string | SkillTokenSegment)[] {
  if (!text || commandIndex.size === 0) return [text];

  const result: (string | SkillTokenSegment)[] = [];
  const tokenRegex = /([/$])([A-Za-z0-9_-]+)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = tokenRegex.exec(text)) !== null) {
    const matchStart = match.index;
    const matchEnd = matchStart + match[0].length;
    const prefix = (match[1] ?? '/') as '/' | '$';
    const name = (match[2] ?? '').toLowerCase();

    // Validate boundary: must be preceded by whitespace, newline, or start-of-string
    const prevChar = matchStart > 0 ? text.charAt(matchStart - 1) : null;
    if (prevChar !== null && !/\s/.test(prevChar)) {
      continue;
    }

    // Check if name is in catalog
    if (!commandIndex.has(name)) continue;

    // Push any plain text before this match
    if (matchStart > lastIndex) {
      result.push(text.slice(lastIndex, matchStart));
    }

    result.push({ kind: 'skillToken', text: match[0], prefix });
    lastIndex = matchEnd;
  }

  // Push remaining plain text
  if (lastIndex < text.length) {
    result.push(text.slice(lastIndex));
  }

  if (result.length === 0) return [text];

  return result;
}

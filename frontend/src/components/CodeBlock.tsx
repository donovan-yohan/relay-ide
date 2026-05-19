import { useShikiHighlight } from '../hooks/useShikiHighlight.js';
import './CodeBlock.css';

export interface CodeBlockProps {
  code: string;
  language?: string;
  showLineNumbers?: boolean;
  startLine?: number;
  /**
   * Stable key for GC cache tracking. Callers should provide an explicit,
   * semantically meaningful key (e.g. `"${workspacePath}:${filePath}"`).
   *
   * When omitted, a DJB2 hash of the full code + language is used as the
   * default. This avoids the collision risk of the first-64-char prefix for
   * code blocks that share a common header (imports, boilerplate, etc.).
   *
   * Note: if two distinct code blocks hash to the same value, the second
   * block will reuse the first's cached highlight output. Provide an explicit
   * key to guarantee isolation.
   */
  cacheKey?: string;
}

/**
 * DJB2 hash — fast, good distribution, no dependencies.
 * Returns a hex string.
 */
function djb2Hash(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
    hash = hash >>> 0; // keep as uint32
  }
  return hash.toString(16);
}

export function CodeBlock({
  code,
  language = 'text',
  showLineNumbers = true,
  startLine = 1,
  cacheKey,
}: CodeBlockProps) {
  const key = cacheKey ?? `${language}:${djb2Hash(language + ':' + code)}`;
  const { tokens } = useShikiHighlight(key, code, language);
  const error = false;

  if (tokens) {
    return (
      <div className="code-block">
        <pre>
          <code>
            {tokens.map((line, i) => (
              <span key={i} className="line">
                {showLineNumbers && (
                  <span className="line-number">{startLine + i}</span>
                )}
                {line.map((token, j) => (
                  <span key={j} style={{ color: token.color ?? '#e0e0e0' }}>
                    {token.content}
                  </span>
                ))}
              </span>
            ))}
          </code>
        </pre>
      </div>
    );
  }

  if (error) {
    return (
      <div className="code-block">
        <pre className="fallback">
          <code>{code}</code>
        </pre>
      </div>
    );
  }

  return (
    <div className="code-block">
      <pre className="loading">
        <code>{code}</code>
      </pre>
    </div>
  );
}

export default CodeBlock;

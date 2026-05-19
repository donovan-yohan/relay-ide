import { useShikiHighlight } from '../hooks/useShikiHighlight.js';
import './CodeBlock.css';

export interface CodeBlockProps {
  code: string;
  language?: string;
  showLineNumbers?: boolean;
  startLine?: number;
  /** Stable key for GC tracking. Defaults to a hash of code+language. */
  cacheKey?: string;
}

export function CodeBlock({
  code,
  language = 'text',
  showLineNumbers = true,
  startLine = 1,
  cacheKey,
}: CodeBlockProps) {
  const key = cacheKey ?? `${language}:${code.slice(0, 64)}`;
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

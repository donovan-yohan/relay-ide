import { useState, useEffect } from 'react';
import { tokenizeCode, type ThemedToken } from '../lib/shiki.js';
import './CodeBlock.css';

export interface CodeBlockProps {
  code: string;
  language?: string;
  showLineNumbers?: boolean;
  startLine?: number;
}

export function CodeBlock({
  code,
  language = 'text',
  showLineNumbers = true,
  startLine = 1,
}: CodeBlockProps) {
  const [tokens, setTokens] = useState<ThemedToken[][] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setError(false);
    setTokens(null);

    tokenizeCode(code, language)
      .then((t) => {
        if (!cancelled) {
          setTokens(t);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setError(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [code, language]);

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
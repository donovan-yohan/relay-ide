import { useEffect, useRef, useState } from 'react';
import { tokenizeCode, type ThemedToken } from './shiki';

export interface UseShikiHighlightResult {
  tokens: ThemedToken[][] | null;
  highlighting: boolean;
}

export function useShikiHighlight(
  key: string,
  code: string,
  language: string
): UseShikiHighlightResult {
  const [tokens, setTokens] = useState<ThemedToken[][] | null>(null);
  const [highlighting, setHighlighting] = useState(false);
  const genRef = useRef(0);

  useEffect(() => {
    if (!code) {
      setTokens(null);
      setHighlighting(false);
      return;
    }

    const gen = ++genRef.current;
    setHighlighting(true);

    tokenizeCode(code, language)
      .then((res) => {
        if (genRef.current === gen) {
          setTokens(res);
          setHighlighting(false);
        }
      })
      .catch(() => {
        if (genRef.current === gen) {
          let currentOffset = 0;
          setTokens(
            code.split('\n').map((l) => {
              const token = { content: l, offset: currentOffset };
              currentOffset += l.length + 1;
              return [token as any];
            })
          );
          setHighlighting(false);
        }
      });
  }, [key, code, language]);

  return { tokens, highlighting };
}

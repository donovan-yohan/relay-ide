import React, { useState, useEffect, useRef } from 'react';

const GLYPHS = '!@#$%^&*()_+-=[]{}|;:,.<>?/~`0123456789abcdef';

interface CipherTextProps {
  text: string;
  loading?: boolean;
  duration?: number;
}

function randomGlyph(): string {
  return GLYPHS[Math.floor(Math.random() * GLYPHS.length)] as string;
}

export function CipherText({ text, loading = false, duration = 400 }: CipherTextProps) {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);
  const [displayed, setDisplayed] = useState<string[]>([]);
  const [isAnimating, setIsAnimating] = useState(false);
  const intervalIdRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const timeoutsRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  // Setup prefers-reduced-motion listener
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setPrefersReducedMotion(mq.matches);

    const handler = (e: MediaQueryListEvent) => {
      setPrefersReducedMotion(e.matches);
    };

    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  // Main animation effect
  useEffect(() => {
    // Cleanup function
    const cleanup = () => {
      if (intervalIdRef.current !== undefined) {
        clearInterval(intervalIdRef.current);
        intervalIdRef.current = undefined;
      }
      for (const t of timeoutsRef.current) {
        clearTimeout(t);
      }
      timeoutsRef.current = [];
    };

    if (prefersReducedMotion) {
      setDisplayed(text.split(''));
      setIsAnimating(false);
      return cleanup;
    }

    if (loading) {
      // Cycle random glyphs matching text.length
      const len = text.length;
      setDisplayed(Array.from({ length: len }, () => randomGlyph()));
      setIsAnimating(true);

      intervalIdRef.current = setInterval(() => {
        setDisplayed(Array.from({ length: len }, () => randomGlyph()));
      }, 40);
    } else {
      // Resolve characters left-to-right
      const target = text.split('');
      const len = target.length;

      // Ensure displayed array has correct length (filled with glyphs)
      setDisplayed((prev) => {
        if (prev.length !== len) {
          return Array.from({ length: len }, () => randomGlyph());
        }
        return prev;
      });

      setIsAnimating(true);
      const msPerChar = Math.max(1, Math.round(duration / Math.max(len, 1)));

      for (let i = 0; i < len; i++) {
        const idx = i;
        const t = setTimeout(() => {
          setDisplayed((prev) => {
            const next = [...prev];
            next[idx] = target[idx] as string;
            return next;
          });
          if (idx === len - 1) {
            setIsAnimating(false);
          }
        }, idx * msPerChar);
        timeoutsRef.current.push(t);
      }
    }

    return cleanup;
  }, [text, loading, duration, prefersReducedMotion]);

  return (
    <span aria-live="polite" className="cipher-text">
      {isAnimating || loading ? displayed.join('') : text}
    </span>
  );
}

export default CipherText;
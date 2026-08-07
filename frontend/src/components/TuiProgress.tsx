import React, { useEffect, useMemo, useRef, useState } from 'react';
import './TuiProgress.css';

const BRAILLE_FRAMES = ['\u280B', '\u2819', '\u2839', '\u2838', '\u283C', '\u2834', '\u2826', '\u2827', '\u2807', '\u280F'];
const LINE_FRAMES = ['|', '/', '-', '\\'];
const KNIGHT_WIDTH = 4;

export interface TuiProgressProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: 'bar' | 'knight-rider' | 'braille' | 'line';
  value?: number;
  width?: number;
}

export function TuiProgress({
  variant = 'braille',
  value = 0,
  width = 16,
  className = '',
  ...rest
}: TuiProgressProps) {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);
  const [frame, setFrame] = useState(0);
  const [knightPos, setKnightPos] = useState(0);
  const knightPosRef = useRef(0);
  const knightDirRef = useRef(1);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setPrefersReducedMotion(mq.matches);

    const handler = (event: MediaQueryListEvent) => {
      setPrefersReducedMotion(event.matches);
    };

    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  useEffect(() => {
    if (variant !== 'braille' || prefersReducedMotion) return;

    const id = window.setInterval(() => {
      setFrame((current) => (current + 1) % BRAILLE_FRAMES.length);
    }, 80);

    return () => window.clearInterval(id);
  }, [variant, prefersReducedMotion]);

  useEffect(() => {
    if (variant !== 'line' || prefersReducedMotion) return;

    const id = window.setInterval(() => {
      setFrame((current) => (current + 1) % LINE_FRAMES.length);
    }, 120);

    return () => window.clearInterval(id);
  }, [variant, prefersReducedMotion]);

  useEffect(() => {
    if (variant !== 'knight-rider' || prefersReducedMotion) return;

    knightPosRef.current = 0;
    knightDirRef.current = 1;
    setKnightPos(0);

    const id = window.setInterval(() => {
      let next = knightPosRef.current + knightDirRef.current;

      if (next >= width - KNIGHT_WIDTH) {
        next = Math.max(0, width - KNIGHT_WIDTH);
        knightDirRef.current = -1;
      } else if (next <= 0) {
        next = 0;
        knightDirRef.current = 1;
      }

      knightPosRef.current = next;
      setKnightPos(next);
    }, 60);

    return () => window.clearInterval(id);
  }, [variant, prefersReducedMotion, width]);

  const barText = useMemo(() => {
    if (variant !== 'bar') return '';

    const clamped = Math.max(0, Math.min(100, value));
    const filled = Math.round((clamped / 100) * width);
    const empty = width - filled;

    return `[${'█'.repeat(filled)}${'░'.repeat(empty)}] ${Math.round(clamped)}%`;
  }, [variant, value, width]);

  const knightText = useMemo(() => {
    if (variant !== 'knight-rider') return '';

    const pos = prefersReducedMotion ? 0 : knightPos;
    const before = '░'.repeat(pos);
    const block = '█'.repeat(KNIGHT_WIDTH);
    const after = '░'.repeat(Math.max(0, width - pos - KNIGHT_WIDTH));

    return `[${before}${block}${after}]`;
  }, [variant, prefersReducedMotion, knightPos, width]);

  const brailleChar = prefersReducedMotion ? BRAILLE_FRAMES[0] : BRAILLE_FRAMES[frame];
  const lineChar = prefersReducedMotion ? LINE_FRAMES[0] : LINE_FRAMES[frame];

  const content =
    variant === 'bar'
      ? barText
      : variant === 'knight-rider'
        ? knightText
        : variant === 'braille'
          ? brailleChar
          : lineChar;

  const classes = ['tui-progress', className].filter(Boolean).join(' ');

  return (
    <span {...rest} className={classes} role="status" aria-label="loading">
      {content}
    </span>
  );
}

export default TuiProgress;

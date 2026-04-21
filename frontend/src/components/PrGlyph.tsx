import type { PrDotStatus } from '../lib/pr-status';
import { prGlyph } from '../lib/pr-status';
import './PrGlyph.css';

interface PrGlyphProps {
  status: PrDotStatus;
}

export function PrGlyph({ status }: PrGlyphProps) {
  const glyph = prGlyph(status);
  
  return (
    <span
      className={`pr-glyph ${glyph.colorClass}`}
      role="img"
      aria-label={glyph.label}
      title={glyph.label}
    >
      {glyph.char}
    </span>
  );
}
import React, { useRef, useState, useEffect, useCallback } from 'react';
import './MarqueeText.css';

export interface MarqueeTextProps {
  /** Animation speed in pixels per second */
  speed?: number;
  /** Width of the fade effect on the right edge in pixels */
  fadeWidth?: number;
  /** Extra scroll distance beyond the overflow in pixels */
  overscroll?: number;
  /** The content to display */
  children: React.ReactNode;
}

/**
 * MarqueeText component that reveals overflow content on hover.
 * 
 * When the content overflows the container, hovering will animate
 * the content to reveal the hidden portion with a smooth transition.
 */
export function MarqueeText({
  speed = 50,
  fadeWidth = 24,
  overscroll = 32,
  children,
}: MarqueeTextProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState(0);

  useEffect(() => {
    const containerEl = containerRef.current;
    const innerEl = innerRef.current;
    if (!containerEl || !innerEl) return;

    const observer = new ResizeObserver(() => {
      if (containerEl && innerEl) {
        const newOverflow = Math.max(0, innerEl.scrollWidth - containerEl.clientWidth);
        setOverflow(newOverflow);
      }
    });

    observer.observe(containerEl);
    observer.observe(innerEl);

    return () => observer.disconnect();
  }, []);

  const handleMouseEnter = useCallback(() => {
    const innerEl = innerRef.current;
    if (!innerEl || overflow <= 0) return;

    const distance = overflow + overscroll;
    const durationSec = distance / speed;
    innerEl.style.transition = `transform ${durationSec}s ease-in-out`;
    innerEl.style.transform = `translateX(-${distance}px)`;
  }, [overflow, overscroll, speed]);

  const handleMouseLeave = useCallback(() => {
    const innerEl = innerRef.current;
    if (!innerEl || overflow <= 0) return;

    const durationSec = (overflow + overscroll) / speed;
    innerEl.style.transition = `transform ${durationSec}s ease-in-out`;
    innerEl.style.transform = 'translateX(0)';
  }, [overflow, overscroll, speed]);

  const hasOverflow = overflow > 0;

  return (
    <div
      ref={containerRef}
      className="marquee-container"
      style={{
        '--fade-width': `${fadeWidth}px`,
        '--has-overflow': hasOverflow ? '1' : '0',
      } as React.CSSProperties}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <div ref={innerRef} className="marquee-inner">
        {children}
      </div>
    </div>
  );
}

export default MarqueeText;
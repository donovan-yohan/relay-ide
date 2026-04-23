import { useEffect } from 'react';
import type { RefObject } from 'react';

function useClickOutside(
  ref: RefObject<HTMLElement | null>,
  handler: () => void,
  enabled: boolean
): void {
  useEffect(() => {
    if (!enabled) return;
    const handleWindowClick = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (target && ref.current && document.contains(target) && !ref.current.contains(target)) {
        handler();
      }
    };
    window.addEventListener('click', handleWindowClick);
    return () => window.removeEventListener('click', handleWindowClick);
  }, [ref, handler, enabled]);
}

export default useClickOutside;

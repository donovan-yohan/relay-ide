import { useRef, useState, useCallback, useEffect } from 'react';

/** Returns a ref + hasOverflow boolean for detecting when a container's content exceeds its visible height. */
export function useScrollOverflow() {
  const ref = useRef<HTMLElement>(null);
  const [hasOverflow, setHasOverflow] = useState(false);

  const check = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    setHasOverflow(el.scrollHeight > el.clientHeight + 4);
  }, []);

  useEffect(() => {
    check();
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [check]);

  return { ref, hasOverflow };
}

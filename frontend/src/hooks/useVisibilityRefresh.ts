import { useEffect } from 'react';
import {
  DEFAULT_ENRICHMENT_TTL_MS,
  useSessionsStore,
} from '../lib/stores/sessions.js';

function isVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState === 'visible';
}

export function useVisibilityRefresh(authAuthenticated: boolean): void {
  useEffect(() => {
    if (!authAuthenticated || typeof document === 'undefined') return;

    const handleVisibilityChange = () => {
      if (!isVisible()) return;
      void useSessionsStore
        .getState()
        .ensureFreshAll(DEFAULT_ENRICHMENT_TTL_MS);
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [authAuthenticated]);
}

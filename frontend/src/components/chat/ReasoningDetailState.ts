import { useMemo } from 'react';

export type ReasoningDetailPresentation = 'collapsed' | 'expanded';

export interface ReasoningDetailStateApi {
  readonly scopeKey: string;
  get: (itemId: string) => ReasoningDetailPresentation | undefined;
  set: (itemId: string, value: ReasoningDetailPresentation) => void;
}

const fallbackOverrides = new Map<string, ReasoningDetailPresentation>();
export const fallbackReasoningDetailState: ReasoningDetailStateApi = {
  scopeKey: 'fallback',
  get: (itemId) => fallbackOverrides.get(itemId),
  set: (itemId, value) => fallbackOverrides.set(itemId, value),
};

/**
 * Keeps manual disclosure choices outside grouped rows, whose reconciliation
 * can remount while history streams or prepends. The map is scoped to one
 * mounted timeline/thread view and resets when that view's scope changes.
 */
export function useReasoningDetailStateScope(
  scopeKey: string
): ReasoningDetailStateApi {
  return useMemo(() => {
    const overrides = new Map<string, ReasoningDetailPresentation>();
    return {
      scopeKey,
      get: (itemId) => overrides.get(itemId),
      set: (itemId, value) => overrides.set(itemId, value),
    };
  }, [scopeKey]);
}

/** Isolated component tests render without a timeline-owned state map. */
export function resetFallbackReasoningDetailStateForTests(): void {
  fallbackOverrides.clear();
}

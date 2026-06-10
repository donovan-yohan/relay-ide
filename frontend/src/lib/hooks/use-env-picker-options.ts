// use-env-picker-options (#862) — derives the canonical `EnvironmentOption[]`
// list the command-palette / empty-state env picker consumes, replacing the
// #630 `reposToEnvironmentOptions` stopgap with the single shared read model
// (`buildEnvironmentOptions`, #629).
//
// Why a hook (not an inline `useMemo` in App): the option list needs the
// `['hub-nodes']` and `['repo-inventory']` TanStack queries, and those `useQuery`
// calls must run INSIDE the `<QueryClientProvider>` boundary. App renders that
// provider in its own return, so any `useQuery` in App's body would sit outside
// it. Pushing the queries into this hook lets a small wrapper component call it
// from inside the provider while reusing the exact same query keys the rest of
// the app already populates (no extra network calls — TanStack dedups).
//
// `generatedAt` stability is CRITICAL: it is bound to the inventory snapshot
// timestamp (`inventory.generatedAt`) and falls back to a fixed epoch marker
// when inventory has not loaded yet — never `new Date().toISOString()`. A fresh
// per-render timestamp would re-stamp every option, break the options array's
// reference equality, and re-fire `EnvPickerDialog`'s default-selection effect
// on unrelated rerenders (Gemini PR #646/#647 feedback). The whole derivation
// is a keyed `useMemo` so the array identity is stable while its inputs are.

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';

import { fetchHubNodes, fetchRepoInventory } from '../api.js';
import {
  buildEnvironmentOptions,
  type BuildEnvironmentOptionsInput,
} from '../environment-options.js';
import type { EnvironmentOption } from '../../../../shared/environment-option.js';
import type { AgentType } from '../types.js';

/**
 * Stable `generatedAt` used before any inventory snapshot has loaded. A fixed
 * epoch keeps the derived options referentially stable across renders while
 * still satisfying `isEnvironmentOption` (which requires a non-empty string).
 * Mirrors `PICKER_FALLBACK_GENERATED_AT` in `CustomizeSessionDialog`.
 */
export const ENV_PICKER_FALLBACK_GENERATED_AT = '1970-01-01T00:00:00.000Z';

export interface UseEnvPickerOptionsInput {
  /** Agent the picker should gate capability-missing reasons against. */
  selectedAgent: AgentType;
  /**
   * Fallback when inventory is empty / hasn't surfaced the active workspace —
   * typically the active workspace. `null`/`undefined` is fine: with no
   * inventory and no fallback the picker still surfaces a synthetic local node
   * free-cwd option so a bare shell launch is always reachable.
   */
  fallbackWorkspace?: BuildEnvironmentOptionsInput['fallbackWorkspace'];
  fallbackWorktreePath?: BuildEnvironmentOptionsInput['fallbackWorktreePath'];
}

/**
 * Derive the env-picker option list from the shared `['hub-nodes']` +
 * `['repo-inventory']` queries. Terminal MVP (#862): callers launch with
 * `launchOverrides={{ type: 'terminal' }}`, so `sessionType` is fixed to
 * `'terminal'` here (agent provider gating is #863's scope).
 */
export function useEnvPickerOptions(
  input: UseEnvPickerOptionsInput
): EnvironmentOption[] {
  // Reuse the existing query keys so TanStack serves the shared cache — these
  // are the same keys the dashboard / dialogs / view-spine already warm, kept
  // fresh by `useEventSocket`'s `node.status` handler for `['hub-nodes']`.
  const nodesQuery = useQuery({
    queryKey: ['hub-nodes'],
    queryFn: fetchHubNodes,
    staleTime: 60_000,
  });
  const inventoryQuery = useQuery({
    queryKey: ['repo-inventory'],
    queryFn: fetchRepoInventory,
    staleTime: 60_000,
  });

  const nodes = nodesQuery.data;
  const inventory = inventoryQuery.data;
  const { selectedAgent, fallbackWorkspace, fallbackWorktreePath } = input;

  return useMemo(
    () =>
      buildEnvironmentOptions({
        inventory: inventory ?? null,
        nodes: nodes ?? [],
        selectedAgent,
        sessionType: 'terminal',
        ...(fallbackWorkspace !== undefined ? { fallbackWorkspace } : {}),
        ...(fallbackWorktreePath !== undefined ? { fallbackWorktreePath } : {}),
        // Bind to the inventory snapshot time so options refresh in lockstep
        // with inventory; before it loads use a fixed epoch (never `new Date()`
        // — that would mint a fresh stamp every render and break the options
        // array's reference equality, re-firing the dialog's default-selection
        // effect). See file header.
        generatedAt: inventory?.generatedAt ?? ENV_PICKER_FALLBACK_GENERATED_AT,
      }),
    [
      inventory,
      nodes,
      selectedAgent,
      fallbackWorkspace,
      fallbackWorktreePath,
    ]
  );
}

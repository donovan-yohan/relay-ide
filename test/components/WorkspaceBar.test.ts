// @vitest-environment happy-dom

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import type { IaWorkspace } from '../../frontend/src/lib/api.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type MutationStub = {
  isPending: boolean;
  mutate: ReturnType<typeof vi.fn>;
  mutateAsync: ReturnType<typeof vi.fn>;
};

type WorkspaceHookState = {
  workspaces: IaWorkspace[];
  isLoading: boolean;
  isFetching: boolean;
  isError: boolean;
  refetch: ReturnType<typeof vi.fn>;
  invalidate: ReturnType<typeof vi.fn>;
  createMutation: MutationStub;
  updateMutation: MutationStub;
  archiveMutation: MutationStub;
};

const mockState = vi.hoisted(() => ({
  activeWorkspaceId: null as string | null,
  setActiveWorkspaceId: vi.fn(),
  workspaceHook: null as WorkspaceHookState | null,
}));

vi.mock('../../frontend/src/lib/hooks/use-ia-workspaces.js', () => ({
  useIaWorkspaces: () => {
    if (!mockState.workspaceHook) {
      throw new Error('workspace hook mock not configured');
    }
    return mockState.workspaceHook;
  },
}));

vi.mock('../../frontend/src/lib/stores/ui.js', () => ({
  useUiStore: <T>(
    selector: (state: {
      activeWorkspaceId: string | null;
      setActiveWorkspaceId: (id: string | null) => void;
    }) => T
  ) =>
    selector({
      activeWorkspaceId: mockState.activeWorkspaceId,
      setActiveWorkspaceId: mockState.setActiveWorkspaceId,
    }),
}));

const { WorkspaceBar } =
  await import('../../frontend/src/components/WorkspaceBar.js');

function workspace(id: string, order: number): IaWorkspace {
  return {
    id,
    name: `workspace ${id}`,
    status: 'active',
    order,
    projectIds: [],
    pinned: true,
    color: null,
    icon: null,
    defaultRepoPath: null,
    defaultNodeId: null,
    defaultProvider: null,
    createdAt: '2026-06-28T00:00:00.000Z',
    updatedAt: '2026-06-28T00:00:00.000Z',
  };
}

function mutationStub(): MutationStub {
  return { isPending: false, mutate: vi.fn(), mutateAsync: vi.fn() };
}

function configureHook(overrides: Partial<WorkspaceHookState>) {
  mockState.workspaceHook = {
    workspaces: [],
    isLoading: false,
    isFetching: false,
    isError: false,
    refetch: vi.fn(),
    invalidate: vi.fn(),
    createMutation: mutationStub(),
    updateMutation: mutationStub(),
    archiveMutation: mutationStub(),
    ...overrides,
  };
}

describe('<WorkspaceBar /> active workspace reconciliation', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mockState.activeWorkspaceId = null;
    mockState.setActiveWorkspaceId.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    mockState.workspaceHook = null;
  });

  it('does not clear a selected workspace while the authoritative list is refetching', () => {
    mockState.activeWorkspaceId = 'created-workspace';
    configureHook({
      workspaces: [workspace('old-workspace', 1)],
      isFetching: true,
    });

    act(() => {
      root.render(React.createElement(WorkspaceBar));
    });

    expect(mockState.setActiveWorkspaceId).not.toHaveBeenCalledWith(null);
  });

  it('clears a stale selected workspace after the active workspace list is idle', () => {
    mockState.activeWorkspaceId = 'missing-workspace';
    configureHook({
      workspaces: [workspace('kept-workspace', 1)],
      isFetching: false,
    });

    act(() => {
      root.render(React.createElement(WorkspaceBar));
    });

    expect(mockState.setActiveWorkspaceId).toHaveBeenCalledWith(null);
  });
});

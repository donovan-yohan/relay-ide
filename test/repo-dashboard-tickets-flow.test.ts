// @vitest-environment happy-dom

import React, { act } from 'react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { useUiStore } from '../frontend/src/lib/stores/ui.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  useQuery: vi.fn(),
}));

const sampleIssue = {
  key: 'PROJ-42',
  title: 'Wire ticket integrations into repo dashboard',
  url: 'https://jira.example.com/browse/PROJ-42',
};

vi.mock('@tanstack/react-query', () => ({
  useQuery: mocks.useQuery,
}));

vi.mock('../frontend/src/lib/stores/sessions.js', () => ({
  useSessionsStore: (selector: (state: { sessions: unknown[] }) => unknown) =>
    selector({ sessions: [] }),
}));

vi.mock('../frontend/src/lib/stores/telemetry.js', () => ({
  useTelemetryStore: (
    selector: (state: {
      summarizeSessionSetTelemetry: () => {
        totalSessions: number;
        trackedSessions: number;
        totalInputTokens: number;
        totalOutputTokens: number;
        totalCacheRead: number;
        averageContextPercent: number | null;
        maxContextPercent: number | null;
      };
      getAccountTelemetry: () => null;
    }) => unknown
  ) =>
    selector({
      summarizeSessionSetTelemetry: () => ({
        totalSessions: 0,
        trackedSessions: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheRead: 0,
        averageContextPercent: null,
        maxContextPercent: null,
      }),
      getAccountTelemetry: () => null,
    }),
}));

vi.mock('../frontend/src/hooks/useScrollOverflow.js', () => ({
  useScrollOverflow: () => ({
    ref: { current: null },
    hasOverflow: false,
  }),
}));

vi.mock('../frontend/src/components/TuiButton.js', async () => {
  const ReactModule = await import('react');
  return {
    TuiButton: ({
      children,
      onClick,
      disabled,
      ...props
    }: {
      children: React.ReactNode;
      onClick?: () => void;
      disabled?: boolean;
    }) =>
      ReactModule.createElement(
        'button',
        { onClick, disabled, ...props },
        children
      ),
  };
});

vi.mock('../frontend/src/components/TuiProgress.js', async () => {
  const ReactModule = await import('react');
  return {
    TuiProgress: () =>
      ReactModule.createElement('div', { 'data-testid': 'tui-progress' }),
  };
});

vi.mock('../frontend/src/components/TicketsPanel.js', async () => {
  const ReactModule = await import('react');
  return {
    default: ({
      onStartWork,
    }: {
      onStartWork?: (issue: typeof sampleIssue) => void;
    }) =>
      ReactModule.createElement(
        'div',
        { 'data-testid': 'tickets-panel' },
        ReactModule.createElement(
          'button',
          {
            onClick: () => onStartWork?.(sampleIssue),
          },
          'start work on ticket'
        )
      ),
  };
});

vi.mock('../frontend/src/components/StartWorkModal.js', async () => {
  const ReactModule = await import('react');
  return {
    default: ({
      issue,
      onClose,
      onSessionCreated,
    }: {
      issue: typeof sampleIssue;
      onClose: () => void;
      onSessionCreated: (sessionId: string) => void;
    }) =>
      ReactModule.createElement(
        'div',
        { 'data-testid': 'start-work-modal' },
        ReactModule.createElement(
          'span',
          { 'data-testid': 'start-work-issue' },
          issue.key
        ),
        ReactModule.createElement(
          'button',
          { onClick: () => onSessionCreated('session-123') },
          'complete start work'
        ),
        ReactModule.createElement('button', { onClick: onClose }, 'close')
      ),
  };
});

vi.mock(
  '../frontend/src/components/WorkspaceEvidenceDashboard.js',
  async () => {
    const ReactModule = await import('react');
    return {
      default: () =>
        ReactModule.createElement('div', { className: 'evidence-dashboard' }),
    };
  }
);

const { RepoDashboard } =
  await import('../frontend/src/components/RepoDashboard.tsx');

describe('RepoDashboard ticket flow', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mocks.useQuery.mockImplementation(
      ({ queryKey }: { queryKey: readonly unknown[] }) => ({
        data:
          queryKey[0] === 'dashboard'
            ? { isGitRepo: true, prs: [], activity: [] }
            : [],
        isLoading: false,
        isError: false,
      })
    );
    useUiStore.setState({ repoDashboardTabIntent: null });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
    useUiStore.setState({ repoDashboardTabIntent: null });
  });

  it('mounts TicketsPanel from the repo dashboard and forwards Start Work sessions', async () => {
    const onSessionCreated = vi.fn();

    await act(async () => {
      root.render(
        React.createElement(RepoDashboard, {
          repoPath: '/repo/path',
          workspaceName: 'relay-ide',
          onNewSession: vi.fn(),
          onNewWorktree: vi.fn(),
          onFixConflicts: vi.fn(),
          onPrAction: vi.fn(),
          onOpenPrSession: vi.fn(),
          onSessionCreated,
        })
      );
    });

    const ticketsTab = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'tickets'
    );
    expect(ticketsTab).toBeTruthy();

    await act(async () => {
      ticketsTab?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(
      container.querySelector('[data-testid="tickets-panel"]')
    ).toBeTruthy();

    const startWorkButton = Array.from(
      container.querySelectorAll('button')
    ).find((button) => button.textContent === 'start work on ticket');
    expect(startWorkButton).toBeTruthy();

    await act(async () => {
      startWorkButton?.dispatchEvent(
        new MouseEvent('click', { bubbles: true })
      );
    });

    expect(
      container.querySelector('[data-testid="start-work-modal"]')
    ).toBeTruthy();
    expect(
      container.querySelector('[data-testid="start-work-issue"]')?.textContent
    ).toBe('PROJ-42');

    const completeButton = Array.from(
      container.querySelectorAll('button')
    ).find((button) => button.textContent === 'complete start work');
    expect(completeButton).toBeTruthy();

    await act(async () => {
      completeButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onSessionCreated).toHaveBeenCalledWith('session-123');
    expect(
      container.querySelector('[data-testid="start-work-modal"]')
    ).toBeNull();
  });

  it('consumes a repo-scoped evidence-tab navigation intent', async () => {
    useUiStore.getState().requestRepoDashboardTab('/repo/path', 'evidence');

    await act(async () => {
      root.render(
        React.createElement(RepoDashboard, {
          repoPath: '/repo/path',
          workspaceName: 'relay-ide',
          onNewSession: vi.fn(),
          onNewWorktree: vi.fn(),
          onFixConflicts: vi.fn(),
          onPrAction: vi.fn(),
          onOpenPrSession: vi.fn(),
        })
      );
    });

    const evidenceTab = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'evidence'
    );
    expect(evidenceTab).toBeTruthy();
    expect(evidenceTab?.classList.contains('tab-btn--active')).toBe(true);
    expect(container.querySelector('.evidence-dashboard')).toBeTruthy();
    expect(useUiStore.getState().repoDashboardTabIntent).toBeNull();
  });
});

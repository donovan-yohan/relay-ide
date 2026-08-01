// @vitest-environment happy-dom
//
// #1287 invariant: ANY navigation to a surface that does not outrank the chat
// shell must clear BOTH chat-shell latches (`activeChannelId` and
// `topicComposerOpen`) or it is a silent no-op — the screen never changes, no
// request leaves the browser, and the latched flag later fires as a surprise
// navigation the moment the operator closes the channel.
//
// That invariant shipped broken twice: slice 1's cockpit escape hatches, then
// this ticket's new-chat button. Both times the reason was the same — the
// invariant lived only in prose, was hand-implemented per call site, and the
// tests that covered those call sites stubbed the navigation itself with a
// `vi.fn()`. This file is the gate: one table over every navigation entry
// point, each seeded with BOTH latches set, each asserting the surface the
// action names actually resolves. A new entry point that forgets the clear
// either fails here or is visibly absent from the table.

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionHandlers } from '../frontend/src/hooks/useSessionHandlers.js';
import { enterWorkCockpit } from '../frontend/src/hooks/useActionRegistry.js';
import { useUrlNav } from '../frontend/src/hooks/useUrlNav.js';
import {
  leaveChatSurface,
  openTopicTaskRoom,
} from '../frontend/src/lib/topic-task-room.js';
import { resolveAppViewMode } from '../frontend/src/lib/state/app-view-mode.js';
import { hashPath } from '../frontend/src/lib/url-nav.js';
import { useSessionsStore } from '../frontend/src/lib/stores/sessions.js';
import { useUiStore } from '../frontend/src/lib/stores/ui.js';
import type { Repo } from '../frontend/src/lib/types.js';

vi.mock('../frontend/src/components/dialogs/CustomizeSessionDialog.js', () => ({
  isFrameworkAvailable: () => true,
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const REPO_PATH = '/repo/relay-ide';
const OPEN_CHANNEL_ID = 'topic:already-open';

function makeRepo(): Repo {
  return {
    path: REPO_PATH,
    name: 'relay-ide',
    isGitRepo: true,
    kind: 'repo',
    defaultBranch: 'nightly',
    currentBranch: 'nightly',
  };
}

/** The surface the store currently resolves to, read exactly as `App` reads it. */
function currentViewMode(): ReturnType<typeof resolveAppViewMode> {
  const ui = useUiStore.getState();
  return resolveAppViewMode({
    analyticsView: ui.analyticsView,
    hasActiveSession: useSessionsStore.getState().activeSessionId !== null,
    activeRepoPath: ui.activeRepoPath,
    forceOrgCockpit: ui.forceOrgCockpit,
    topicComposerOpen: ui.topicComposerOpen,
    hasActiveChannel: ui.activeChannelId !== null,
  });
}

type Handlers = ReturnType<typeof useSessionHandlers>;

function SessionHandlersHarness({
  onReady,
}: {
  onReady: (handlers: Handlers) => void;
}) {
  onReady(
    useSessionHandlers({
      customizeDialogRef: React.createRef(),
      deleteWorktreeDialogRef: React.createRef(),
      workspaceSettingsDialogRef: React.createRef(),
      setAnalyticsView: vi.fn(),
    })
  );
  return null;
}

type UrlNav = ReturnType<typeof useUrlNav>;

function UrlNavHarness({ onReady }: { onReady: (nav: UrlNav) => void }) {
  onReady(useUrlNav());
  return null;
}

describe('chat-surface navigation invariant (#1287)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    window.history.replaceState(null, '', '/');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useSessionsStore.setState({
      sessions: [],
      repos: [makeRepo()],
      activeSessionId: null,
    });
    useUiStore.setState({
      activeChannelId: null,
      topicComposerOpen: false,
      forceOrgCockpit: false,
      analyticsView: null,
      activeRepoPath: null,
      activeWorkspaceId: null,
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
    useSessionsStore.setState({
      sessions: [],
      repos: [],
      activeSessionId: null,
    });
    useUiStore.setState({
      activeChannelId: null,
      topicComposerOpen: false,
      forceOrgCockpit: false,
      analyticsView: null,
      activeRepoPath: null,
      activeWorkspaceId: null,
    });
  });

  async function mountSessionHandlers(): Promise<Handlers> {
    let handlers!: Handlers;
    await act(async () => {
      root.render(
        React.createElement(SessionHandlersHarness, {
          onReady: (value: Handlers) => {
            handlers = value;
          },
        })
      );
    });
    return handlers;
  }

  async function mountUrlNav(url: string): Promise<UrlNav> {
    window.history.replaceState(null, '', url);
    let nav!: UrlNav;
    await act(async () => {
      root.render(
        React.createElement(UrlNavHarness, {
          onReady: (value: UrlNav) => {
            nav = value;
          },
        })
      );
    });
    return nav;
  }

  /**
   * Every navigation entry point that names a surface OTHER than the open
   * channel. `seed` runs after both latches are set, so a case can supply the
   * extra state its destination needs (a repo for the dashboard, a URL for a
   * restore). `expected` is the surface the action's own name promises.
   */
  const NAVIGATIONS: {
    name: string;
    expected: ReturnType<typeof resolveAppViewMode>;
    run: () => Promise<void> | void;
    seed?: () => void;
  }[] = [
    {
      // The composer is inside the chat shell, so 'chat' is right — but the
      // channel still has to go, or `ChatHome` renders `ChannelView` and the
      // composer never mounts. Asserted again below on the store fields.
      name: 'openTopicTaskRoom (sidebar/palette/mobile new chat)',
      expected: 'chat',
      run: () => openTopicTaskRoom(),
    },
    {
      name: 'enterWorkCockpit (palette: open work cockpit)',
      expected: 'org',
      run: () => enterWorkCockpit(),
    },
    {
      name: 'navigateToDashboard (palette: pr.*, session.start-on-ticket, sidebar dashboard)',
      expected: 'dashboard',
      seed: () => useUiStore.getState().setActiveRepoPath(REPO_PATH),
      run: async () => {
        const handlers = await mountSessionHandlers();
        act(() => handlers.navigateToDashboard());
      },
    },
    {
      name: 'applyRoute via restoreFromUrl → repo route',
      expected: 'dashboard',
      run: async () => {
        const nav = await mountUrlNav(`/${hashPath(REPO_PATH)}`);
        await act(async () => nav.restoreFromUrl());
      },
    },
    {
      name: 'applyRoute via restoreFromUrl → analytics route',
      expected: 'analytics',
      run: async () => {
        const nav = await mountUrlNav('/analytics');
        await act(async () => nav.restoreFromUrl());
      },
    },
    {
      name: 'leaveChatSurface (shared helper behind the above)',
      expected: 'chat',
      run: () => leaveChatSurface(),
    },
  ];

  for (const nav of NAVIGATIONS) {
    it(`reaches its surface from an open channel + latched composer: ${nav.name}`, async () => {
      // BOTH latches set. Pre-fix, each of these left at least one behind and
      // `resolveAppViewMode` short-circuited on it.
      useUiStore.setState({
        activeChannelId: OPEN_CHANNEL_ID,
        topicComposerOpen: true,
      });
      nav.seed?.();
      expect(currentViewMode()).toBe('chat');

      await nav.run();

      expect(currentViewMode(), nav.name).toBe(nav.expected);
      // The channel is the latch that outranks everything inside 'chat', so no
      // navigation may leave it set — including the ones that stay in 'chat'.
      expect(useUiStore.getState().activeChannelId, nav.name).toBeNull();
    });
  }

  it('leaves openTopicTaskRoom on the composer, not a re-rendered channel', () => {
    useUiStore.setState({
      activeChannelId: OPEN_CHANNEL_ID,
      topicComposerOpen: false,
    });

    openTopicTaskRoom();

    // `ChatHome` mounts `TopicComposer` only in the `activeChannelId === null`
    // branch, so these two fields together ARE "the composer is on screen".
    expect(useUiStore.getState().activeChannelId).toBeNull();
    expect(useUiStore.getState().topicComposerOpen).toBe(true);
  });

  it('clears the composer latch too, so a later channel close cannot resurrect it', () => {
    useUiStore.setState({
      activeChannelId: OPEN_CHANNEL_ID,
      topicComposerOpen: true,
    });

    enterWorkCockpit();

    expect(useUiStore.getState().topicComposerOpen).toBe(false);
  });

  // Mechanical backpressure, not prose: every module that navigates off the
  // chat shell must go through the one helper. A rewrite that hand-rolls the
  // clear (the failure mode that shipped twice) drops the import and fails
  // here even if its own behaviour test is stubbed.
  it('routes every chat-shell exit through leaveChatSurface', () => {
    for (const file of [
      'frontend/src/hooks/useActionRegistry.ts',
      'frontend/src/hooks/useSessionHandlers.ts',
      'frontend/src/hooks/useUrlNav.ts',
      'frontend/src/components/TopicSidebarShell.tsx',
    ]) {
      const source = fs.readFileSync(file, 'utf8');
      expect(source, file).toContain('leaveChatSurface');
    }
  });
});

// @vitest-environment happy-dom
//
// #1287 slice 5 item 9: channels are a routed surface. Before this the
// RouteState union had no channel variant, so the app's top-priority view had
// neither a deep link nor reload survival — and worse, a channel open that also
// dropped the repo/session selection rewrote the URL to `/`, discarding the
// previous entry.

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createWorkspaceTopicId,
  mintWorkspaceTopicId,
} from '../shared/workspace-topics.js';
import { dmChannelTopicId } from '../frontend/src/lib/dm-channels.js';
import {
  buildPath,
  decodeChannelSegment,
  encodeChannelSegment,
  hashPath,
  parseRoute,
} from '../frontend/src/lib/url-nav.js';
import type { Repo } from '../frontend/src/lib/types.js';
import { useUrlNav } from '../frontend/src/hooks/useUrlNav.js';
import { useUiStore } from '../frontend/src/lib/stores/ui.js';
import { useSessionsStore } from '../frontend/src/lib/stores/sessions.js';
import { makeSession } from './helpers/frontend-factories.js';

const REPO_PATH = '/path/to/repo';

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    path: REPO_PATH,
    name: 'repo',
    isGitRepo: true,
    defaultBranch: 'main',
    currentBranch: 'main',
    ...overrides,
  };
}

describe('channel route encoding', () => {
  it('round-trips a minted opaque channel id', () => {
    const id = mintWorkspaceTopicId();
    const segment = encodeChannelSegment(id);

    // Slice-4 ids are lowercase Crockford base32, so the segment is the id
    // verbatim minus the constant `topic:` prefix — nothing to percent-escape.
    expect(segment).toBe(id.slice('topic:'.length));
    expect(segment).not.toContain('%');
    expect(decodeChannelSegment(segment)).toBe(id);
    expect(parseRoute(`/channel/${segment}`, [])).toEqual({
      view: 'channel',
      channelId: id,
    });
  });

  it('round-trips a DM channel id through its `~` separators', () => {
    const id = dmChannelTopicId('claude', null);

    expect(id).toContain('~');
    const segment = encodeChannelSegment(id);
    // `~` is unreserved, so it stays readable in the address bar.
    expect(segment).toBe('dm~claude~workspace-local');
    expect(decodeChannelSegment(segment)).toBe(id);
    expect(parseRoute(`/channel/${segment}`, [])).toEqual({
      view: 'channel',
      channelId: id,
    });
  });

  it('round-trips a legacy title-slugged channel id', () => {
    const id = createWorkspaceTopicId('Ship The Nav Spine', 'ws-local');

    const segment = encodeChannelSegment(id);
    expect(decodeChannelSegment(segment)).toBe(id);
    expect(parseRoute(`/channel/${segment}`, [])).toEqual({
      view: 'channel',
      channelId: id,
    });
  });

  it('round-trips an id whose stored form already carries a percent escape', () => {
    // The topic-id grammar admits `%`; a segment that carried it literally
    // would be decoded a second time by the browser and lose a character.
    const id = 'topic:ws%3Amigrated-chat';

    const segment = encodeChannelSegment(id);
    expect(segment).toBe('ws%253Amigrated-chat');
    expect(decodeChannelSegment(segment)).toBe(id);
    expect(parseRoute(`/channel/${segment}`, [])).toEqual({
      view: 'channel',
      channelId: id,
    });
  });

  it('falls back to home for a segment that is not a legal topic id', () => {
    expect(decodeChannelSegment('has spaces')).toBeNull();
    expect(decodeChannelSegment('%E0%A4%A')).toBeNull();
    expect(parseRoute('/channel/has%20spaces', [])).toEqual({ view: 'home' });
    expect(parseRoute('/channel', [])).toEqual({ view: 'home' });
  });

  it('keeps the repo route unambiguous', () => {
    const repos = [makeRepo()];
    expect(parseRoute(`/${hashPath(REPO_PATH)}`, repos)).toEqual({
      view: 'repo',
      repoPath: REPO_PATH,
    });
    // `hashPath` is always 6 base36 chars, so a repo segment can never be
    // the literal `channel`.
    expect(hashPath(REPO_PATH)).toHaveLength(6);
  });
});

describe('buildPath channel priority', () => {
  const repos = [makeRepo()];
  const channelId = mintWorkspaceTopicId();

  it('outranks the repo/session pair', () => {
    expect(buildPath(REPO_PATH, 'sess-1', null, repos, channelId)).toBe(
      `/channel/${encodeChannelSegment(channelId)}`
    );
  });

  it('never collapses a channel open to /', () => {
    // The regression: a channel open that also drops the repo/session
    // selection used to produce `/`, which the push effect wrote over the
    // previous entry's URL.
    expect(buildPath(null, null, null, repos, channelId)).not.toBe('/');
  });

  it('yields to analytics, which is a full-page takeover', () => {
    expect(buildPath(null, null, 'dashboard', repos, channelId)).toBe(
      '/analytics'
    );
  });

  it('is unchanged when no channel is open', () => {
    expect(buildPath(REPO_PATH, 'sess-1', null, repos, null)).toBe(
      `/${hashPath(REPO_PATH)}/sess-1`
    );
    expect(buildPath(null, null, null, repos, null)).toBe('/');
  });
});

// ── Mounted-hook harness ─────────────────────────────────────────────────────

type UrlNav = ReturnType<typeof useUrlNav>;

function UrlNavHarness({ onReady }: { onReady: (nav: UrlNav) => void }) {
  const nav = useUrlNav();
  onReady(nav);
  return null;
}

describe('useUrlNav channel navigation', () => {
  let container: HTMLDivElement;
  let root: Root;
  let nav: UrlNav;

  const channelId = mintWorkspaceTopicId();
  const otherChannelId = mintWorkspaceTopicId();
  const channelPath = `/channel/${encodeChannelSegment(channelId)}`;
  const otherChannelPath = `/channel/${encodeChannelSegment(otherChannelId)}`;

  async function mount(initialUrl: string): Promise<void> {
    window.history.replaceState(null, '', initialUrl);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(
        React.createElement(UrlNavHarness, {
          onReady: (value: UrlNav) => {
            nav = value;
          },
        })
      );
    });
  }

  /**
   * Browsers restore the entry's URL BEFORE dispatching `popstate`; happy-dom
   * has no session history to walk, so the test does the same two steps by
   * hand and the handler sees exactly what it would in a real back/forward.
   */
  async function goBackTo(url: string): Promise<void> {
    window.history.replaceState(null, '', url);
    await act(async () => {
      window.dispatchEvent(new Event('popstate'));
    });
  }

  beforeEach(() => {
    localStorage.clear();
    useUiStore.setState({
      activeChannelId: null,
      activeRepoPath: null,
      analyticsView: null,
      activeModal: null,
      topicComposerOpen: false,
    });
    useSessionsStore.setState({
      activeSessionId: null,
      repos: [makeRepo()],
      sessions: [makeSession({ id: 'sess-1', repoPath: REPO_PATH })],
    });
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    window.history.replaceState(null, '', '/');
  });

  it('restores a deep-linked channel on boot', async () => {
    await mount(channelPath);

    await act(async () => {
      nav.restoreFromUrl();
    });

    expect(useUiStore.getState().activeChannelId).toBe(channelId);
    // A stale persisted session must not survive underneath the channel.
    expect(useSessionsStore.getState().activeSessionId).toBeNull();
    expect(window.location.pathname).toBe(channelPath);
  });

  it('drops a session selection that was persisted from a previous visit', async () => {
    useSessionsStore.setState({ activeSessionId: 'sess-1' });
    useUiStore.setState({ activeRepoPath: REPO_PATH });
    await mount(channelPath);

    await act(async () => {
      nav.restoreFromUrl();
    });

    expect(useUiStore.getState().activeChannelId).toBe(channelId);
    expect(useSessionsStore.getState().activeSessionId).toBeNull();
    expect(window.location.pathname).toBe(channelPath);
  });

  it('sends an unknown channel segment home and rewrites the URL', async () => {
    await mount('/channel/not a channel');

    await act(async () => {
      nav.restoreFromUrl();
    });

    expect(useUiStore.getState().activeChannelId).toBeNull();
    expect(window.location.pathname).toBe('/');
  });

  it('pushes a history entry when a channel is opened', async () => {
    await mount('/');
    await act(async () => {
      nav.restoreFromUrl();
    });
    const lengthBefore = window.history.length;

    await act(async () => {
      useUiStore.getState().setActiveChannelId(channelId);
    });

    expect(window.location.pathname).toBe(channelPath);
    expect(window.history.length).toBe(lengthBefore + 1);
  });

  it('does not rewrite the URL to / when a channel opens over a session', async () => {
    useSessionsStore.setState({ activeSessionId: 'sess-1' });
    useUiStore.setState({ activeRepoPath: REPO_PATH });
    await mount(`/${hashPath(REPO_PATH)}/sess-1`);
    await act(async () => {
      nav.restoreFromUrl();
    });

    // The regression path: the open clears the session/repo selection, which
    // used to make `buildPath` return `/`.
    await act(async () => {
      useUiStore.getState().setActiveChannelId(channelId);
      useUiStore.getState().setActiveRepoPath(null);
      useSessionsStore.getState().setActiveSessionId(null);
    });

    expect(window.location.pathname).toBe(channelPath);
    expect(window.location.pathname).not.toBe('/');
  });

  it('closes the channel when back lands on home', async () => {
    await mount('/');
    await act(async () => {
      nav.restoreFromUrl();
    });
    await act(async () => {
      useUiStore.getState().setActiveChannelId(channelId);
    });
    expect(window.location.pathname).toBe(channelPath);

    await goBackTo('/');

    expect(useUiStore.getState().activeChannelId).toBeNull();
    // The handler must not push a corrective entry of its own.
    expect(window.location.pathname).toBe('/');
  });

  it('moves between channels on back/forward without corrupting the URL', async () => {
    await mount('/');
    await act(async () => {
      nav.restoreFromUrl();
    });
    await act(async () => {
      useUiStore.getState().setActiveChannelId(channelId);
    });
    await act(async () => {
      useUiStore.getState().setActiveChannelId(otherChannelId);
    });
    expect(window.location.pathname).toBe(otherChannelPath);

    await goBackTo(channelPath);
    expect(useUiStore.getState().activeChannelId).toBe(channelId);
    expect(window.location.pathname).toBe(channelPath);

    await goBackTo(otherChannelPath);
    expect(useUiStore.getState().activeChannelId).toBe(otherChannelId);
    expect(window.location.pathname).toBe(otherChannelPath);
  });

  it('corrects the address in place when the URL asks for a dead session', async () => {
    await mount(`/${hashPath(REPO_PATH)}/gone`);
    const lengthBefore = window.history.length;

    await act(async () => {
      nav.restoreFromUrl();
    });

    expect(useSessionsStore.getState().activeSessionId).toBeNull();
    expect(window.location.pathname).toBe(`/${hashPath(REPO_PATH)}`);
    expect(window.history.length).toBe(lengthBefore);
  });

  it('closes the channel when back lands on a session route', async () => {
    await mount('/');
    await act(async () => {
      nav.restoreFromUrl();
    });
    await act(async () => {
      useUiStore.getState().setActiveChannelId(channelId);
    });

    await goBackTo(`/${hashPath(REPO_PATH)}/sess-1`);

    expect(useUiStore.getState().activeChannelId).toBeNull();
    expect(useSessionsStore.getState().activeSessionId).toBe('sess-1');
    expect(window.location.pathname).toBe(`/${hashPath(REPO_PATH)}/sess-1`);
  });
});

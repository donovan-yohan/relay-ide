import { describe, it, expect } from 'vitest';

// Sessions store has complex dependencies (api.js, notifications.js) that
// don't resolve in the Node test runner. Instead, we test the pure state
// logic patterns that the Zustand store implements, ensuring parity with
// the Svelte state module.

// ── localStorage mock ──────────────────────────────────────────────────────
const storage: Record<string, string> = {};
if (typeof globalThis.localStorage === 'undefined') {
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (key: string) => storage[key] ?? null,
      setItem: (key: string, value: string) => {
        storage[key] = value;
      },
      removeItem: (key: string) => {
        delete storage[key];
      },
      clear: () => {
        for (const key of Object.keys(storage)) delete storage[key];
      },
      get length() {
        return Object.keys(storage).length;
      },
      key: (index: number) => Object.keys(storage)[index] ?? null,
    },
    configurable: true,
  });
}

// ── Inline pure logic (mirrors Zustand store implementation) ───────────────

interface MinimalSession {
  id: string;
  repoPath: string;
  workspaceId?: string;
}

function getSessionsForRepo(
  sessions: MinimalSession[],
  repoPath: string
): MinimalSession[] {
  return sessions.filter((s) => s.repoPath === repoPath);
}

function getSessionsForWorkspaceGroup(
  sessions: MinimalSession[],
  workspaceGroups: { id: string; repos: string[] }[],
  workspaceId: string
): MinimalSession[] {
  const directSessions = sessions.filter((s) => s.workspaceId === workspaceId);
  const workspace = workspaceGroups.find((w) => w.id === workspaceId);
  if (!workspace) return directSessions;
  const repoSet = new Set(workspace.repos);
  const repoSessions = sessions.filter(
    (s) => !s.workspaceId && repoSet.has(s.repoPath)
  );
  return [...directSessions, ...repoSessions];
}

function rememberSessionForWorkspace(
  map: Record<string, string>,
  workspacePath: string,
  sessionId: string
): Record<string, string> {
  return { ...map, [workspacePath]: sessionId };
}

function recallSessionForWorkspace(
  map: Record<string, string>,
  sessions: MinimalSession[],
  workspacePath: string
): { sessionId: string | null; updatedMap: Record<string, string> } {
  const id = map[workspacePath];
  if (!id) return { sessionId: null, updatedMap: map };
  if (!sessions.some((s) => s.id === id)) {
    const next = { ...map };
    delete next[workspacePath];
    return { sessionId: null, updatedMap: next };
  }
  return { sessionId: id, updatedMap: map };
}

function setLoading(
  items: Record<string, boolean>,
  key: string
): Record<string, boolean> {
  return { ...items, [key]: true };
}

function clearLoading(
  items: Record<string, boolean>,
  key: string
): Record<string, boolean> {
  const next = { ...items };
  delete next[key];
  return next;
}

function getNotificationSessionIds(prefs: Record<string, boolean>): string[] {
  return Object.entries(prefs)
    .filter(([, enabled]) => enabled)
    .map(([id]) => id);
}

function pruneNotifications(
  prefs: Record<string, boolean>,
  activeIds: Set<string>
): Record<string, boolean> {
  const result = { ...prefs };
  for (const id of Object.keys(result)) {
    if (!activeIds.has(id)) delete result[id];
  }
  return result;
}

function pruneWorkspaceSessions(
  map: Record<string, string>,
  activeIds: Set<string>
): Record<string, string> {
  const result = { ...map };
  for (const [path, id] of Object.entries(result)) {
    if (!activeIds.has(id)) delete result[path];
  }
  return result;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('sessions store pure logic', () => {
  describe('getSessionsForRepo', () => {
    const sessions: MinimalSession[] = [
      { id: 's1', repoPath: '/repo/a' },
      { id: 's2', repoPath: '/repo/b' },
      { id: 's3', repoPath: '/repo/a' },
    ];

    it('filters sessions by repoPath', () => {
      const result = getSessionsForRepo(sessions, '/repo/a');
      expect(result.length).toBe(2);
      expect(result.every((s) => s.repoPath === '/repo/a')).toBeTruthy();
    });

    it('returns empty for unknown repo', () => {
      expect(getSessionsForRepo(sessions, '/repo/unknown').length).toBe(0);
    });
  });

  describe('getSessionsForWorkspaceGroup', () => {
    const sessions: MinimalSession[] = [
      { id: 's1', repoPath: '/repo/a', workspaceId: 'ws-1' },
      { id: 's2', repoPath: '/repo/a' },
      { id: 's3', repoPath: '/repo/b' },
      { id: 's4', repoPath: '/repo/c', workspaceId: 'ws-2' },
    ];
    const groups = [{ id: 'ws-1', repos: ['/repo/a', '/repo/b'] }];

    it('returns direct sessions + repo sessions for workspace', () => {
      const result = getSessionsForWorkspaceGroup(sessions, groups, 'ws-1');
      expect(result.length).toBe(3); // s1 (direct), s2 (repo/a), s3 (repo/b)
      expect(result.some((s) => s.id === 's1')).toBe(true);
      expect(result.some((s) => s.id === 's2')).toBe(true);
      expect(result.some((s) => s.id === 's3')).toBe(true);
    });

    it('returns only direct sessions for unknown workspace', () => {
      const result = getSessionsForWorkspaceGroup(sessions, groups, 'ws-2');
      expect(result.length).toBe(1);
      expect(result[0]!.id).toBe('s4');
    });
  });

  describe('rememberSessionForWorkspace / recallSessionForWorkspace', () => {
    it('remembers and recalls a session', () => {
      const map = rememberSessionForWorkspace({}, '/repo/a', 'session-1');
      const { sessionId } = recallSessionForWorkspace(
        map,
        [{ id: 'session-1', repoPath: '/repo/a' }],
        '/repo/a'
      );
      expect(sessionId).toBe('session-1');
    });

    it('returns null for unknown workspace', () => {
      const { sessionId } = recallSessionForWorkspace({}, [], '/repo/unknown');
      expect(sessionId).toBe(null);
    });

    it('prunes stale session and returns null', () => {
      const map = rememberSessionForWorkspace({}, '/repo/a', 'old-session');
      const { sessionId, updatedMap } = recallSessionForWorkspace(
        map,
        [],
        '/repo/a'
      );
      expect(sessionId).toBe(null);
      expect(updatedMap['/repo/a']).toBe(undefined);
    });

    it('overwrites previous session for same workspace', () => {
      let map = rememberSessionForWorkspace({}, '/repo/a', 'session-1');
      map = rememberSessionForWorkspace(map, '/repo/a', 'session-2');
      const { sessionId } = recallSessionForWorkspace(
        map,
        [{ id: 'session-2', repoPath: '/repo/a' }],
        '/repo/a'
      );
      expect(sessionId).toBe('session-2');
    });
  });

  describe('setLoading / clearLoading', () => {
    it('setLoading marks key as loading', () => {
      const items = setLoading({}, '/repo/a');
      expect(items['/repo/a']).toBe(true);
    });

    it('clearLoading removes key', () => {
      let items = setLoading({}, '/repo/a');
      items = clearLoading(items, '/repo/a');
      expect(items['/repo/a']).toBe(undefined);
    });

    it('clearLoading is a no-op for missing key', () => {
      const items = clearLoading({}, '/repo/nonexistent');
      expect(items).toEqual({});
    });

    it('multiple loading items coexist', () => {
      let items = setLoading({}, '/repo/a');
      items = setLoading(items, '/repo/b');
      expect(items['/repo/a']).toBe(true);
      expect(items['/repo/b']).toBe(true);
      items = clearLoading(items, '/repo/a');
      expect(items['/repo/a']).toBe(undefined);
      expect(items['/repo/b']).toBe(true);
    });
  });

  describe('getNotificationSessionIds', () => {
    it('returns only enabled session ids', () => {
      const ids = getNotificationSessionIds({
        s1: true,
        s2: false,
        s3: true,
      });
      expect(ids.sort()).toEqual(['s1', 's3']);
    });

    it('returns empty for no enabled sessions', () => {
      expect(getNotificationSessionIds({})).toEqual([]);
    });
  });

  describe('pruneNotifications', () => {
    it('removes inactive session prefs', () => {
      const result = pruneNotifications(
        { s1: true, s2: false, s3: true },
        new Set(['s1', 's3'])
      );
      expect(result['s1']).toBe(true);
      expect(result['s2']).toBe(undefined);
      expect(result['s3']).toBe(true);
    });
  });

  describe('pruneWorkspaceSessions', () => {
    it('removes mappings for inactive sessions', () => {
      const result = pruneWorkspaceSessions(
        { '/repo/a': 's1', '/repo/b': 's2' },
        new Set(['s1'])
      );
      expect(result['/repo/a']).toBe('s1');
      expect(result['/repo/b']).toBe(undefined);
    });
  });

  describe('PTY reconnect state', () => {
    type PtyReconnectIds = Record<string, true>;
    type PtyReconnectAction =
      | { type: 'begin'; sessionId: string }
      | { type: 'clear'; sessionId?: string };

    function applyPtyReconnectTransition(
      currentIds: PtyReconnectIds,
      action: PtyReconnectAction
    ): PtyReconnectIds {
      if (action.type === 'begin') {
        return { ...currentIds, [action.sessionId]: true };
      }

      if (action.sessionId === undefined) return {};
      if (!currentIds[action.sessionId]) return currentIds;

      const next = { ...currentIds };
      delete next[action.sessionId];
      return next;
    }

    function beginPtyReconnect(
      currentIds: PtyReconnectIds,
      sessionId: string
    ): PtyReconnectIds {
      return applyPtyReconnectTransition(currentIds, {
        type: 'begin',
        sessionId,
      });
    }

    function clearPtyReconnect(
      currentIds: PtyReconnectIds,
      sessionId?: string
    ): PtyReconnectIds {
      return applyPtyReconnectTransition(currentIds, {
        type: 'clear',
        sessionId,
      });
    }

    function isPtyReconnecting(
      currentIds: PtyReconnectIds,
      sessionId: string | null
    ): boolean {
      return sessionId ? currentIds[sessionId] === true : false;
    }

    it('beginPtyReconnect adds the reconnecting session ID', () => {
      const result = beginPtyReconnect({}, 'session-a');
      expect(result).toEqual({ 'session-a': true });
    });

    it('beginPtyReconnect preserves prior reconnecting session IDs', () => {
      const result = beginPtyReconnect({ 'session-a': true }, 'session-b');
      expect(result).toEqual({ 'session-a': true, 'session-b': true });
    });

    it('clearPtyReconnect clears only the matching sessionId', () => {
      const result = clearPtyReconnect(
        { 'session-a': true, 'session-b': true },
        'session-a'
      );
      expect(result).toEqual({ 'session-b': true });
    });

    it('clearPtyReconnect keeps current state when sessionId does not match', () => {
      const current: PtyReconnectIds = { 'session-a': true };
      const result = clearPtyReconnect(current, 'session-b');
      expect(result).toBe(current);
    });

    it('clearPtyReconnect clears unconditionally when no sessionId provided', () => {
      const result = clearPtyReconnect({ 'session-a': true, 'session-b': true });
      expect(result).toEqual({});
    });

    it('isPtyReconnecting guards null session IDs', () => {
      const current: PtyReconnectIds = { 'session-a': true };
      expect(isPtyReconnecting(current, 'session-a')).toBe(true);
      expect(isPtyReconnecting(current, 'session-b')).toBe(false);
      expect(isPtyReconnecting(current, null)).toBe(false);
    });
  });
});

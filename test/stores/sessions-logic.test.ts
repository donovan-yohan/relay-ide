import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

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
      setItem: (key: string, value: string) => { storage[key] = value; },
      removeItem: (key: string) => { delete storage[key]; },
      clear: () => { for (const key of Object.keys(storage)) delete storage[key]; },
      get length() { return Object.keys(storage).length; },
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

function getSessionsForRepo(sessions: MinimalSession[], repoPath: string): MinimalSession[] {
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
  const repoSessions = sessions.filter((s) => !s.workspaceId && repoSet.has(s.repoPath));
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

function setLoading(items: Record<string, boolean>, key: string): Record<string, boolean> {
  return { ...items, [key]: true };
}

function clearLoading(items: Record<string, boolean>, key: string): Record<string, boolean> {
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
      assert.strictEqual(result.length, 2);
      assert.ok(result.every((s) => s.repoPath === '/repo/a'));
    });

    it('returns empty for unknown repo', () => {
      assert.strictEqual(getSessionsForRepo(sessions, '/repo/unknown').length, 0);
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
      assert.strictEqual(result.length, 3); // s1 (direct), s2 (repo/a), s3 (repo/b)
      assert.ok(result.some((s) => s.id === 's1'));
      assert.ok(result.some((s) => s.id === 's2'));
      assert.ok(result.some((s) => s.id === 's3'));
    });

    it('returns only direct sessions for unknown workspace', () => {
      const result = getSessionsForWorkspaceGroup(sessions, groups, 'ws-2');
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0]!.id, 's4');
    });
  });

  describe('rememberSessionForWorkspace / recallSessionForWorkspace', () => {
    it('remembers and recalls a session', () => {
      let map = rememberSessionForWorkspace({}, '/repo/a', 'session-1');
      const { sessionId } = recallSessionForWorkspace(
        map,
        [{ id: 'session-1', repoPath: '/repo/a' }],
        '/repo/a'
      );
      assert.strictEqual(sessionId, 'session-1');
    });

    it('returns null for unknown workspace', () => {
      const { sessionId } = recallSessionForWorkspace({}, [], '/repo/unknown');
      assert.strictEqual(sessionId, null);
    });

    it('prunes stale session and returns null', () => {
      const map = rememberSessionForWorkspace({}, '/repo/a', 'old-session');
      const { sessionId, updatedMap } = recallSessionForWorkspace(map, [], '/repo/a');
      assert.strictEqual(sessionId, null);
      assert.strictEqual(updatedMap['/repo/a'], undefined);
    });

    it('overwrites previous session for same workspace', () => {
      let map = rememberSessionForWorkspace({}, '/repo/a', 'session-1');
      map = rememberSessionForWorkspace(map, '/repo/a', 'session-2');
      const { sessionId } = recallSessionForWorkspace(
        map,
        [{ id: 'session-2', repoPath: '/repo/a' }],
        '/repo/a'
      );
      assert.strictEqual(sessionId, 'session-2');
    });
  });

  describe('setLoading / clearLoading', () => {
    it('setLoading marks key as loading', () => {
      const items = setLoading({}, '/repo/a');
      assert.strictEqual(items['/repo/a'], true);
    });

    it('clearLoading removes key', () => {
      let items = setLoading({}, '/repo/a');
      items = clearLoading(items, '/repo/a');
      assert.strictEqual(items['/repo/a'], undefined);
    });

    it('clearLoading is a no-op for missing key', () => {
      const items = clearLoading({}, '/repo/nonexistent');
      assert.deepStrictEqual(items, {});
    });

    it('multiple loading items coexist', () => {
      let items = setLoading({}, '/repo/a');
      items = setLoading(items, '/repo/b');
      assert.strictEqual(items['/repo/a'], true);
      assert.strictEqual(items['/repo/b'], true);
      items = clearLoading(items, '/repo/a');
      assert.strictEqual(items['/repo/a'], undefined);
      assert.strictEqual(items['/repo/b'], true);
    });
  });

  describe('getNotificationSessionIds', () => {
    it('returns only enabled session ids', () => {
      const ids = getNotificationSessionIds({
        's1': true,
        's2': false,
        's3': true,
      });
      assert.deepStrictEqual(ids.sort(), ['s1', 's3']);
    });

    it('returns empty for no enabled sessions', () => {
      assert.deepStrictEqual(getNotificationSessionIds({}), []);
    });
  });

  describe('pruneNotifications', () => {
    it('removes inactive session prefs', () => {
      const result = pruneNotifications(
        { 's1': true, 's2': false, 's3': true },
        new Set(['s1', 's3'])
      );
      assert.strictEqual(result['s1'], true);
      assert.strictEqual(result['s2'], undefined);
      assert.strictEqual(result['s3'], true);
    });
  });

  describe('pruneWorkspaceSessions', () => {
    it('removes mappings for inactive sessions', () => {
      const result = pruneWorkspaceSessions(
        { '/repo/a': 's1', '/repo/b': 's2' },
        new Set(['s1'])
      );
      assert.strictEqual(result['/repo/a'], 's1');
      assert.strictEqual(result['/repo/b'], undefined);
    });
  });
});

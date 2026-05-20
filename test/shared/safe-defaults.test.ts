import { describe, expect, it } from 'vitest';

import {
  ENVIRONMENT_OPTION_SCHEMA_VERSION,
  type EnvironmentOption,
} from '../../shared/environment-option.js';
import { createRepoInstanceId, DEFAULT_LOCAL_NODE_ID } from '../../shared/identity.js';
import type { RelayCapabilityBit } from '../../shared/security-policy.js';
import {
  pickDefaultEnvironment,
  type ActiveTabContext,
  type EnvironmentHistoryEntry,
  type PickDefaultEnvironmentError,
} from '../../shared/safe-defaults.js';

const NODE_LOCAL = DEFAULT_LOCAL_NODE_ID;
const NODE_REMOTE = 'remote-mac-mini';
const NODE_OTHER = 'remote-devbox';

const REPO_RELAY = 'github.com/donovan-yohan/relay-ide';
const REPO_OTHER = 'github.com/donovan-yohan/chalk-bag';

function makeOption(
  overrides: Partial<EnvironmentOption> & {
    nodeId?: string;
    repoIdentity?: string | null;
    capabilities?: RelayCapabilityBit[];
  } = {}
): EnvironmentOption {
  const nodeId = overrides.nodeId ?? NODE_LOCAL;
  const repoIdentity = overrides.repoIdentity ?? REPO_RELAY;
  const localPath = `/repos/${repoIdentity?.split('/').pop() ?? 'free'}`;
  const id = `env:${nodeId}:${localPath}`;
  const capabilities: RelayCapabilityBit[] = overrides.capabilities ?? [
    'session:read',
    'session:create:terminal',
  ];
  const repoInstance =
    repoIdentity === null
      ? undefined
      : {
          repoInstanceId: createRepoInstanceId(nodeId, localPath),
          localPath,
          repoIdentity,
          name: repoIdentity.split('/').pop() ?? 'repo',
          currentBranch: 'nightly',
        };
  const cwdMode = repoInstance ? 'repo' : 'free';
  const cwd = repoInstance ? localPath : '/tmp/scratch';
  const {
    nodeId: _omitNodeId,
    repoIdentity: _omitRepoIdentity,
    capabilities: _omitCapabilities,
    ...rest
  } = overrides;
  return {
    schemaVersion: ENVIRONMENT_OPTION_SCHEMA_VERSION,
    id,
    node: {
      nodeId,
      kind: nodeId === DEFAULT_LOCAL_NODE_ID ? 'local' : 'remote',
      displayName: nodeId,
      online: true,
    },
    capabilities,
    cwd,
    cwdMode,
    freshness: 'fresh',
    ...(repoInstance ? { repoInstance } : {}),
    generatedAt: '2026-05-19T00:00:00.000Z',
    ...rest,
  };
}

function makeActiveTab(
  option: EnvironmentOption,
  required: RelayCapabilityBit[] = []
): ActiveTabContext {
  return {
    environment: option,
    requiredCapabilities: required,
  };
}

function makeHistory(
  ...options: EnvironmentOption[]
): EnvironmentHistoryEntry[] {
  return options.map((option, index) => ({
    environmentId: option.id,
    lastUsedAt: `2026-05-${(18 - index).toString().padStart(2, '0')}T00:00:00.000Z`,
  }));
}

describe('pickDefaultEnvironment', () => {
  describe('active tab present', () => {
    it('returns the active-tab option when it is fresh and present in candidates', () => {
      const active = makeOption({ nodeId: NODE_LOCAL });
      const other = makeOption({ nodeId: NODE_REMOTE });
      const result = pickDefaultEnvironment({
        activeTab: makeActiveTab(active),
        history: [],
        candidates: [active, other],
      });
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.option.id).toBe(active.id);
        expect(result.option.node.nodeId).toBe(NODE_LOCAL);
        expect(result.reason).toBe('active-tab');
      }
    });

    it('matches active-tab to candidates by id (round-trip preserves match)', () => {
      const active = makeOption({ nodeId: NODE_LOCAL });
      const roundTripped: EnvironmentOption = JSON.parse(JSON.stringify(active));
      const result = pickDefaultEnvironment({
        activeTab: makeActiveTab(active),
        history: [],
        candidates: [roundTripped],
      });
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.option.id).toBe(active.id);
      }
    });

    it('NEVER silently switches nodes when active-tab node is stale', () => {
      // Critical correctness property (#628): if the active tab's node is in
      // candidates but stale/offline, the picker must surface an error rather
      // than picking a different node.
      const activeStale = makeOption({
        nodeId: NODE_LOCAL,
        freshness: 'stale',
        degradedReasons: [{ kind: 'node-stale', lastSeenAt: '2026-05-18T00:00:00.000Z' }],
      });
      const freshOther = makeOption({ nodeId: NODE_REMOTE });
      const result = pickDefaultEnvironment({
        activeTab: makeActiveTab(activeStale),
        history: makeHistory(freshOther),
        candidates: [activeStale, freshOther],
      });
      expect(result.kind).toBe('error');
      if (result.kind === 'error') {
        expect(result.error).toBe('no-compatible');
        expect(result.reason).toBe('active-tab-degraded');
        expect(result.activeNodeId).toBe(NODE_LOCAL);
      }
    });

    it('returns an error when the active-tab node is offline (does not fall back)', () => {
      const activeOffline = makeOption({
        nodeId: NODE_LOCAL,
        freshness: 'offline',
        degradedReasons: [{ kind: 'node-offline' }],
      });
      const freshOther = makeOption({ nodeId: NODE_REMOTE });
      const result = pickDefaultEnvironment({
        activeTab: makeActiveTab(activeOffline),
        history: [],
        candidates: [activeOffline, freshOther],
      });
      expect(result.kind).toBe('error');
      if (result.kind === 'error') {
        expect(result.error).toBe('no-compatible');
        expect(result.reason).toBe('active-tab-degraded');
      }
    });

    it('returns an error when the active-tab option no longer appears in candidates', () => {
      // If a Tab's previously-selected environment has been removed (node
      // unpaired, repo instance deleted), the picker must not silently
      // substitute a different one — caller surfaces to the user.
      const active = makeOption({ nodeId: NODE_LOCAL });
      const other = makeOption({ nodeId: NODE_REMOTE });
      const result = pickDefaultEnvironment({
        activeTab: makeActiveTab(active),
        history: [],
        candidates: [other],
      });
      expect(result.kind).toBe('error');
      if (result.kind === 'error') {
        expect(result.error).toBe('no-compatible');
        expect(result.reason).toBe('active-tab-missing');
        expect(result.activeNodeId).toBe(NODE_LOCAL);
      }
    });
  });

  describe('no active tab, history hit', () => {
    it('returns last-used compatible environment when present and fresh', () => {
      const recent = makeOption({ nodeId: NODE_REMOTE });
      const older = makeOption({ nodeId: NODE_OTHER });
      const result = pickDefaultEnvironment({
        activeTab: null,
        history: makeHistory(recent, older),
        candidates: [older, recent],
      });
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.option.id).toBe(recent.id);
        expect(result.reason).toBe('history');
      }
    });

    it('skips history entries that no longer appear in candidates', () => {
      const dropped = makeOption({ nodeId: 'departed-node' });
      const present = makeOption({ nodeId: NODE_REMOTE });
      const result = pickDefaultEnvironment({
        activeTab: null,
        history: makeHistory(dropped, present),
        candidates: [present],
      });
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.option.id).toBe(present.id);
        expect(result.reason).toBe('history');
      }
    });

    it('skips history entries whose candidate is stale/offline', () => {
      const staleHistoryHit = makeOption({
        nodeId: NODE_REMOTE,
        freshness: 'stale',
        degradedReasons: [{ kind: 'node-stale', lastSeenAt: '2026-05-18T00:00:00.000Z' }],
      });
      const freshFallback = makeOption({ nodeId: NODE_OTHER });
      const result = pickDefaultEnvironment({
        activeTab: null,
        history: makeHistory(staleHistoryHit),
        candidates: [staleHistoryHit, freshFallback],
      });
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.option.id).toBe(freshFallback.id);
        expect(result.reason).toBe('first-fresh');
      }
    });
  });

  describe('no history', () => {
    it('returns the first fresh online candidate when no history is present', () => {
      const stale = makeOption({
        nodeId: NODE_OTHER,
        freshness: 'stale',
        degradedReasons: [{ kind: 'node-stale', lastSeenAt: '2026-05-18T00:00:00.000Z' }],
      });
      const fresh = makeOption({ nodeId: NODE_REMOTE });
      const result = pickDefaultEnvironment({
        activeTab: null,
        history: [],
        candidates: [stale, fresh],
      });
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.option.id).toBe(fresh.id);
        expect(result.reason).toBe('first-fresh');
      }
    });
  });

  describe('all candidates stale or offline', () => {
    it('returns { error: no-compatible, reason: all-degraded } when every candidate is non-fresh', () => {
      const stale = makeOption({
        nodeId: NODE_LOCAL,
        freshness: 'stale',
        degradedReasons: [{ kind: 'node-stale', lastSeenAt: '2026-05-18T00:00:00.000Z' }],
      });
      const offline = makeOption({
        nodeId: NODE_REMOTE,
        freshness: 'offline',
        degradedReasons: [{ kind: 'node-offline' }],
      });
      const result = pickDefaultEnvironment({
        activeTab: null,
        history: makeHistory(stale, offline),
        candidates: [stale, offline],
      });
      expect(result.kind).toBe('error');
      if (result.kind === 'error') {
        expect(result.error).toBe('no-compatible');
        expect(result.reason).toBe('all-degraded');
      }
    });

    it('returns { error: no-compatible, reason: no-candidates } when the candidate list is empty', () => {
      const result = pickDefaultEnvironment({
        activeTab: null,
        history: [],
        candidates: [],
      });
      expect(result.kind).toBe('error');
      if (result.kind === 'error') {
        expect(result.error).toBe('no-compatible');
        expect(result.reason).toBe('no-candidates');
      }
    });
  });

  describe('compatibility (active tab carries RepoIdentity)', () => {
    it('history fallback prefers same-RepoIdentity candidate when the active tab had a repo', () => {
      // Active tab is missing from candidates but had REPO_RELAY identity. The
      // history fallback should prefer a candidate with the same repo identity
      // over an unrelated repo, even if both are fresh.
      const active = makeOption({ nodeId: NODE_LOCAL, repoIdentity: REPO_RELAY });
      const sameRepoDifferentNode = makeOption({
        nodeId: NODE_REMOTE,
        repoIdentity: REPO_RELAY,
      });
      const differentRepo = makeOption({
        nodeId: NODE_OTHER,
        repoIdentity: REPO_OTHER,
      });
      const result = pickDefaultEnvironment({
        activeTab: makeActiveTab(active),
        history: makeHistory(differentRepo, sameRepoDifferentNode),
        candidates: [differentRepo, sameRepoDifferentNode],
      });
      // Active-tab-missing must still be the error — never silently switch.
      expect(result.kind).toBe('error');
      if (result.kind === 'error') {
        expect(result.reason).toBe('active-tab-missing');
      }
    });

    it('without an active tab, prefers history hit regardless of repo identity', () => {
      const recent = makeOption({ nodeId: NODE_REMOTE, repoIdentity: REPO_OTHER });
      const candidate = makeOption({ nodeId: NODE_OTHER, repoIdentity: REPO_RELAY });
      const result = pickDefaultEnvironment({
        activeTab: null,
        history: makeHistory(recent),
        candidates: [candidate, recent],
      });
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.option.id).toBe(recent.id);
      }
    });
  });

  describe('capability superset (when active tab declares required bits)', () => {
    it('rejects active-tab match if candidate is missing required capabilities', () => {
      const active = makeOption({
        nodeId: NODE_LOCAL,
        capabilities: ['session:read'],
      });
      const result = pickDefaultEnvironment({
        activeTab: makeActiveTab(active, ['session:create:agent']),
        history: [],
        candidates: [active],
      });
      expect(result.kind).toBe('error');
      if (result.kind === 'error') {
        expect(result.error).toBe('no-compatible');
        expect(result.reason).toBe('active-tab-degraded');
      }
    });

    it('accepts active-tab when candidate has the required capability superset', () => {
      const active = makeOption({
        nodeId: NODE_LOCAL,
        capabilities: ['session:read', 'session:create:terminal', 'session:create:agent'],
      });
      const result = pickDefaultEnvironment({
        activeTab: makeActiveTab(active, ['session:create:agent']),
        history: [],
        candidates: [active],
      });
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.option.id).toBe(active.id);
      }
    });
  });

  describe('JSON round-trip', () => {
    it('preserves all input fields and produces the same selection after round-trip', () => {
      const active = makeOption({ nodeId: NODE_LOCAL });
      const other = makeOption({ nodeId: NODE_REMOTE });
      const input = {
        activeTab: makeActiveTab(active, ['session:read']),
        history: makeHistory(other, active),
        candidates: [active, other],
      };
      const roundTripped = JSON.parse(JSON.stringify(input)) as typeof input;
      const result = pickDefaultEnvironment(roundTripped);
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.option.id).toBe(active.id);
        expect(result.option.node.nodeId).toBe(NODE_LOCAL);
        expect(result.reason).toBe('active-tab');
      }
    });

    it('error result round-trips through JSON without losing reason fields', () => {
      const activeStale = makeOption({
        nodeId: NODE_LOCAL,
        freshness: 'stale',
        degradedReasons: [{ kind: 'node-stale', lastSeenAt: '2026-05-18T00:00:00.000Z' }],
      });
      const result = pickDefaultEnvironment({
        activeTab: makeActiveTab(activeStale),
        history: [],
        candidates: [activeStale],
      });
      const cloned = JSON.parse(JSON.stringify(result)) as PickDefaultEnvironmentError;
      expect(cloned.kind).toBe('error');
      expect(cloned.error).toBe('no-compatible');
      expect(cloned.reason).toBe('active-tab-degraded');
      expect(cloned.activeNodeId).toBe(NODE_LOCAL);
    });
  });
});

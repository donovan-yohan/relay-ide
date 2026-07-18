import { describe, expect, it } from 'vitest';
import {
  DM_DEFAULT_WORKSPACE_ID,
  dmChannelCreateInput,
  dmChannelTopicId,
  isDmChannel,
} from '../../frontend/src/lib/dm-channels.js';
import { createWorkspaceTopicId } from '../../shared/workspace-topics.js';
import type { WorkspaceTopic } from '../../shared/workspace-topics.js';

function topic(overrides: Partial<WorkspaceTopic>): WorkspaceTopic {
  return {
    schemaVersion: 1,
    id: 'topic:x',
    workspaceId: 'workspace:local',
    source: 'persisted',
    status: 'active',
    visibility: 'default',
    display: { title: 'x' },
    grouping: {},
    promptDefaults: {},
    routingDefaults: {},
    linkedRefs: {},
    state: { pinned: false, muted: false },
    privacy: {
      classification: 'internal',
      retention: 'project',
      redaction: 'summary',
      rawDefaultsStored: false,
    },
    createdAt: '2026-07-18T00:00:00.000Z',
    updatedAt: '2026-07-18T00:00:00.000Z',
    ...overrides,
  };
}

describe('dmChannelTopicId', () => {
  it('is deterministic per (workspace, provider) and stable across calls', () => {
    const a = dmChannelTopicId('claude', 'workspace:local');
    const b = dmChannelTopicId('claude', 'workspace:local');
    expect(a).toBe(b);
    expect(a).toBe(createWorkspaceTopicId('dm-claude', 'workspace:local'));
  });

  it('defaults a null workspace to the local sentinel', () => {
    expect(dmChannelTopicId('hermes', null)).toBe(
      dmChannelTopicId('hermes', DM_DEFAULT_WORKSPACE_ID)
    );
  });

  it('produces distinct ids per provider and per workspace', () => {
    expect(dmChannelTopicId('claude', 'workspace:local')).not.toBe(
      dmChannelTopicId('codex', 'workspace:local')
    );
    expect(dmChannelTopicId('claude', 'workspace:local')).not.toBe(
      dmChannelTopicId('claude', 'workspace:acme')
    );
  });
});

describe('isDmChannel', () => {
  it('returns the providerId when the id matches its own deterministic form', () => {
    const workspaceId = 'workspace:local';
    const dm = topic({
      workspaceId,
      id: dmChannelTopicId('claude', workspaceId),
      routingDefaults: { providerId: 'claude' },
    });
    expect(isDmChannel(dm)).toBe('claude');
  });

  it('returns null for a regular channel (no provider)', () => {
    expect(
      isDmChannel(topic({ id: 'topic:general', routingDefaults: {} }))
    ).toBe(null);
  });

  it('returns null when the id does not match the provider formula', () => {
    // A topic that HAS a providerId but whose id was not minted by the DM
    // formula (e.g. a normal repo channel that happens to route to claude).
    const notDm = topic({
      id: 'topic:frontend',
      workspaceId: 'workspace:local',
      routingDefaults: { providerId: 'claude' },
    });
    expect(isDmChannel(notDm)).toBe(null);
  });

  it('is workspace-sensitive: a DM id from another workspace is not a DM here', () => {
    const other = topic({
      workspaceId: 'workspace:local',
      id: dmChannelTopicId('claude', 'workspace:acme'),
      routingDefaults: { providerId: 'claude' },
    });
    expect(isDmChannel(other)).toBe(null);
  });
});

describe('dmChannelCreateInput', () => {
  it('builds a create body whose id round-trips through isDmChannel', () => {
    const input = dmChannelCreateInput({
      providerId: 'codex',
      providerDisplayName: 'Codex',
      workspaceId: 'workspace:local',
    });
    expect(input.id).toBe(dmChannelTopicId('codex', 'workspace:local'));
    expect(input.routingDefaults).toEqual({ providerId: 'codex' });
    expect(input.title).toBe('Codex');
    expect(isDmChannel(topic({ ...input, id: input.id! }))).toBe('codex');
  });

  it('defaults workspace to the local sentinel', () => {
    const input = dmChannelCreateInput({
      providerId: 'hermes',
      providerDisplayName: 'Hermes',
      workspaceId: null,
    });
    expect(input.workspaceId).toBe(DM_DEFAULT_WORKSPACE_ID);
  });
});

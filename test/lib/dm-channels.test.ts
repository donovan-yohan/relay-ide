import { describe, expect, it } from 'vitest';
import {
  dmChannelCreateInput,
  dmChannelTopicId,
  isDmChannel,
} from '../../frontend/src/lib/dm-channels.js';
import { createWorkspaceTopicId } from '../../shared/workspace-topics.js';
import { LOCAL_WORKSPACE_ID } from '../../shared/workspace.js';
import { projectWorkspaceId } from '../../server/project-workspace.js';
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
    // Namespaced with `~` so it lives in an id sub-namespace no title can reach.
    expect(a).toBe('topic:dm~claude~workspace-local');
  });

  it('cannot collide with a title-derived id of an ordinary topic (#1178)', () => {
    // The server mints ordinary topic ids from the user title via
    // createWorkspaceTopicId. A user topic titled "dm claude" / "DM-Claude"
    // would previously mint the exact old DM id; the `~` namespace forbids it.
    const workspaceId = 'workspace:local';
    for (const title of ['dm claude', 'DM-Claude', 'dm-claude', 'dm.claude']) {
      expect(dmChannelTopicId('claude', workspaceId)).not.toBe(
        createWorkspaceTopicId(title, workspaceId)
      );
    }
    // The DM id contains a `~`; a title-derived id provably never can.
    expect(dmChannelTopicId('claude', workspaceId)).toContain('~');
    expect(createWorkspaceTopicId('dm claude', workspaceId)).not.toContain('~');
  });

  it('collapses every local workspace reference onto one id (#1287)', () => {
    // null, the retired `workspace:local`/`ws:derived` sentinels, and the
    // seeded `ws:local` must all derive the SAME id, or migrating the column
    // would strand an existing DM's history behind a new channel.
    const expected = dmChannelTopicId('hermes', null);
    for (const ref of ['workspace:local', 'ws:derived', LOCAL_WORKSPACE_ID]) {
      expect(dmChannelTopicId('hermes', ref)).toBe(expected);
    }
  });

  it('produces distinct ids per provider and per workspace', () => {
    expect(dmChannelTopicId('claude', 'workspace:local')).not.toBe(
      dmChannelTopicId('codex', 'workspace:local')
    );
    expect(dmChannelTopicId('claude', 'workspace:local')).not.toBe(
      dmChannelTopicId('claude', 'workspace:acme')
    );
  });

  it('does not collide across sibling deep project paths (#1287)', () => {
    // The workspace segment is TRUNCATED, so an unbounded workspace id makes
    // the DM id lossy: an embedded path percent-encodes to ~3 slug chars per
    // separator and two projects sharing a ~35-char path prefix used to derive
    // the SAME id — DM-ing an agent in project B would open project A's row.
    // `projectWorkspaceId` digests the path precisely so this cannot happen.
    const a = projectWorkspaceId(
      '/home/donovanyohan/Documents/Programs/personal/relay-ide'
    );
    const b = projectWorkspaceId(
      '/home/donovanyohan/Documents/Programs/personal/other-repo'
    );
    expect(a).not.toBe(b);
    expect(dmChannelTopicId('claude', a)).not.toBe(
      dmChannelTopicId('claude', b)
    );

    // …and the reason it holds: neither id reaches the 48-char slug budget, so
    // no truncation happens at all. Guard against re-lengthening the id shape.
    for (const id of [a, b]) {
      const slug = id
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '');
      expect(slug.length).toBeLessThanOrEqual(48);
      expect(dmChannelTopicId('claude', id)).toBe(`topic:dm~claude~${slug}`);
    }
  });

  it('keeps the same project path on one DM id regardless of depth (#1287)', () => {
    const deep = '/very/deeply/nested/checkout/root/that/keeps/going/my-repo';
    expect(dmChannelTopicId('codex', projectWorkspaceId(deep))).toBe(
      dmChannelTopicId('codex', projectWorkspaceId(deep))
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

  it('defaults workspace to the seeded local IA workspace, not a sentinel (#1287)', () => {
    const input = dmChannelCreateInput({
      providerId: 'hermes',
      providerDisplayName: 'Hermes',
      workspaceId: null,
    });
    expect(input.workspaceId).toBe(LOCAL_WORKSPACE_ID);
    expect(input.workspaceId).not.toBe('workspace:local');
  });

  it('keeps the DM id STABLE while the workspace pointer moves (#1287)', () => {
    // The DM id IS the workspace_topics id and channel_messages.channel_id keys
    // history off it. Retiring the `workspace:local` sentinel must therefore
    // move the COLUMN only — every local reference still derives the exact id
    // that existing DM rows already carry.
    const legacy = dmChannelCreateInput({
      providerId: 'claude',
      providerDisplayName: 'Claude',
      workspaceId: 'workspace:local',
    });
    const seeded = dmChannelCreateInput({
      providerId: 'claude',
      providerDisplayName: 'Claude',
      workspaceId: LOCAL_WORKSPACE_ID,
    });
    expect(legacy.id).toBe('topic:dm~claude~workspace-local');
    expect(seeded.id).toBe(legacy.id);
    expect(seeded.workspaceId).toBe(LOCAL_WORKSPACE_ID);
    // …and a migrated row (id unchanged, column now ws:local) still reads as a
    // DM, so the sidebar does not re-classify it as an ordinary channel.
    expect(
      isDmChannel(
        topic({
          id: legacy.id!,
          workspaceId: LOCAL_WORKSPACE_ID,
          routingDefaults: { providerId: 'claude' },
        })
      )
    ).toBe('claude');
  });

  it('leaves named-workspace DM ids byte-identical (#1287)', () => {
    expect(dmChannelTopicId('codex', 'ws:acme')).toBe('topic:dm~codex~ws-acme');
    expect(
      dmChannelCreateInput({
        providerId: 'codex',
        providerDisplayName: 'Codex',
        workspaceId: 'ws:acme',
      }).workspaceId
    ).toBe('ws:acme');
  });
});

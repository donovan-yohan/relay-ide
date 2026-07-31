// #1287 slice 2 — the persisted active-workspace selection.
//
// `claude-remote-active-workspace-group` was the last unvalidated localStorage
// slot holding a workspace id, and it accumulated TWO incompatible id spaces:
// `config.workspaces` GROUP UUIDs (written by the pre-channel launch handler)
// and IA workspace ids (`ws:<localId>`), plus the retired `workspace:local` /
// `ws:derived` sentinels. The slot is not inert — every channel-create path
// resolves its workspace from `activeWorkspaceId`, and a DM channel's id is
// DERIVED from it, so a stale value forked DM ids and minted channels in a
// workspace that does not exist.
//
// Pinned here:
//   1. load-time coercion — only the `ws:<localId>` grammar survives; anything
//      else becomes the always-seeded `LOCAL_WORKSPACE_ID`; the slot is
//      rewritten so the dead id can never be read back;
//   2. DM id stability — every legal persisted value derives the SAME local DM
//      id, which is byte-identical to the id existing DM rows already carry
//      (`channel_messages.channel_id` keys history off it).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The ui store reads localStorage while its module is evaluated, so the shim
// has to exist before the import graph runs — `vi.hoisted` runs above imports.
const storage = vi.hoisted(() => {
  const store: Record<string, string> = {};
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => {
        store[key] = value;
      },
      removeItem: (key: string) => {
        delete store[key];
      },
      clear: () => {
        for (const key of Object.keys(store)) delete store[key];
      },
      get length() {
        return Object.keys(store).length;
      },
      key: (index: number) => Object.keys(store)[index] ?? null,
    },
    configurable: true,
  });
  return store;
});

const mocks = vi.hoisted(() => ({
  fetchWorkspaceTopic: vi.fn(),
  createWorkspaceTopic: vi.fn(),
  postChannelMessage: vi.fn(),
  configState: {
    defaultAgent: 'claude',
    frameworks: [] as Array<{ id: string; displayName: string }>,
  },
}));

vi.mock('../frontend/src/lib/api.js', async (importOriginal) => {
  const actual = await importOriginal<object>();
  return {
    ...actual,
    fetchWorkspaceTopic: mocks.fetchWorkspaceTopic,
    createWorkspaceTopic: mocks.createWorkspaceTopic,
    postChannelMessage: mocks.postChannelMessage,
  };
});

vi.mock('../frontend/src/lib/stores/config.js', () => {
  const useConfigStore = (
    selector: (state: typeof mocks.configState) => unknown
  ) => selector(mocks.configState);
  useConfigStore.getState = () => mocks.configState;
  return { useConfigStore };
});

import { HttpError } from '../frontend/src/lib/api.js';
import { openAgentChannel } from '../frontend/src/lib/agent-channels.js';
import { dmChannelTopicId } from '../frontend/src/lib/dm-channels.js';
import {
  loadPersistedActiveWorkspaceId,
  normalizePersistedWorkspaceId,
  useUiStore,
} from '../frontend/src/lib/stores/ui.js';
import type { WorkspaceTopicCreateInput } from '../shared/workspace-topics.js';
import { LOCAL_WORKSPACE_ID } from '../shared/workspace.js';

const SLOT = 'claude-remote-active-workspace-group';

// A real value found in the slot before the channel era: `config.workspaces`
// group ids are UUIDs, resolved server-side by `/workspace-groups/:id/session`.
const LEGACY_GROUP_UUID = '2f1c9c2e-6a4b-4f0e-9a3d-1f5b7c8d9e01';

// The frozen local DM id. This is the `workspace_topics` id every pre-existing
// local DM row already carries; re-deriving it would strand its transcript.
const LOCAL_DM_ID = 'topic:dm~claude~workspace-local';

function seedSlot(value: string | null): void {
  if (value === null) delete storage[SLOT];
  else storage[SLOT] = value;
}

beforeEach(() => {
  for (const key of Object.keys(storage)) delete storage[key];
  mocks.fetchWorkspaceTopic.mockReset();
  mocks.createWorkspaceTopic.mockReset();
  mocks.postChannelMessage.mockReset();
  useUiStore.setState({ activeWorkspaceId: null, activeChannelId: null });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('normalizePersistedWorkspaceId', () => {
  it('keeps a real ia_workspaces id verbatim', () => {
    expect(normalizePersistedWorkspaceId(LOCAL_WORKSPACE_ID)).toBe(
      LOCAL_WORKSPACE_ID
    );
    expect(normalizePersistedWorkspaceId('ws:acme')).toBe('ws:acme');
    expect(normalizePersistedWorkspaceId('  ws:acme  ')).toBe('ws:acme');
  });

  it('coerces the retired sentinels onto the seeded local workspace', () => {
    expect(normalizePersistedWorkspaceId('workspace:local')).toBe(
      LOCAL_WORKSPACE_ID
    );
    expect(normalizePersistedWorkspaceId('ws:derived')).toBe(LOCAL_WORKSPACE_ID);
  });

  it('coerces a stale config.workspaces group UUID — the other id space', () => {
    // The exact cross-space defect: a UUID can never equal an `ia_workspaces`
    // id, so leaving it selected keeps the rail permanently unmatched.
    expect(normalizePersistedWorkspaceId(LEGACY_GROUP_UUID)).toBe(
      LOCAL_WORKSPACE_ID
    );
  });

  it('leaves an absent or blank slot unselected', () => {
    // `null` is a legal state — no lane selected, rail renders unscoped.
    expect(normalizePersistedWorkspaceId(null)).toBe(null);
    expect(normalizePersistedWorkspaceId('')).toBe(null);
    expect(normalizePersistedWorkspaceId('   ')).toBe(null);
  });
});

describe('loadPersistedActiveWorkspaceId', () => {
  it('migrates the slot in place so the dead id is never read back', () => {
    seedSlot(LEGACY_GROUP_UUID);
    expect(loadPersistedActiveWorkspaceId()).toBe(LOCAL_WORKSPACE_ID);
    expect(storage[SLOT]).toBe(LOCAL_WORKSPACE_ID);
    // Idempotent: the second boot reads an already-legal value.
    expect(loadPersistedActiveWorkspaceId()).toBe(LOCAL_WORKSPACE_ID);
    expect(storage[SLOT]).toBe(LOCAL_WORKSPACE_ID);
  });

  it('drops a blank slot rather than persisting an empty selection', () => {
    seedSlot('   ');
    expect(loadPersistedActiveWorkspaceId()).toBe(null);
    expect(storage[SLOT]).toBe(undefined);
  });

  it('does not touch a slot that already holds a real workspace id', () => {
    seedSlot('ws:acme');
    expect(loadPersistedActiveWorkspaceId()).toBe('ws:acme');
    expect(storage[SLOT]).toBe('ws:acme');
  });

  it('returns null when the slot was never written', () => {
    seedSlot(null);
    expect(loadPersistedActiveWorkspaceId()).toBe(null);
    expect(storage[SLOT]).toBe(undefined);
  });
});

describe('DM channel id derived from the persisted selection (#1287)', () => {
  function createdInput(): WorkspaceTopicCreateInput {
    expect(mocks.createWorkspaceTopic).toHaveBeenCalledTimes(1);
    return mocks.createWorkspaceTopic.mock
      .calls[0]![0] as WorkspaceTopicCreateInput;
  }

  function bootWithSlot(value: string | null): void {
    seedSlot(value);
    useUiStore.getState().setActiveWorkspaceId(loadPersistedActiveWorkspaceId());
  }

  beforeEach(() => {
    // No DM exists yet: the lookup 404s and the create path runs.
    mocks.fetchWorkspaceTopic.mockRejectedValue(
      new HttpError(404, 'not found')
    );
    mocks.createWorkspaceTopic.mockImplementation(
      async (input: WorkspaceTopicCreateInput) => ({
        id: input.id,
        workspaceId: input.workspaceId,
      })
    );
  });

  // The fork this item retires: the DM id used to depend on WHICH legacy value
  // happened to be selected first (`workspace:local` vs `ws:derived` vs a group
  // UUID vs nothing), so the same agent produced duplicate DM rows.
  for (const [label, slot] of [
    ['an unwritten slot', null],
    ['the workspace:local sentinel', 'workspace:local'],
    ['the ws:derived sentinel', 'ws:derived'],
    ['the seeded local workspace id', LOCAL_WORKSPACE_ID],
    ['a stale config.workspaces group UUID', LEGACY_GROUP_UUID],
  ] as Array<[string, string | null]>) {
    it(`derives the one frozen local DM id from ${label}`, async () => {
      bootWithSlot(slot);
      await openAgentChannel();

      expect(mocks.fetchWorkspaceTopic).toHaveBeenCalledWith(LOCAL_DM_ID);
      const input = createdInput();
      expect(input.id).toBe(LOCAL_DM_ID);
      expect(input.id).toBe(dmChannelTopicId('claude', LOCAL_WORKSPACE_ID));
      // The id is frozen; only the workspace POINTER moves to the real row.
      expect(input.workspaceId).toBe(LOCAL_WORKSPACE_ID);
      expect(useUiStore.getState().activeChannelId).toBe(LOCAL_DM_ID);
    });
  }

  it('reuses an existing local DM row instead of minting a new id', async () => {
    // History lives on `channel_messages.channel_id` = this id, so the lookup
    // must hit the frozen id and the create path must not run at all.
    mocks.fetchWorkspaceTopic.mockReset();
    mocks.fetchWorkspaceTopic.mockResolvedValue({
      id: LOCAL_DM_ID,
      workspaceId: LOCAL_WORKSPACE_ID,
    });
    bootWithSlot('workspace:local');

    await openAgentChannel();

    expect(mocks.fetchWorkspaceTopic).toHaveBeenCalledWith(LOCAL_DM_ID);
    expect(mocks.createWorkspaceTopic).not.toHaveBeenCalled();
    expect(useUiStore.getState().activeChannelId).toBe(LOCAL_DM_ID);
  });

  it('still keeps named workspaces on their own DM id', async () => {
    bootWithSlot('ws:acme');
    await openAgentChannel();

    const input = createdInput();
    expect(input.id).toBe('topic:dm~claude~ws-acme');
    expect(input.workspaceId).toBe('ws:acme');
  });
});

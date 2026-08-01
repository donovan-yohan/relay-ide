// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildTopicRoomCreateInput,
  buildTopicRoomLaunchBody,
  createTopicIdReservation,
  deriveTopicProviderOptions,
  deriveTopicTitleFromPrompt,
  effectiveDraftTitle,
  TOPIC_ROOM_DRAFT_EMPTY,
} from '../frontend/src/lib/topic-create.js';

vi.mock('../frontend/src/lib/api.js', async (importOriginal) => {
  const original = await importOriginal<object>();
  return {
    ...original,
    fetchHubNodes: vi.fn().mockResolvedValue([]),
    createWorkspaceTopicRoomAndMaybeLaunch: vi.fn(),
    launchWorkspaceTopicRoom: vi.fn(),
    // Channel-native agent entry point.
    fetchWorkspaceTopic: vi.fn(),
    createWorkspaceTopic: vi.fn(),
    postChannelMessage: vi.fn(),
  };
});

import {
  createWorkspaceTopicRoomAndMaybeLaunch,
  createWorkspaceTopic,
  fetchWorkspaceTopic,
  launchWorkspaceTopicRoom,
  postChannelMessage,
} from '../frontend/src/lib/api.js';
import { ARCHIVED_CHANNEL_PROMPT_NOTICE } from '../frontend/src/lib/agent-channels.js';
import { dmChannelTopicId } from '../frontend/src/lib/dm-channels.js';
import { useConfigStore } from '../frontend/src/lib/stores/config.js';
import { useToastStore } from '../frontend/src/lib/stores/toasts.js';
import { useSessionsStore } from '../frontend/src/lib/stores/sessions.js';
import { useUiStore } from '../frontend/src/lib/stores/ui.js';
import type { FrameworkInfo } from '../frontend/src/lib/types.js';
import TopicComposer from '../frontend/src/components/TopicComposer.js';
import ChatHome from '../frontend/src/components/ChatHome.js';
import { openTopicTaskRoom } from '../frontend/src/lib/topic-task-room.js';
import { resolveAppViewMode } from '../frontend/src/lib/state/app-view-mode.js';
import { scopedSessionKey } from '../frontend/src/lib/session-keys.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function setNativeValue(el: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    'value'
  )?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

function setSelectValue(el: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLSelectElement.prototype,
    'value'
  )?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function framework(
  id: string,
  overrides: Partial<FrameworkInfo> = {}
): FrameworkInfo {
  return {
    id,
    displayName: overrides.displayName ?? id,
    command: id,
    capabilities: {
      supportsContinue: true,
      supportsYolo: true,
      supportsHooks: true,
      supportsTelemetry: false,
      ...overrides.capabilities,
    },
    eventSource: 'hooks',
    availability: { installed: true, path: `/usr/local/bin/${id}` },
    ...overrides,
  };
}

describe('topic title derivation', () => {
  it('derives the title from the first message line, code-point capped', () => {
    expect(deriveTopicTitleFromPrompt('fix the login bug\nmore detail')).toBe(
      'fix the login bug'
    );
    const long = '💡'.repeat(61) + 'x';
    const derived = deriveTopicTitleFromPrompt(long);
    expect(derived.endsWith('…')).toBe(true);
    expect(
      (derived as unknown as { isWellFormed: () => boolean }).isWellFormed()
    ).toBe(true);
  });

  it('prefers an explicit title override over the message', () => {
    expect(
      effectiveDraftTitle({ ...TOPIC_ROOM_DRAFT_EMPTY, prompt: 'hello world' })
    ).toBe('hello world');
    expect(
      effectiveDraftTitle({ title: ' custom ', prompt: 'hello world' })
    ).toBe('custom');
  });
});

// #1287 slice 4: opaque ids removed the accidental idempotence the title-derived
// id used to give `POST /workspace-topics`. Nothing else replaced it, so every
// retry minted a fresh row + WorkContext — and the store answers its 500-row cap
// by DELETING the oldest archived topics, whose transcripts the boot orphan
// sweep then erases. The client owns the id per ATTEMPT to close that.
describe('client-owned create identity', () => {
  it('reuses one id for every retry of the same attempt', () => {
    const reservation = createTopicIdReservation();
    const first = reservation.reserve();

    expect(reservation.reserve()).toBe(first);
    expect(reservation.reserve()).toBe(first);
    // Opaque and inside the topic grammar — nothing may parse it.
    expect(first).toMatch(/^topic:[0-9a-hjkmnp-tv-z]{26}$/);
  });

  it('mints a new id once the attempt is released', () => {
    const reservation = createTopicIdReservation();
    const first = reservation.reserve();
    reservation.release();
    const second = reservation.reserve();

    expect(second).not.toBe(first);
    expect(reservation.reserve()).toBe(second);
  });

  it('does not mint until an id is actually needed', () => {
    const mint = vi.fn(() => 'topic:stub');
    const reservation = createTopicIdReservation(mint);

    expect(mint).not.toHaveBeenCalled();
    reservation.reserve();
    reservation.reserve();
    expect(mint).toHaveBeenCalledTimes(1);
  });
});

describe('topic provider launch helpers', () => {
  it('seeds provider options from the settings default and framework metadata', () => {
    const options = deriveTopicProviderOptions({
      frameworks: [
        framework('claude', { displayName: 'Claude Code' }),
        framework('hermes', {
          displayName: 'Hermes',
        }),
      ],
      defaultProviderId: 'hermes',
      selectedProviderId: 'hermes',
      templateKind: 'agent-task',
    });

    expect(options[0]).toMatchObject({
      id: 'hermes',
      label: 'Hermes',
      isDefault: true,
      status: 'global default · chat',
    });
    expect(options.find((option) => option.id === 'claude')).toMatchObject({
      label: 'Claude Code',
      status: 'one-off override · chat',
    });
  });

  it('surfaces unavailable framework copy without transport-specific state', () => {
    const options = deriveTopicProviderOptions({
      frameworks: [
        framework('hermes'),
        framework('claude', {
          availability: { installed: false, reason: 'claude CLI missing' },
        }),
      ],
      defaultProviderId: 'claude',
      selectedProviderId: 'claude',
      templateKind: 'agent-task',
    });

    expect(options.find((option) => option.id === 'hermes')).toMatchObject({
      status: 'one-off override · chat',
    });
    expect(options.find((option) => option.id === 'claude')).toMatchObject({
      disabled: true,
      status: 'global default · unavailable: claude CLI missing',
    });
  });

  it('never builds an agent session body; explicit terminals stay pty', () => {
    const frameworks = [framework('hermes')];
    const create = buildTopicRoomCreateInput({
      draft: { ...TOPIC_ROOM_DRAFT_EMPTY, prompt: 'run it' },
      workspaceId: null,
      defaultProviderId: 'hermes',
      taskRef: null,
    });

    expect(
      buildTopicRoomLaunchBody(create, 'agent-task', frameworks)
    ).toBeNull();
    expect(
      buildTopicRoomLaunchBody(create, 'terminal-task', frameworks)
    ).toMatchObject({
      type: 'terminal',
      mode: 'pty',
    });
    expect(
      buildTopicRoomLaunchBody(create, 'terminal-task', frameworks)
    ).not.toHaveProperty('initialPrompt');
  });

  it('builds cwd-only launch bodies without synthesizing repoPath', () => {
    const create = buildTopicRoomCreateInput({
      draft: { ...TOPIC_ROOM_DRAFT_EMPTY, prompt: 'run it' },
      workspaceId: null,
      defaultProviderId: 'claude',
      defaultCwd: '/configured/project',
      taskRef: null,
    });
    const body = buildTopicRoomLaunchBody(create, 'terminal-task', [
      framework('claude'),
    ]);

    expect(create.routingDefaults).toMatchObject({
      providerId: 'claude',
      cwd: '/configured/project',
    });
    expect(create.routingDefaults).not.toHaveProperty('repoPath');
    expect(body).toMatchObject({
      type: 'terminal',
      mode: 'pty',
      cwd: '/configured/project',
    });
    expect(body).not.toHaveProperty('repoPath');
  });

  it('routes every installed provider to chat', () => {
    const frameworks = [
      framework('opencode', {
        displayName: 'OpenCode',
      }),
    ];
    const create = buildTopicRoomCreateInput({
      draft: { ...TOPIC_ROOM_DRAFT_EMPTY, prompt: 'run it' },
      workspaceId: null,
      defaultProviderId: 'opencode',
      taskRef: null,
    });

    expect(
      deriveTopicProviderOptions({
        frameworks,
        defaultProviderId: 'opencode',
        selectedProviderId: 'opencode',
        templateKind: 'agent-task',
      })[0]
    ).toMatchObject({
      id: 'opencode',
      status: 'global default · chat',
    });
    expect(
      buildTopicRoomLaunchBody(create, 'agent-task', frameworks)
    ).toBeNull();
  });
});

describe('TopicComposer', () => {
  const originalRefreshAll = useSessionsStore.getState().refreshAll;
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    useConfigStore.setState({
      defaultAgent: 'claude',
      frameworks: [
        framework('claude', { displayName: 'Claude Code' }),
        framework('codex', { displayName: 'Codex' }),
        framework('hermes', {
          displayName: 'Hermes',
        }),
      ],
    });
    useSessionsStore.setState({
      sessions: [],
      repos: [],
      activeSessionId: null,
      workspaceLastSession: {},
      refreshAll: originalRefreshAll,
    });
    useUiStore.setState({
      activeRepoPath: null,
      forceOrgCockpit: false,
      topicComposerOpen: false,
      activeChannelId: null,
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    queryClient.clear();
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  function renderComposer(onSelectSession?: (id: string) => void) {
    act(() =>
      root.render(
        React.createElement(
          QueryClientProvider,
          { client: queryClient },
          React.createElement(TopicComposer, {
            ...(onSelectSession ? { onSelectSession } : {}),
          })
        )
      )
    );
  }

  function renderChatHome(onSelectSession: (id: string) => void) {
    act(() =>
      root.render(
        React.createElement(
          QueryClientProvider,
          { client: queryClient },
          React.createElement(ChatHome, { onSelectSession })
        )
      )
    );
  }

  function getProviderStatus(provider: HTMLSelectElement): HTMLElement | null {
    const describedBy = provider.getAttribute('aria-describedby');
    return describedBy ? document.getElementById(describedBy) : null;
  }

  it('renders the centered message box with start disabled until typed', () => {
    renderComposer();
    const ta = container.querySelector(
      '.topic-composer__ta'
    ) as HTMLTextAreaElement;
    expect(ta).not.toBeNull();
    const start = container.querySelector(
      '.topic-composer__bar button[type="submit"]'
    ) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    act(() => setNativeValue(ta, 'ship the thing'));
    expect(start.disabled).toBe(false);
  });

  it('shows the settings-seeded provider control outside advanced', () => {
    renderComposer();
    const provider = container.querySelector(
      '.topic-composer__provider-select'
    ) as HTMLSelectElement;
    expect(provider).not.toBeNull();
    expect(provider.value).toBe('claude');
    expect(provider.labels?.[0]?.textContent).toBe('coding agent');
    expect(provider.labels?.[0]?.textContent).not.toContain('Claude Code');
    expect(getProviderStatus(provider)?.textContent).toBe(
      'global default · chat'
    );
    expect(provider.getAttribute('aria-describedby')).toBe(
      getProviderStatus(provider)?.id
    );
    expect(provider.textContent).toContain('Claude Code (default)');
    expect(container.querySelector('.topic-composer__advanced')).toBeNull();
  });

  it('blocks start when the selected provider is unavailable', () => {
    useConfigStore.setState({
      defaultAgent: 'opencode',
      frameworks: [
        framework('opencode', {
          displayName: 'OpenCode',
          availability: { installed: false, reason: 'opencode CLI missing' },
        }),
      ],
    });
    renderComposer();
    const ta = container.querySelector(
      '.topic-composer__ta'
    ) as HTMLTextAreaElement;
    const provider = container.querySelector(
      '.topic-composer__provider-select'
    ) as HTMLSelectElement;
    const start = container.querySelector(
      '.topic-composer__bar button[type="submit"]'
    ) as HTMLButtonElement;

    act(() => setNativeValue(ta, 'try unavailable provider'));

    expect(provider.value).toBe('opencode');
    expect(provider.selectedOptions[0]?.textContent).toContain(
      'OpenCode (default) (unavailable)'
    );
    expect(getProviderStatus(provider)?.textContent).toBe(
      'global default · unavailable: opencode CLI missing'
    );
    expect(start.disabled).toBe(true);
  });

  it('allows note room creation when the default provider is unavailable', async () => {
    vi.mocked(createWorkspaceTopicRoomAndMaybeLaunch).mockResolvedValue({
      status: 'created',
      topic: { id: 'topic:note' },
      workContext: { id: 'wc:note' },
    } as never);
    useConfigStore.setState({
      defaultAgent: 'opencode',
      frameworks: [
        framework('opencode', {
          displayName: 'OpenCode',
          availability: { installed: false, reason: 'opencode CLI missing' },
        }),
      ],
    });
    renderComposer();
    const ta = container.querySelector(
      '.topic-composer__ta'
    ) as HTMLTextAreaElement;
    const toggle = container.querySelector(
      '.topic-composer__advanced-toggle'
    ) as HTMLButtonElement;
    act(() => {
      setNativeValue(ta, 'capture the note');
      toggle.click();
    });
    const templateSelect = Array.from(
      container.querySelectorAll('select')
    ).find((select) =>
      Array.from(select.options).some((option) => option.value === 'note')
    ) as HTMLSelectElement;
    act(() => setSelectValue(templateSelect, 'note'));
    const start = container.querySelector(
      '.topic-composer__bar button[type="submit"]'
    ) as HTMLButtonElement;

    expect(start.textContent).toBe('create chat');
    expect(start.disabled).toBe(false);

    const form = container.querySelector(
      '.topic-composer__form'
    ) as HTMLFormElement;
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true }));
    });
    const call = vi.mocked(createWorkspaceTopicRoomAndMaybeLaunch).mock
      .calls[0]?.[0] as { launch?: unknown };
    expect(call.launch).toBeUndefined();
  });

  it('allows advanced create-only when the selected provider is unavailable', async () => {
    vi.mocked(createWorkspaceTopicRoomAndMaybeLaunch).mockResolvedValue({
      status: 'created',
      topic: { id: 'topic:create-only' },
      workContext: { id: 'wc:create-only' },
    } as never);
    useConfigStore.setState({
      defaultAgent: 'opencode',
      frameworks: [
        framework('opencode', {
          displayName: 'OpenCode',
          availability: { installed: false, reason: 'opencode CLI missing' },
        }),
      ],
    });
    renderComposer();
    const ta = container.querySelector(
      '.topic-composer__ta'
    ) as HTMLTextAreaElement;
    const toggle = container.querySelector(
      '.topic-composer__advanced-toggle'
    ) as HTMLButtonElement;
    act(() => {
      setNativeValue(ta, 'create the room first');
      toggle.click();
    });
    const createOnly = container.querySelector(
      '.topic-composer__advanced-actions button'
    ) as HTMLButtonElement;

    expect(createOnly.disabled).toBe(false);

    await act(async () => {
      createOnly.click();
    });
    const call = vi.mocked(createWorkspaceTopicRoomAndMaybeLaunch).mock
      .calls[0]?.[0] as { launch?: unknown };
    expect(call.launch).toBeUndefined();
  });

  // #1287 slice 4: the composer sends an id it owns, so a retry after a failed
  // create collides with its own row (self-explaining 409, adopted) instead of
  // forking a second channel + WorkContext every time the operator presses
  // retry — the loop that evicts archived transcripts at the store cap.
  it('retries a failed create on the SAME client-owned channel id', async () => {
    const roomIds = (): Array<string | undefined> =>
      vi
        .mocked(createWorkspaceTopicRoomAndMaybeLaunch)
        .mock.calls.map(
          (call) =>
            (call[0] as { room: { topic: { id?: string } } }).room.topic.id
        );
    vi.mocked(createWorkspaceTopicRoomAndMaybeLaunch)
      .mockRejectedValueOnce({
        stage: 'topic',
        message: 'network went away after the write',
        retryable: true,
      })
      .mockResolvedValue({
        status: 'created',
        topic: { id: 'topic:adopted' },
        workContext: { id: 'wc:adopted' },
      } as never);
    renderComposer();
    const ta = container.querySelector(
      '.topic-composer__ta'
    ) as HTMLTextAreaElement;
    const toggle = container.querySelector(
      '.topic-composer__advanced-toggle'
    ) as HTMLButtonElement;
    act(() => {
      setNativeValue(ta, 'capture the note');
      toggle.click();
    });
    const templateSelect = Array.from(
      container.querySelectorAll('select')
    ).find((select) =>
      Array.from(select.options).some((option) => option.value === 'note')
    ) as HTMLSelectElement;
    act(() => setSelectValue(templateSelect, 'note'));
    const form = container.querySelector(
      '.topic-composer__form'
    ) as HTMLFormElement;

    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true }));
    });
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true }));
    });

    const [first, second] = roomIds();
    expect(first).toMatch(/^topic:[0-9a-hjkmnp-tv-z]{26}$/);
    expect(second).toBe(first);
  });

  it('gives the next chat its own id once a create commits', async () => {
    vi.mocked(createWorkspaceTopicRoomAndMaybeLaunch).mockResolvedValue({
      status: 'created',
      topic: { id: 'topic:committed' },
      workContext: { id: 'wc:committed' },
    } as never);
    renderComposer();
    const ta = container.querySelector(
      '.topic-composer__ta'
    ) as HTMLTextAreaElement;
    const toggle = container.querySelector(
      '.topic-composer__advanced-toggle'
    ) as HTMLButtonElement;
    act(() => {
      setNativeValue(ta, 'first note');
      toggle.click();
    });
    const templateSelect = Array.from(
      container.querySelectorAll('select')
    ).find((select) =>
      Array.from(select.options).some((option) => option.value === 'note')
    ) as HTMLSelectElement;
    act(() => setSelectValue(templateSelect, 'note'));
    const form = container.querySelector(
      '.topic-composer__form'
    ) as HTMLFormElement;

    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true }));
    });
    // A committed create clears the draft, so the next chat is typed fresh.
    act(() => {
      setNativeValue(ta, 'second note');
      setSelectValue(
        Array.from(container.querySelectorAll('select')).find((select) =>
          Array.from(select.options).some((option) => option.value === 'note')
        ) as HTMLSelectElement,
        'note'
      );
    });
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true }));
    });

    const calls = vi.mocked(createWorkspaceTopicRoomAndMaybeLaunch).mock.calls;
    const ids = calls.map(
      (call) => (call[0] as { room: { topic: { id?: string } } }).room.topic.id
    );
    expect(ids).toHaveLength(2);
    expect(ids[1]).not.toBe(ids[0]);
  });

  it('keeps the metadata fields behind the advanced disclosure', () => {
    renderComposer();
    expect(container.querySelector('.topic-composer__advanced')).toBeNull();
    const toggle = container.querySelector(
      '.topic-composer__advanced-toggle'
    ) as HTMLButtonElement;
    act(() => toggle.click());
    const advanced = container.querySelector('.topic-composer__advanced');
    expect(advanced).not.toBeNull();
    expect(advanced?.textContent).toContain('agent id');
    expect(advanced?.textContent).toContain('node');
    expect(advanced?.textContent).toContain('reference');
    expect(
      advanced?.querySelector('input[list="topic-composer-provider-options"]')
    ).toBeNull();
  });

  it('opens the default agent channel and posts the first message', async () => {
    const dmId = dmChannelTopicId('claude', null);
    vi.mocked(fetchWorkspaceTopic).mockResolvedValue({
      id: dmId,
      workspaceId: 'workspace:local',
      routingDefaults: { providerId: 'claude' },
      display: { title: 'Claude Code' },
    } as never);
    vi.mocked(postChannelMessage).mockResolvedValue({} as never);
    renderComposer();
    const ta = container.querySelector(
      '.topic-composer__ta'
    ) as HTMLTextAreaElement;
    act(() => setNativeValue(ta, 'triage the reconnect flake'));
    const form = container.querySelector(
      '.topic-composer__form'
    ) as HTMLFormElement;
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true }));
    });
    expect(createWorkspaceTopicRoomAndMaybeLaunch).not.toHaveBeenCalled();
    expect(postChannelMessage).toHaveBeenCalledWith(
      dmId,
      expect.objectContaining({ text: 'triage the reconnect flake' })
    );
    expect(useUiStore.getState().activeChannelId).toBe(dmId);
  });

  it('routes a one-off provider override to its DM channel', async () => {
    const dmId = dmChannelTopicId('hermes', null);
    vi.mocked(fetchWorkspaceTopic).mockResolvedValue({
      id: dmId,
      workspaceId: 'workspace:local',
      routingDefaults: { providerId: 'hermes' },
      display: { title: 'Hermes' },
    } as never);
    vi.mocked(postChannelMessage).mockResolvedValue({} as never);
    renderComposer();
    const ta = container.querySelector(
      '.topic-composer__ta'
    ) as HTMLTextAreaElement;
    const provider = container.querySelector(
      '.topic-composer__provider-select'
    ) as HTMLSelectElement;
    act(() => {
      setNativeValue(ta, 'ship through hermes');
      setSelectValue(provider, 'hermes');
    });
    expect(useConfigStore.getState().defaultAgent).toBe('claude');
    expect(getProviderStatus(provider)?.textContent).toBe(
      'one-off override · chat'
    );

    const form = container.querySelector(
      '.topic-composer__form'
    ) as HTMLFormElement;
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true }));
    });

    expect(createWorkspaceTopicRoomAndMaybeLaunch).not.toHaveBeenCalled();
    // The DM channel is opened and the first message posted into it.
    expect(postChannelMessage).toHaveBeenCalledWith(
      dmId,
      expect.objectContaining({ text: 'ship through hermes' })
    );
    expect(useUiStore.getState().activeChannelId).toBe(dmId);
    expect(useUiStore.getState().topicComposerOpen).toBe(false);
    // Settings default is untouched by the one-off override.
    expect(useConfigStore.getState().defaultAgent).toBe('claude');
  });

  it('creates the DM channel when it does not exist yet, reusing its id (#1166)', async () => {
    const dmId = dmChannelTopicId('hermes', null);
    const { HttpError } = await import('../frontend/src/lib/api.js');
    vi.mocked(fetchWorkspaceTopic).mockRejectedValue(new HttpError(404));
    vi.mocked(createWorkspaceTopic).mockResolvedValue({
      id: dmId,
      workspaceId: 'workspace:local',
      routingDefaults: { providerId: 'hermes' },
      display: { title: 'Hermes' },
    } as never);
    vi.mocked(postChannelMessage).mockResolvedValue({} as never);
    renderComposer();
    const ta = container.querySelector(
      '.topic-composer__ta'
    ) as HTMLTextAreaElement;
    const provider = container.querySelector(
      '.topic-composer__provider-select'
    ) as HTMLSelectElement;
    act(() => {
      setNativeValue(ta, 'first hermes message');
      setSelectValue(provider, 'hermes');
    });
    const form = container.querySelector(
      '.topic-composer__form'
    ) as HTMLFormElement;
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true }));
    });
    // Created with the SAME deterministic id fetchWorkspaceTopic looked up.
    const createArg = vi.mocked(createWorkspaceTopic).mock.calls[0]?.[0];
    expect(createArg?.id).toBe(dmId);
    expect(createArg?.routingDefaults).toEqual({ providerId: 'hermes' });
    expect(useUiStore.getState().activeChannelId).toBe(dmId);
  });

  it('opens the DM via the channel path only — never the session-selection callback (#1178)', async () => {
    // Regression for the flash-and-close bug: routing the topic id through
    // onSelectSession (→ handleSelectSession → setActiveSessionId in the app)
    // triggers the channel↔session mutual-exclusion effect, which clears the
    // channel we just opened AND persists a bogus 'topic:...' active-session key.
    const dmId = dmChannelTopicId('hermes', null);
    vi.mocked(fetchWorkspaceTopic).mockResolvedValue({
      id: dmId,
      workspaceId: 'workspace:local',
      routingDefaults: { providerId: 'hermes' },
      display: { title: 'Hermes' },
    } as never);
    vi.mocked(postChannelMessage).mockResolvedValue({} as never);
    const onSelectSession = vi.fn();
    renderComposer(onSelectSession);
    const ta = container.querySelector(
      '.topic-composer__ta'
    ) as HTMLTextAreaElement;
    const provider = container.querySelector(
      '.topic-composer__provider-select'
    ) as HTMLSelectElement;
    act(() => {
      setNativeValue(ta, 'via hermes');
      setSelectValue(provider, 'hermes');
    });
    const form = container.querySelector(
      '.topic-composer__form'
    ) as HTMLFormElement;
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true }));
    });

    // Channel opened, and NO session key was routed/persisted.
    expect(useUiStore.getState().activeChannelId).toBe(dmId);
    expect(onSelectSession).not.toHaveBeenCalled();
    expect(useSessionsStore.getState().activeSessionId).toBeNull();
  });

  // The channel landing is opened BEFORE the opening post, so a failed post
  // unmounts the composer (ChatHome swaps in ChannelView) and the
  // `launchFailure` banner has nowhere to render. A toast is the only
  // operator-visible signal left — without it the failure was silent.
  describe('a failed opening post stays visible (#1287)', () => {
    const dmId = dmChannelTopicId('claude', null);

    function stubDm(): void {
      vi.mocked(fetchWorkspaceTopic).mockResolvedValue({
        id: dmId,
        workspaceId: 'workspace:local',
        routingDefaults: { providerId: 'claude' },
        display: { title: 'Claude Code' },
      } as never);
    }

    async function submitOpeningPrompt(): Promise<void> {
      useToastStore.setState({ toasts: [] });
      renderChatHome(vi.fn());
      const ta = container.querySelector(
        '.topic-composer__ta'
      ) as HTMLTextAreaElement;
      act(() => setNativeValue(ta, 'triage the reconnect flake'));
      const form = container.querySelector(
        '.topic-composer__form'
      ) as HTMLFormElement;
      await act(async () => {
        form.dispatchEvent(new Event('submit', { bubbles: true }));
      });
    }

    it('toasts the reason when the opening post fails', async () => {
      stubDm();
      const { HttpError } = await import('../frontend/src/lib/api.js');
      vi.mocked(postChannelMessage).mockRejectedValue(
        new HttpError(503, 'hub unreachable')
      );

      await submitOpeningPrompt();

      // Landed on the channel, so the composer (and its banner) is gone.
      expect(useUiStore.getState().activeChannelId).toBe(dmId);
      expect(container.querySelector('.topic-composer__failure')).toBeNull();
      const messages = useToastStore
        .getState()
        .toasts.map((toast) => toast.message);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain('could not start the chat');
      expect(messages[0]).toContain('hub unreachable');
    });

    it('keeps the archived blocker on its own remedy, not the generic toast', async () => {
      stubDm();
      const { HttpError } = await import('../frontend/src/lib/api.js');
      vi.mocked(postChannelMessage).mockRejectedValue(
        new HttpError(409, 'channel is archived', 'SESSION_CONFLICT', false, {
          channelId: dmId,
          reasonCode: 'CHANNEL_ARCHIVED',
        })
      );

      await submitOpeningPrompt();

      expect(useUiStore.getState().activeChannelId).toBe(dmId);
      expect(
        useToastStore.getState().toasts.map((toast) => toast.message)
      ).toEqual([ARCHIVED_CHANNEL_PROMPT_NOTICE]);
    });
  });

  it('resumes the most recent explicit terminal session', async () => {
    const ptySession = {
      id: 'sess-pty',
      type: 'terminal',
      mode: 'pty',
      repoPath: '/repo/relay-ide',
      cwd: '/repo/relay-ide',
      displayName: 'terminal session',
      createdAt: '2026-07-05T00:00:00.000Z',
      lastActivity: '2026-07-05T00:00:00.000Z',
      idle: false,
    } as const;
    useSessionsStore.setState({
      sessions: [ptySession],
      activeSessionId: null,
      refreshAll: vi.fn(async () => {}),
    });
    useUiStore.setState({
      activeRepoPath: null,
      forceOrgCockpit: false,
      topicComposerOpen: false,
      activeChannelId: null,
    });

    const onSelectSession = vi.fn();
    renderChatHome(onSelectSession);

    const resumeBtn = Array.from(
      container.querySelectorAll('.topic-composer__footer button')
    ).find((b) => b.textContent?.startsWith('resume')) as
      | HTMLButtonElement
      | undefined;
    expect(resumeBtn?.textContent).toContain('terminal session');

    await act(async () => resumeBtn?.click());
    expect(onSelectSession).toHaveBeenCalledWith(scopedSessionKey(ptySession));
  });

  it('selects an explicitly launched terminal while the sessions feed catches up', async () => {
    vi.mocked(createWorkspaceTopicRoomAndMaybeLaunch).mockResolvedValue({
      status: 'launched',
      topic: { id: 'topic:launched' },
      workContext: { id: 'wc:launched' },
      session: {
        id: 'session-late',
        type: 'terminal',
        mode: 'pty',
        repoPath: '/repo/relay-ide',
        cwd: '/repo/relay-ide',
        displayName: 'late session',
        createdAt: '2026-07-03T00:00:00.000Z',
        lastActivity: '2026-07-03T00:00:00.000Z',
        idle: false,
      },
    } as never);
    const refreshAll = vi.fn(async () => {});
    useSessionsStore.setState({
      sessions: [],
      repos: [
        {
          path: '/repo/relay-ide',
          name: 'relay-ide',
          isGitRepo: true,
          kind: 'repo',
          defaultBranch: 'nightly',
          currentBranch: 'issue-1122-ruthless-core-loop',
        },
      ],
      activeSessionId: null,
      refreshAll,
    });
    useUiStore.setState({
      activeRepoPath: '/repo/relay-ide',
      forceOrgCockpit: true,
    });
    const onSelectSession = vi.fn(() => {
      useUiStore.getState().setActiveRepoPath('/repo/relay-ide');
    });
    renderComposer(onSelectSession);
    const ta = container.querySelector(
      '.topic-composer__ta'
    ) as HTMLTextAreaElement;
    const form = container.querySelector(
      '.topic-composer__form'
    ) as HTMLFormElement;
    const toggle = container.querySelector(
      '.topic-composer__advanced-toggle'
    ) as HTMLButtonElement;
    act(() => {
      setNativeValue(ta, 'start from repo context');
      toggle.click();
    });
    const templateSelect = Array.from(
      container.querySelectorAll('select')
    ).find((select) =>
      Array.from(select.options).some(
        (option) => option.value === 'terminal-task'
      )
    ) as HTMLSelectElement;
    act(() => setSelectValue(templateSelect, 'terminal-task'));

    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true }));
    });

    expect(refreshAll).toHaveBeenCalledTimes(1);
    expect(useSessionsStore.getState().activeSessionId).toBe('session-late');
    expect(useSessionsStore.getState().sessions).toContainEqual(
      expect.objectContaining({ id: 'session-late' })
    );
    expect(useUiStore.getState().activeRepoPath).toBeNull();
    expect(useUiStore.getState().forceOrgCockpit).toBe(false);
    expect(onSelectSession).toHaveBeenCalledWith('session-late');
  });

  it('falls back to the channel landing for a stale active-session key', () => {
    useSessionsStore.setState({
      sessions: [],
      activeSessionId: 'retired-session-key',
      refreshAll: vi.fn(async () => {}),
    });
    useUiStore.setState({
      activeRepoPath: null,
      forceOrgCockpit: false,
      activeChannelId: null,
    });
    const onSelectSession = vi.fn();
    renderChatHome(onSelectSession);
    expect(container.querySelector('.topic-composer')).not.toBeNull();
    expect(
      container.querySelector('[aria-label="archived session"]')
    ).toBeNull();
  });

  // #1287: the exact operator scenario. Mid-session with a channel from the OLD
  // workspace still on screen, the operator adds a project and selects its
  // fresh (empty) lane — which holds no channel row to click, so the sidebar
  // "new chat" button is the only route out. `openTopicTaskRoom` latched
  // `topicComposerOpen` but never cleared `activeChannelId`, and an open
  // channel outranks the composer in BOTH decision points (`resolveAppViewMode`
  // checks `hasActiveChannel` first, and `ChatHome` only mounts `TopicComposer`
  // when `activeChannelId` is null). Result: the screen never changed, the
  // focus event fired at an unmounted composer, and no request ever left the
  // browser — matching the clean server logs.
  it('opens the composer over a channel left open in the previous workspace (#1287)', () => {
    const freshLane = 'ws:fresh-project';
    useSessionsStore.setState({
      sessions: [],
      activeSessionId: null,
      refreshAll: vi.fn(async () => {}),
    });
    useUiStore.setState({
      activeRepoPath: null,
      forceOrgCockpit: false,
      topicComposerOpen: false,
      activeChannelId: 'topic:old-workspace-channel',
      activeWorkspaceId: freshLane,
    });

    // The REAL shared entry point behind every new-chat affordance (sidebar
    // header, empty-lane button, mobile header, command palette).
    openTopicTaskRoom();

    const ui = useUiStore.getState();
    expect(ui.topicComposerOpen).toBe(true);
    // The open channel must be dropped, or the composer is unreachable.
    expect(ui.activeChannelId).toBeNull();
    // The freshly selected lane survives, so the chat files into THIS project.
    expect(ui.activeWorkspaceId).toBe(freshLane);
    expect(
      resolveAppViewMode({
        analyticsView: ui.analyticsView,
        hasActiveSession: false,
        activeRepoPath: ui.activeRepoPath,
        forceOrgCockpit: ui.forceOrgCockpit,
        topicComposerOpen: ui.topicComposerOpen,
        hasActiveChannel: ui.activeChannelId !== null,
      })
    ).toBe('chat');

    // The assertion that would have caught the regression: inside the chat
    // shell it is the composer, not a re-rendered ChannelView, that mounts.
    renderChatHome(vi.fn());
    expect(container.querySelector('.topic-composer__ta')).not.toBeNull();
  });

  it('keeps the created room when retrying a terminal launch failure', async () => {
    vi.mocked(createWorkspaceTopicRoomAndMaybeLaunch).mockResolvedValueOnce({
      status: 'launch_failed',
      topic: { id: 'topic:retry' },
      workContext: { id: 'wc:retry' },
      failure: {
        stage: 'session',
        message: 'provider temporarily unavailable',
        retryable: true,
      },
    } as never);
    vi.mocked(launchWorkspaceTopicRoom).mockResolvedValueOnce({
      status: 'launch_failed',
      topic: { id: 'topic:retry' },
      workContext: { id: 'wc:retry' },
      failure: {
        stage: 'session',
        message: 'still unavailable',
        retryable: true,
      },
    } as never);
    renderComposer();
    const ta = container.querySelector(
      '.topic-composer__ta'
    ) as HTMLTextAreaElement;
    const toggle = container.querySelector(
      '.topic-composer__advanced-toggle'
    ) as HTMLButtonElement;
    act(() => {
      setNativeValue(ta, 'retry this launch');
      toggle.click();
    });
    const templateSelect = Array.from(
      container.querySelectorAll('select')
    ).find((select) =>
      Array.from(select.options).some(
        (option) => option.value === 'terminal-task'
      )
    ) as HTMLSelectElement;
    act(() => setSelectValue(templateSelect, 'terminal-task'));
    const form = container.querySelector(
      '.topic-composer__form'
    ) as HTMLFormElement;
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true }));
    });
    expect(
      container.querySelector('.topic-composer__failure')?.textContent
    ).toContain('provider temporarily unavailable');

    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true }));
    });
    expect(launchWorkspaceTopicRoom).toHaveBeenCalledWith({
      room: {
        topic: { id: 'topic:retry' },
        workContext: { id: 'wc:retry' },
      },
      launch: expect.objectContaining({ type: 'terminal', mode: 'pty' }),
    });
  });
});

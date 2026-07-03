// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildTopicRoomCreateInput,
  buildTopicRoomLaunchBody,
  deriveTopicProviderLaunchMode,
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
  };
});

import { createWorkspaceTopicRoomAndMaybeLaunch, launchWorkspaceTopicRoom } from '../frontend/src/lib/api.js';
import { useConfigStore } from '../frontend/src/lib/stores/config.js';
import type { FrameworkInfo } from '../frontend/src/lib/types.js';
import TopicComposer from '../frontend/src/components/TopicComposer.js';

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
      supportsWebSessions: false,
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
    expect((derived as unknown as { isWellFormed: () => boolean }).isWellFormed()).toBe(
      true
    );
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

describe('topic provider launch helpers', () => {
  it('seeds provider options from the settings default and framework metadata', () => {
    const options = deriveTopicProviderOptions({
      frameworks: [
        framework('claude', { displayName: 'Claude Code' }),
        framework('hermes', {
          displayName: 'Hermes',
          capabilities: {
            supportsContinue: true,
            supportsYolo: true,
            supportsHooks: false,
            supportsTelemetry: true,
            supportsWebSessions: true,
          },
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
      launchMode: 'web',
      status: 'global default · web launch',
    });
    expect(options.find((option) => option.id === 'claude')).toMatchObject({
      label: 'Claude Code',
      launchMode: 'pty',
    });
  });

  it('derives the shared default launch mode and keeps terminal/custom fallback on pty', () => {
    const frameworks = [
      framework('hermes', {
        capabilities: {
          supportsContinue: true,
          supportsYolo: true,
          supportsHooks: false,
          supportsTelemetry: true,
          supportsWebSessions: true,
        },
      }),
      framework('opencode', {
        capabilities: {
          supportsContinue: true,
          supportsYolo: true,
          supportsHooks: false,
          supportsTelemetry: false,
          supportsWebSessions: true,
        },
      }),
      framework('codex'),
      framework('custom:local'),
    ];

    expect(deriveTopicProviderLaunchMode('hermes', 'agent-task', frameworks)).toBe(
      'web'
    );
    expect(deriveTopicProviderLaunchMode('codex', 'agent-task', frameworks)).toBe(
      'pty'
    );
    expect(
      deriveTopicProviderLaunchMode('opencode', 'agent-task', frameworks)
    ).toBe('pty');
    expect(
      deriveTopicProviderLaunchMode('custom:local', 'agent-task', frameworks)
    ).toBe('pty');
    expect(
      deriveTopicProviderLaunchMode('hermes', 'terminal-task', frameworks)
    ).toBe('pty');
  });

  it('surfaces unavailable framework copy and falls Hermes web back to pty when degraded', () => {
    const options = deriveTopicProviderOptions({
      frameworks: [
        framework('hermes', {
          capabilities: {
            supportsContinue: true,
            supportsYolo: true,
            supportsHooks: false,
            supportsTelemetry: true,
            supportsWebSessions: true,
          },
          webAvailability: {
            available: false,
            reason: 'Hermes API server is not reachable',
          },
        }),
        framework('claude', {
          availability: { installed: false, reason: 'claude CLI missing' },
        }),
      ],
      defaultProviderId: 'claude',
      selectedProviderId: 'claude',
      templateKind: 'agent-task',
    });

    expect(options.find((option) => option.id === 'hermes')).toMatchObject({
      launchMode: 'pty',
      status:
        'one-off override · tui launch · web unavailable: Hermes API server is not reachable',
    });
    expect(options.find((option) => option.id === 'claude')).toMatchObject({
      disabled: true,
      status: 'global default · unavailable: claude CLI missing',
    });
  });

  it('puts the derived launch mode into the session body', () => {
    const frameworks = [
      framework('hermes', {
        capabilities: {
          supportsContinue: true,
          supportsYolo: true,
          supportsHooks: false,
          supportsTelemetry: true,
          supportsWebSessions: true,
        },
      }),
    ];
    const create = buildTopicRoomCreateInput({
      draft: { ...TOPIC_ROOM_DRAFT_EMPTY, prompt: 'run it' },
      workspaceId: null,
      defaultProviderId: 'hermes',
      taskRef: null,
    });

    expect(buildTopicRoomLaunchBody(create, 'agent-task', frameworks)).toMatchObject({
      type: 'agent',
      mode: 'web',
      agent: 'hermes',
    });
    expect(buildTopicRoomLaunchBody(create, 'terminal-task', frameworks)).toMatchObject({
      type: 'terminal',
      mode: 'pty',
    });
  });

  it('keeps OpenCode on tui launch by default even when it exposes web mode', () => {
    const frameworks = [
      framework('opencode', {
        displayName: 'OpenCode',
        capabilities: {
          supportsContinue: true,
          supportsYolo: true,
          supportsHooks: false,
          supportsTelemetry: false,
          supportsWebSessions: true,
        },
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
      launchMode: 'pty',
      status: 'global default · tui launch',
    });
    expect(buildTopicRoomLaunchBody(create, 'agent-task', frameworks)).toMatchObject({
      type: 'agent',
      mode: 'pty',
      agent: 'opencode',
    });
  });
});

describe('TopicComposer', () => {
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
          capabilities: {
            supportsContinue: true,
            supportsYolo: true,
            supportsHooks: false,
            supportsTelemetry: true,
            supportsWebSessions: true,
          },
        }),
      ],
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
  });

  function renderComposer() {
    act(() =>
      root.render(
        React.createElement(
          QueryClientProvider,
          { client: queryClient },
          React.createElement(TopicComposer, {})
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
      'global default · tui launch'
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

  it('creates and launches with the derived title on submit', async () => {
    vi.mocked(createWorkspaceTopicRoomAndMaybeLaunch).mockResolvedValue({
      status: 'created',
      topic: { id: 'topic:1' },
      workContext: { id: 'wc:1' },
    } as never);
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
    expect(createWorkspaceTopicRoomAndMaybeLaunch).toHaveBeenCalledTimes(1);
    const call = vi.mocked(createWorkspaceTopicRoomAndMaybeLaunch).mock
      .calls[0]?.[0] as {
      room: { topic: { title: string } };
      launch?: unknown;
    };
    expect(call.room.topic.title).toBe('triage the reconnect flake');
    expect(call.launch).toBeDefined();
  });

  it('uses a one-off provider override without mutating settings', async () => {
    vi.mocked(createWorkspaceTopicRoomAndMaybeLaunch).mockResolvedValue({
      status: 'created',
      topic: { id: 'topic:1' },
      workContext: { id: 'wc:1' },
    } as never);
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
      'one-off override · web launch'
    );

    const form = container.querySelector(
      '.topic-composer__form'
    ) as HTMLFormElement;
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true }));
    });
    const call = vi.mocked(createWorkspaceTopicRoomAndMaybeLaunch).mock
      .calls[0]?.[0] as {
      room: { topic: { routingDefaults?: { providerId?: string } } };
      launch?: { mode?: string; agent?: string };
    };
    expect(call.room.topic.routingDefaults?.providerId).toBe('hermes');
    expect(call.launch).toMatchObject({ mode: 'web', agent: 'hermes' });
    expect(useConfigStore.getState().defaultAgent).toBe('claude');
  });

  it('keeps the created room and provider launch mode when retrying after session launch failure', async () => {
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
    const provider = container.querySelector(
      '.topic-composer__provider-select'
    ) as HTMLSelectElement;
    act(() => {
      setNativeValue(ta, 'retry this launch');
      setSelectValue(provider, 'hermes');
    });
    const form = container.querySelector(
      '.topic-composer__form'
    ) as HTMLFormElement;
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true }));
    });
    expect(container.querySelector('.topic-composer__failure')?.textContent).toContain(
      'provider temporarily unavailable'
    );

    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true }));
    });
    expect(launchWorkspaceTopicRoom).toHaveBeenCalledWith({
      room: {
        topic: { id: 'topic:retry' },
        workContext: { id: 'wc:retry' },
      },
      launch: expect.objectContaining({ mode: 'web', agent: 'hermes' }),
    });
  });
});

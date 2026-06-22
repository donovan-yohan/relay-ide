// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import CommandPalette from '../frontend/src/components/CommandPalette.js';
import {
  commandCenterAssistantCopy,
  decideOpenUiAction,
  type CommandCenterAssistantResult,
} from '../frontend/src/lib/command-center-assistant.js';
import {
  _resetForTesting,
  registerGlobal,
} from '../frontend/src/lib/actions/registry.js';
import type {
  Action,
  ActionContext,
} from '../frontend/src/lib/actions/types.js';
import type { CommandCenterExecutionResult } from '../shared/command-center-execution.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const actionContext: ActionContext = {
  view: 'session',
  workspacePath: '/repo',
  cwd: '/repo',
  isMobile: false,
};

function resultFor(
  resolution: CommandCenterAssistantResult['resolution']
): CommandCenterAssistantResult {
  return {
    resolution,
    audit: {
      outcome: resolution.kind,
      suggestionCount: resolution.suggestions.length,
    },
  };
}

const sessionsListEntry = {
  commandId: 'sessions.list',
  label: 'sessions list',
  summary: 'List Relay sessions',
  keywords: ['sessions', 'list'],
  sideEffect: 'read',
  requiresConfirmation: false,
  controlRequirements: [],
  scopeKinds: ['session'],
  capabilityHints: ['session:read'],
  surfaces: ['web', 'command-center'],
  availability: { state: 'available' },
  ui: { actionId: 'session.start-work-in-env', category: 'session' },
  inputSchema: { type: 'object', additionalProperties: false, properties: {} },
} as const;

function openUiResult(): CommandCenterAssistantResult {
  return resultFor({
    kind: 'open_ui',
    entry: sessionsListEntry,
    intent: {
      commandId: 'sessions.list',
      args: {},
      confidence: 0.92,
      sideEffect: 'read',
      requiresConfirmation: false,
      controlRequirements: [],
      scopeKinds: ['session'],
      capabilityHints: ['session:read'],
      surfaces: ['web', 'command-center'],
      ui: { actionId: 'session.start-work-in-env', category: 'session' },
    },
    ui: { actionId: 'session.start-work-in-env', category: 'session' },
    suggestions: [],
  });
}

function providerMissingResult(): CommandCenterAssistantResult {
  return resultFor({
    kind: 'no_match',
    reason: 'provider-missing',
    suggestions: [{ entry: sessionsListEntry, score: 4 }],
  });
}

function executeCommandResult(): CommandCenterAssistantResult {
  return resultFor({
    kind: 'execute_command',
    entry: sessionsListEntry,
    intent: {
      commandId: 'sessions.list',
      args: {},
      confidence: 0.92,
      sideEffect: 'read',
      requiresConfirmation: false,
      controlRequirements: [],
      scopeKinds: ['session'],
      capabilityHints: ['session:read'],
      surfaces: ['web', 'command-center'],
      ui: { actionId: 'gateway.sessions.list', category: 'gateway' },
    },
    suggestions: [],
  });
}

function executionSuccess(): CommandCenterExecutionResult {
  return {
    kind: 'success',
    commandId: 'sessions.list',
    data: { sessions: [] },
    audit: {
      commandId: 'sessions.list',
      resultKind: 'success',
      sideEffectClass: 'read',
      durationMs: 4,
      args: {
        rawArgsReturned: false,
        argKeys: [],
        argsSha256:
          '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
      },
      policyOutcome: 'allowed',
      confirmationOutcome: 'not-required',
      scopeKinds: ['session'],
      availabilityState: 'available',
      capabilityOutcome: 'allowed-browser-session',
    },
  };
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value'
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('Command Center assistant shell helpers', () => {
  it('renders provider and policy states as recoverable copy', () => {
    expect(
      commandCenterAssistantCopy(providerMissingResult().resolution).detail
    ).toContain('deterministic Command Center search still works');
    expect(
      commandCenterAssistantCopy({
        kind: 'no_match',
        reason: 'unsafe-command',
        suggestions: [],
      }).title
    ).toBe('policy blocked this action');
  });

  it('allows the mobile guided env-picker open_ui but blocks raw gateway actions', () => {
    const guidedAction: Action = {
      id: 'session.start-work-in-env',
      label: 'start work in environment…',
      category: 'session',
      handler: () => {},
      descriptor: {
        id: 'sessions.create',
        title: 'create session',
        label: 'create session',
        input: { kind: 'json-schema', schema: { type: 'object' } },
        availability: { state: 'available' },
        sideEffect: 'write',
        confirmation: { required: false, controlRequirements: [] },
        surfaces: ['web', 'command-center'],
        result: { kind: 'json-schema', schema: { type: 'object' } },
        error: { kind: 'json-schema', schema: { type: 'object' } },
        stable: true,
        source: 'cli-gateway-v1',
        ui: { actionId: 'session.start-work-in-env', category: 'session' },
      },
    };
    const gatewayAction: Action = {
      ...guidedAction,
      id: 'gateway.sessions.create',
      category: 'gateway',
    };

    expect(
      decideOpenUiAction(guidedAction, { ...actionContext, isMobile: true })
        .canOpen
    ).toBe(true);
    expect(decideOpenUiAction(gatewayAction, actionContext).canOpen).toBe(
      false
    );
    expect(
      decideOpenUiAction(
        { ...guidedAction, id: 'session.new-agent' },
        actionContext
      ).canOpen
    ).toBe(false);
  });
});

describe('<CommandPalette /> assistant shell', () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    _resetForTesting();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = new QueryClient();
  });

  afterEach(() => {
    act(() => root.unmount());
    queryClient.clear();
    container.remove();
    _resetForTesting();
  });

  async function render(
    resolveAssistantIntent: (
      query: string
    ) => Promise<CommandCenterAssistantResult>,
    options: {
      open?: boolean;
      executeAssistantCommand?: (
        commandId: string,
        args: Record<string, unknown>
      ) => Promise<CommandCenterExecutionResult>;
    } = {}
  ) {
    await act(async () => {
      root.render(
        React.createElement(
          QueryClientProvider,
          { client: queryClient },
          React.createElement(CommandPalette, {
            open: options.open ?? true,
            workspaces: [],
            sessions: [],
            actionContext,
            onClose: vi.fn(),
            onSelectWorkspace: vi.fn(),
            onSelectSession: vi.fn(),
            onSelectPr: vi.fn(),
            resolveAssistantIntent,
            executeAssistantCommand: options.executeAssistantCommand,
          })
        )
      );
    });
  }

  it('drops in-flight assistant results when the palette closes', async () => {
    let resolveRequest:
      | ((result: CommandCenterAssistantResult) => void)
      | null = null;
    const resolveAssistantIntent = vi.fn(
      () =>
        new Promise<CommandCenterAssistantResult>((resolve) => {
          resolveRequest = resolve;
        })
    );
    await render(resolveAssistantIntent);
    const input = container.querySelector(
      '.palette-search-input'
    ) as HTMLInputElement;
    const ask = container.querySelector(
      '.palette-assistant-button'
    ) as HTMLButtonElement;

    await act(async () => {
      setInputValue(input, 'show sessions');
    });
    await act(async () => {
      ask.click();
    });
    await render(resolveAssistantIntent, { open: false });
    await act(async () => {
      resolveRequest?.(providerMissingResult());
      await Promise.resolve();
    });
    await render(resolveAssistantIntent);

    expect(resolveAssistantIntent).toHaveBeenCalledTimes(1);
    expect(container.textContent).not.toContain(
      'assistant resolver is not configured'
    );
    expect(container.textContent).not.toContain('sessions list');
  });

  it('keeps deterministic search visible when provider is unconfigured', async () => {
    await render(async () => providerMissingResult());
    const input = container.querySelector(
      '.palette-search-input'
    ) as HTMLInputElement;
    const ask = container.querySelector(
      '.palette-assistant-button'
    ) as HTMLButtonElement;

    await act(async () => {
      setInputValue(input, 'show sessions');
    });
    await act(async () => {
      ask.click();
    });

    expect(container.textContent).toContain(
      'assistant resolver is not configured'
    );
    expect(container.textContent).toContain(
      'deterministic Command Center search'
    );
    expect(container.textContent).toContain('sessions list');
  });

  it('opens a registered guided open_ui action from resolver metadata', async () => {
    const handler = vi.fn();
    registerGlobal([
      {
        id: 'session.start-work-in-env',
        label: 'start work in environment…',
        category: 'session',
        handler,
      },
    ]);
    await render(async () => openUiResult());
    const input = container.querySelector(
      '.palette-search-input'
    ) as HTMLInputElement;
    const ask = container.querySelector(
      '.palette-assistant-button'
    ) as HTMLButtonElement;

    await act(async () => {
      setInputValue(input, 'start a terminal somewhere');
    });
    await act(async () => {
      ask.click();
    });
    const openButton = container.querySelector(
      '.palette-assistant-action'
    ) as HTMLButtonElement;
    await act(async () => {
      openButton.click();
    });

    expect(handler).toHaveBeenCalledWith(actionContext);
  });

  it('executes a typed read-only resolver result and renders success state', async () => {
    const executeAssistantCommand = vi.fn(async () => executionSuccess());
    await render(async () => executeCommandResult(), {
      executeAssistantCommand,
    });
    const input = container.querySelector(
      '.palette-search-input'
    ) as HTMLInputElement;
    const ask = container.querySelector(
      '.palette-assistant-button'
    ) as HTMLButtonElement;

    await act(async () => {
      setInputValue(input, 'show sessions');
    });
    await act(async () => {
      ask.click();
    });

    expect(container.textContent).toContain('ready to run read-only command');
    const runButton = container.querySelector(
      '.palette-assistant-action'
    ) as HTMLButtonElement;
    await act(async () => {
      runButton.click();
      await Promise.resolve();
    });

    expect(executeAssistantCommand).toHaveBeenCalledWith('sessions.list', {});
    expect(container.textContent).toContain('command executed');
    expect(container.textContent).toContain('without raw args');
  });
});

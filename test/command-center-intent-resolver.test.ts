import { describe, expect, it, vi } from 'vitest';

import {
  createOpenAiCompatibleCommandCenterIntentProvider,
  readCommandCenterIntentResolverConfig,
  resolveCommandCenterIntent,
  type CommandCenterIntentProvider,
} from '../server/command-center-intent-resolver.js';
import { buildCommandCenterResolverCatalog } from '../shared/command-center-resolver.js';
import type { RelayActionDescriptor } from '../shared/action-descriptor.js';

const descriptor: RelayActionDescriptor = {
  id: 'sessions.list',
  title: 'sessions list',
  label: 'sessions list',
  description: 'List Relay sessions',
  input: {
    kind: 'json-schema',
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: { repoId: { type: 'string' } },
    },
  },
  availability: { state: 'available', capabilityHints: ['session:read'] },
  sideEffect: 'read',
  confirmation: { required: false, controlRequirements: [] },
  surfaces: ['web', 'command-center'],
  result: { kind: 'json-schema', schema: { type: 'object' } },
  error: { kind: 'json-schema', schema: { type: 'object' } },
  stable: true,
  source: 'cli-gateway-v1',
  contract: {
    relayCommandName: 'sessions.list',
    stable: true,
    source: 'shared/relay-command-manifest.ts',
    cli: ['relay-ide', 'v1', 'sessions', 'list', '--json'],
    errorCodes: ['INTERNAL'],
  },
  ui: { actionId: 'gateway.sessions.list', category: 'gateway' },
};

const catalog = buildCommandCenterResolverCatalog([descriptor]);
const request = { query: 'show relay sessions' };

function provider(raw: unknown): CommandCenterIntentProvider {
  return {
    health: async () => ({ state: 'healthy' }),
    propose: async () => raw,
  };
}

describe('Command Center intent resolver wrapper', () => {
  it('falls back with deterministic search when provider is missing', async () => {
    const result = await resolveCommandCenterIntent(request, { catalog });

    expect(result.resolution).toMatchObject({
      kind: 'fallback',
      reason: 'provider-missing',
    });
    expect(result.resolution.suggestions[0]?.entry.commandId).toBe(
      'sessions.list'
    );
    expect(result.audit).toEqual({
      outcome: 'fallback',
      reason: 'provider-missing',
      suggestionCount: 1,
    });
  });

  it('resolves valid fake provider output and redacts prompt/args from audit', async () => {
    const privateArg = 'private-repo-name-that-stays-out-of-audit';
    const result = await resolveCommandCenterIntent(request, {
      catalog,
      provider: provider({
        commandId: 'sessions.list',
        args: { repoId: privateArg },
        confidence: 0.91,
        sideEffect: 'read',
        requiresConfirmation: false,
        capabilityHints: ['session:read'],
        scopeKinds: ['session'],
        surfaces: ['web', 'command-center'],
        ui: { actionId: 'gateway.sessions.list', category: 'gateway' },
      }),
      now: vi.fn().mockReturnValueOnce(10).mockReturnValueOnce(25),
    });

    expect(result.resolution.kind).toBe('resolved');
    expect(JSON.stringify(result.audit)).not.toContain(privateArg);
    expect(JSON.stringify(result.audit)).not.toContain(request.query);
    expect(result.audit).toEqual({
      outcome: 'resolved',
      commandId: 'sessions.list',
      confidence: 0.91,
      durationMs: 15,
      suggestionCount: 1,
    });
  });

  it('falls back for unhealthy provider, timeout, malformed output, and invalid args', async () => {
    const unhealthy: CommandCenterIntentProvider = {
      health: async () => ({ state: 'unreachable', detail: 'network-error' }),
      propose: async () => ({ commandId: 'sessions.list', confidence: 1 }),
    };
    await expect(
      resolveCommandCenterIntent(request, { catalog, provider: unhealthy })
    ).resolves.toMatchObject({
      resolution: { kind: 'fallback', reason: 'provider-unhealthy' },
    });

    const timeout = new Error('provider timed out');
    timeout.name = 'AbortError';
    await expect(
      resolveCommandCenterIntent(request, {
        catalog,
        provider: {
          health: async () => ({ state: 'healthy' }),
          propose: async () => Promise.reject(timeout),
        },
      })
    ).resolves.toMatchObject({
      resolution: { kind: 'fallback', reason: 'timeout' },
    });

    await expect(
      resolveCommandCenterIntent(request, {
        catalog,
        provider: provider('nope'),
      })
    ).resolves.toMatchObject({
      resolution: { kind: 'fallback', reason: 'malformed-output' },
    });
    await expect(
      resolveCommandCenterIntent(request, {
        catalog,
        provider: provider({
          commandId: 'sessions.list',
          args: { rawShell: 'relay-ide v1 sessions list' },
          confidence: 0.9,
        }),
      })
    ).resolves.toMatchObject({
      resolution: { kind: 'fallback', reason: 'invalid-args' },
    });
  });
});

describe('OpenAI-compatible Command Center provider', () => {
  it('reads provider-neutral env config without exposing missing config as healthy', () => {
    expect(readCommandCenterIntentResolverConfig({})).toBeNull();
    expect(
      readCommandCenterIntentResolverConfig({
        RELAY_COMMAND_CENTER_RESOLVER_BASE_URL: 'https://resolver.example/v1/',
        RELAY_COMMAND_CENTER_RESOLVER_MODEL: 'resolver-small',
        RELAY_COMMAND_CENTER_RESOLVER_TIMEOUT_MS: '42',
        RELAY_COMMAND_CENTER_RESOLVER_MIN_CONFIDENCE: '0.7',
      })
    ).toEqual({
      baseUrl: 'https://resolver.example/v1',
      model: 'resolver-small',
      timeoutMs: 42,
      minConfidence: 0.7,
    });
  });

  it('health omits prompt payloads and proposal parses chat completions JSON', async () => {
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith('/models')) {
        expect(init.headers).toMatchObject({
          'content-type': 'application/json',
        });
        return { ok: true, status: 200, json: async () => ({ data: [] }) };
      }
      expect(url).toBe('https://resolver.example/v1/chat/completions');
      const body = JSON.parse(String(init.body)) as {
        messages: Array<{ content: string }>;
      };
      expect(JSON.stringify(body.messages)).toContain('sessions.list');
      expect(JSON.stringify(body.messages)).toContain(request.query);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  commandId: 'sessions.list',
                  args: { repoId: 'repo-1' },
                  confidence: 0.95,
                }),
              },
            },
          ],
        }),
      };
    });

    const openAiProvider = createOpenAiCompatibleCommandCenterIntentProvider(
      {
        baseUrl: 'https://resolver.example/v1',
        model: 'resolver-small',
        timeoutMs: 1000,
        minConfidence: 0.6,
      },
      { fetch, catalog }
    );

    await expect(openAiProvider.health()).resolves.toEqual({
      state: 'healthy',
      model: 'resolver-small',
      baseUrl: 'https://resolver.example/v1',
    });
    await expect(openAiProvider.propose(request)).resolves.toEqual({
      commandId: 'sessions.list',
      args: { repoId: 'repo-1' },
      confidence: 0.95,
    });
    expect(JSON.stringify(await openAiProvider.health())).not.toContain(
      request.query
    );
  });
});

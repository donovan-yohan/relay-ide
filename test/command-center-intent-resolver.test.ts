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
const providerIntent = {
  kind: 'execute_command',
  commandId: 'sessions.list',
  args: { repoId: 'repo-1' },
  confidence: 0.95,
};

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
      kind: 'no_match',
      reason: 'provider-missing',
    });
    expect(result.resolution.suggestions[0]?.entry.commandId).toBe(
      'sessions.list'
    );
    expect(result.audit).toEqual({
      outcome: 'no_match',
      reason: 'provider-missing',
      suggestionCount: 1,
    });
  });

  it('resolves valid fake provider output and redacts prompt/args from audit', async () => {
    const privateArg = 'private-repo-name-that-stays-out-of-audit';
    const result = await resolveCommandCenterIntent(request, {
      catalog,
      provider: provider({
        ...providerIntent,
        args: { repoId: privateArg },
      }),
      now: vi.fn().mockReturnValueOnce(10).mockReturnValueOnce(25),
    });

    expect(result.resolution.kind).toBe('execute_command');
    expect(JSON.stringify(result.audit)).not.toContain(privateArg);
    expect(JSON.stringify(result.audit)).not.toContain(request.query);
    expect(result.audit).toEqual({
      outcome: 'execute_command',
      commandId: 'sessions.list',
      confidence: 0.95,
      durationMs: 15,
      suggestionCount: 1,
    });
  });

  it('does not run provider health on the hot path unless preflight is requested', async () => {
    const health = vi.fn(async () => ({ state: 'unreachable' as const }));
    const hotPathProvider: CommandCenterIntentProvider = {
      health,
      propose: async () => providerIntent,
    };

    await expect(
      resolveCommandCenterIntent(request, {
        catalog,
        provider: hotPathProvider,
      })
    ).resolves.toMatchObject({
      resolution: { kind: 'execute_command' },
    });
    expect(health).not.toHaveBeenCalled();

    await expect(
      resolveCommandCenterIntent(request, {
        catalog,
        provider: hotPathProvider,
        preflightHealthCheck: true,
      })
    ).resolves.toMatchObject({
      resolution: { kind: 'no_match', reason: 'provider-unhealthy' },
    });
    expect(health).toHaveBeenCalledTimes(1);
  });

  it('falls back for timeout, malformed output, and invalid args', async () => {
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
      resolution: { kind: 'no_match', reason: 'timeout' },
    });

    await expect(
      resolveCommandCenterIntent(request, {
        catalog,
        provider: provider('nope'),
      })
    ).resolves.toMatchObject({
      resolution: { kind: 'no_match', reason: 'malformed-output' },
    });
    await expect(
      resolveCommandCenterIntent(request, {
        catalog,
        provider: provider({
          ...providerIntent,
          args: { rawShell: 'relay-ide v1 sessions list' },
        }),
      })
    ).resolves.toMatchObject({
      resolution: { kind: 'no_match', reason: 'invalid-args' },
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
        RELAY_COMMAND_CENTER_RESOLVER_MAX_OUTPUT_TOKENS: '123',
        RELAY_COMMAND_CENTER_RESOLVER_TEMPERATURE: '0.2',
      })
    ).toEqual({
      baseUrl: 'https://resolver.example/v1',
      model: 'resolver-small',
      timeoutMs: 42,
      minConfidence: 0.7,
      maxOutputTokens: 123,
      temperature: 0.2,
    });
    expect(
      readCommandCenterIntentResolverConfig({
        RELAY_COMMAND_CENTER_RESOLVER_BASE_URL: 'https://resolver.example/v1/',
        RELAY_COMMAND_CENTER_RESOLVER_MODEL: 'resolver-small',
      })
    ).toMatchObject({ maxOutputTokens: 512, temperature: 0 });
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
        max_tokens: number;
        temperature: number;
        messages: Array<{ content: string }>;
      };
      expect(body.max_tokens).toBe(77);
      expect(body.temperature).toBe(0.1);
      expect(JSON.stringify(body.messages)).toContain('sessions.list');
      expect(JSON.stringify(body.messages)).toContain(request.query);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify(providerIntent),
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
        maxOutputTokens: 77,
        temperature: 0.1,
      },
      { fetch, catalog }
    );

    await expect(openAiProvider.health()).resolves.toEqual({
      state: 'healthy',
      model: 'resolver-small',
      baseUrl: 'https://resolver.example/v1',
    });
    await expect(openAiProvider.propose(request)).resolves.toEqual(
      providerIntent
    );
    expect(JSON.stringify(await openAiProvider.health())).not.toContain(
      request.query
    );
  });
});

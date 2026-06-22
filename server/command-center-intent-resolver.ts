import {
  COMMAND_CENTER_RESOLVER_CATALOG,
  searchCommandCenterCatalog,
  summarizeCommandCenterCatalogForResolver,
  validateCommandCenterProviderIntent,
  type CommandCenterFallbackReason,
  type CommandCenterResolution,
  type CommandCenterResolverCatalog,
} from '../shared/command-center-resolver.js';

export interface CommandCenterIntentResolverConfig {
  baseUrl: string;
  model: string;
  apiKey?: string;
  organization?: string;
  timeoutMs: number;
  minConfidence: number;
}

export interface CommandCenterIntentResolverHealth {
  state: 'healthy' | 'unconfigured' | 'unreachable' | 'error';
  model?: string;
  baseUrl?: string;
  detail?: string;
}

export interface CommandCenterIntentRequest {
  /** Natural language query. Must not be logged or copied into audit metadata. */
  query: string;
}

export interface CommandCenterIntentProvider {
  health(): Promise<CommandCenterIntentResolverHealth>;
  propose(request: CommandCenterIntentRequest): Promise<unknown>;
}

export interface ResolveCommandCenterIntentOptions {
  provider?: CommandCenterIntentProvider | null;
  catalog?: CommandCenterResolverCatalog;
  minConfidence?: number;
  skipHealthCheck?: boolean;
  now?: () => number;
}

export interface CommandCenterIntentAudit {
  outcome: 'resolved' | 'fallback';
  reason?: CommandCenterFallbackReason;
  commandId?: string;
  confidence?: number;
  durationMs?: number;
  suggestionCount: number;
}

export interface ResolveCommandCenterIntentResult {
  resolution: CommandCenterResolution;
  audit: CommandCenterIntentAudit;
}

export type CommandCenterFetchLike = (
  url: string,
  init: RequestInit
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MIN_CONFIDENCE = 0.6;
const ENV_BASE_URL = 'RELAY_COMMAND_CENTER_RESOLVER_BASE_URL';
const ENV_MODEL = 'RELAY_COMMAND_CENTER_RESOLVER_MODEL';
const ENV_API_KEY = 'RELAY_COMMAND_CENTER_RESOLVER_API_KEY';
const ENV_ORGANIZATION = 'RELAY_COMMAND_CENTER_RESOLVER_ORG';
const ENV_TIMEOUT_MS = 'RELAY_COMMAND_CENTER_RESOLVER_TIMEOUT_MS';
const ENV_MIN_CONFIDENCE = 'RELAY_COMMAND_CENTER_RESOLVER_MIN_CONFIDENCE';

const SYSTEM_PROMPT =
  'Map the operator request to exactly one Relay command from the catalog. ' +
  'Return only JSON: {"commandId":string,"args":object,"confidence":number}. ' +
  'Use only commandIds from the catalog. If unsure, return low confidence. ' +
  'Never invent commands, arguments, shell strings, or execution plans.';

export function readCommandCenterIntentResolverConfig(
  env: Record<string, string | undefined> = process.env
): CommandCenterIntentResolverConfig | null {
  const baseUrl = env[ENV_BASE_URL]?.trim();
  const model = env[ENV_MODEL]?.trim();
  if (!baseUrl || !model) return null;
  const resolverCredential = env[ENV_API_KEY]?.trim();
  const organization = env[ENV_ORGANIZATION]?.trim();

  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    model,
    ...(resolverCredential ? { apiKey: resolverCredential } : {}),
    ...(organization ? { organization } : {}),
    timeoutMs: parseTimeoutMs(env[ENV_TIMEOUT_MS]),
    minConfidence: parseMinConfidence(env[ENV_MIN_CONFIDENCE]),
  };
}

function parseTimeoutMs(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
}

function parseMinConfidence(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1
    ? parsed
    : DEFAULT_MIN_CONFIDENCE;
}

function headersForConfig(
  config: CommandCenterIntentResolverConfig
): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
  if (config.organization) headers['openai-organization'] = config.organization;
  return headers;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

async function runWithTimeout<T>(
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

export function createOpenAiCompatibleCommandCenterIntentProvider(
  config: CommandCenterIntentResolverConfig,
  deps: {
    fetch: CommandCenterFetchLike;
    catalog?: CommandCenterResolverCatalog;
  }
): CommandCenterIntentProvider {
  const catalog = deps.catalog ?? COMMAND_CENTER_RESOLVER_CATALOG;

  return {
    async health() {
      try {
        const response = await runWithTimeout(config.timeoutMs, (signal) =>
          deps.fetch(`${config.baseUrl}/models`, {
            method: 'GET',
            headers: headersForConfig(config),
            signal,
          })
        );
        if (!response.ok) {
          return {
            state: 'error',
            model: config.model,
            baseUrl: config.baseUrl,
            detail: `status ${response.status}`,
          };
        }
        return {
          state: 'healthy',
          model: config.model,
          baseUrl: config.baseUrl,
        };
      } catch (error) {
        return {
          state: 'unreachable',
          model: config.model,
          baseUrl: config.baseUrl,
          detail: isAbortError(error) ? 'timeout' : 'network-error',
        };
      }
    },

    async propose(request) {
      const response = await runWithTimeout(config.timeoutMs, (signal) =>
        deps.fetch(`${config.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: headersForConfig(config),
          signal,
          body: JSON.stringify({
            model: config.model,
            temperature: 0,
            response_format: { type: 'json_object' },
            messages: [
              { role: 'system', content: SYSTEM_PROMPT },
              {
                role: 'system',
                content: JSON.stringify(
                  summarizeCommandCenterCatalogForResolver(catalog)
                ),
              },
              { role: 'user', content: request.query },
            ],
          }),
        })
      );
      if (!response.ok) throw new Error(`provider status ${response.status}`);
      return parseOpenAiCompatibleResolverResponse(await response.json());
    },
  };
}

function parseOpenAiCompatibleResolverResponse(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object') {
    throw new Error('provider response was not an object');
  }
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices))
    throw new Error('provider response missing choices');
  const content = (
    choices[0] as { message?: { content?: unknown } } | undefined
  )?.message?.content;
  if (typeof content !== 'string')
    throw new Error('provider response missing content');
  return JSON.parse(content) as unknown;
}

function fallbackResolution(
  reason: CommandCenterFallbackReason,
  request: CommandCenterIntentRequest,
  catalog: CommandCenterResolverCatalog,
  detail?: string
): CommandCenterResolution {
  return {
    kind: 'fallback',
    reason,
    ...(detail ? { detail } : {}),
    suggestions: searchCommandCenterCatalog(request.query, catalog),
  };
}

function auditFromResolution(
  resolution: CommandCenterResolution,
  durationMs: number | undefined
): CommandCenterIntentAudit {
  if (resolution.kind === 'resolved') {
    return {
      outcome: 'resolved',
      commandId: resolution.intent.commandId,
      confidence: Math.round(resolution.intent.confidence * 100) / 100,
      ...(durationMs !== undefined ? { durationMs } : {}),
      suggestionCount: resolution.suggestions.length,
    };
  }
  return {
    outcome: 'fallback',
    reason: resolution.reason,
    ...(durationMs !== undefined ? { durationMs } : {}),
    suggestionCount: resolution.suggestions.length,
  };
}

export async function resolveCommandCenterIntent(
  request: CommandCenterIntentRequest,
  options: ResolveCommandCenterIntentOptions = {}
): Promise<ResolveCommandCenterIntentResult> {
  const catalog = options.catalog ?? COMMAND_CENTER_RESOLVER_CATALOG;
  if (!options.provider) {
    const resolution = fallbackResolution('provider-missing', request, catalog);
    return { resolution, audit: auditFromResolution(resolution, undefined) };
  }

  const start = options.now?.();
  if (!options.skipHealthCheck) {
    const health = await safeHealth(options.provider);
    if (health.state !== 'healthy') {
      const resolution = fallbackResolution(
        'provider-unhealthy',
        request,
        catalog,
        health.state
      );
      return {
        resolution,
        audit: auditFromResolution(resolution, duration(start, options.now)),
      };
    }
  }

  let raw: unknown;
  try {
    raw = await options.provider.propose(request);
  } catch (error) {
    const resolution = fallbackResolution(
      isAbortError(error) ? 'timeout' : 'provider-error',
      request,
      catalog,
      isAbortError(error) ? 'timeout' : 'provider-error'
    );
    return {
      resolution,
      audit: auditFromResolution(resolution, duration(start, options.now)),
    };
  }

  const resolution = validateCommandCenterProviderIntent(raw, {
    catalog,
    query: request.query,
    ...(options.minConfidence !== undefined
      ? { minConfidence: options.minConfidence }
      : {}),
  });
  return {
    resolution,
    audit: auditFromResolution(resolution, duration(start, options.now)),
  };
}

async function safeHealth(
  provider: CommandCenterIntentProvider
): Promise<CommandCenterIntentResolverHealth> {
  try {
    return await provider.health();
  } catch {
    return { state: 'unreachable' };
  }
}

function duration(
  start: number | undefined,
  now: (() => number) | undefined
): number | undefined {
  return start !== undefined && now ? now() - start : undefined;
}

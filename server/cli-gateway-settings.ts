import { Router, type RequestHandler } from 'express';

import { loadConfig, saveConfig } from './config.js';
import { getSmeeStatus } from './webhook-manager.js';
import type { Config, RenamerTool } from './types.js';

export const CLI_GATEWAY_SAFE_SETTING_KEYS = [
  'defaultAgent',
  'defaultContinue',
  'defaultYolo',
  'defaultNotifications',
  'claudeFullscreen',
  'renamerTool',
  'updateChannel',
] as const;

export type CliGatewaySafeSettingKey =
  (typeof CLI_GATEWAY_SAFE_SETTING_KEYS)[number];

export interface CliGatewaySafeSettings {
  defaultAgent: string;
  defaultContinue: boolean;
  defaultYolo: boolean;
  defaultNotifications: boolean;
  claudeFullscreen: boolean;
  renamerTool: RenamerTool;
  updateChannel: 'stable' | 'nightly';
}

export interface CliGatewaySettingsUpdateInput {
  key: CliGatewaySafeSettingKey;
  value: string | boolean;
  confirmRiskyWrite?: boolean;
}

export interface CliGatewaySettingsUpdateResult {
  key: CliGatewaySafeSettingKey;
  value: string | boolean;
  previousValue: string | boolean;
  changed: boolean;
  redaction: CliGatewayRedactionSummary;
}

export interface CliGatewayRedactionSummary {
  rawConfigReturned: false;
  secretsReturned: false;
  tokenMaterialReturned: false;
}

export interface CliGatewayWebhookStatusResult {
  configured: boolean;
  smeeConnected: boolean;
  lastEventAt: string | null;
  autoProvision: boolean;
  repoStatuses: Array<{
    repoPath: string;
    webhookStatus: 'manual' | 'live' | 'limited' | 'error';
    webhookEnabled: boolean;
    webhookError?: string;
    lastEventAt: string | null;
  }>;
  redaction: CliGatewayRedactionSummary & {
    webhookSecretsReturned: false;
    rawWebhookUrlsReturned: false;
  };
}

export interface CliGatewayWebhookPingResult {
  ok: boolean;
  configured: boolean;
  smeeConnected: boolean;
  lastEventAt: string | null;
  message: string;
  redaction: CliGatewayRedactionSummary & {
    webhookSecretsReturned: false;
    rawWebhookUrlsReturned: false;
  };
}

const SAFE_SETTING_KEY_SET = new Set<string>(CLI_GATEWAY_SAFE_SETTING_KEYS);
const RENAMER_TOOLS = ['claude', 'codex', 'none', 'custom-script'] as const;
const UPDATE_CHANNELS = ['stable', 'nightly'] as const;

function redactionSummary(): CliGatewayRedactionSummary {
  return {
    rawConfigReturned: false,
    secretsReturned: false,
    tokenMaterialReturned: false,
  };
}

function isSafeSettingKey(value: unknown): value is CliGatewaySafeSettingKey {
  return typeof value === 'string' && SAFE_SETTING_KEY_SET.has(value);
}

export function safeSettingsFromConfig(config: Config): CliGatewaySafeSettings {
  return {
    defaultAgent: config.defaultFramework || 'claude',
    defaultContinue: config.defaultContinue ?? true,
    defaultYolo: config.defaultYolo ?? false,
    defaultNotifications: config.defaultNotifications ?? true,
    claudeFullscreen: config.claudeFullscreen ?? true,
    renamerTool: config.renamerTool ?? 'claude',
    updateChannel: config.updateChannel ?? 'stable',
  };
}

function validateSettingValue(
  key: CliGatewaySafeSettingKey,
  value: unknown
): { ok: true; value: string | boolean } | { ok: false; message: string } {
  switch (key) {
    case 'defaultAgent': {
      if (typeof value !== 'string' || !value.trim()) {
        return {
          ok: false,
          message: 'defaultAgent must be a non-empty string',
        };
      }
      const trimmed = value.trim();
      if (!/^[a-zA-Z0-9._-]+$/.test(trimmed)) {
        return {
          ok: false,
          message: 'defaultAgent must be a framework id, not a command or path',
        };
      }
      return { ok: true, value: trimmed };
    }
    case 'defaultContinue':
    case 'defaultYolo':
    case 'defaultNotifications':
    case 'claudeFullscreen':
      if (typeof value !== 'boolean') {
        return { ok: false, message: `${key} must be a boolean` };
      }
      return { ok: true, value };
    case 'renamerTool':
      if (
        typeof value !== 'string' ||
        !RENAMER_TOOLS.includes(value as RenamerTool)
      ) {
        return {
          ok: false,
          message:
            'renamerTool must be one of: claude, codex, none, custom-script',
        };
      }
      return { ok: true, value };
    case 'updateChannel':
      if (
        typeof value !== 'string' ||
        !UPDATE_CHANNELS.includes(value as 'stable' | 'nightly')
      ) {
        return {
          ok: false,
          message: 'updateChannel must be stable or nightly',
        };
      }
      return { ok: true, value };
  }
}

function riskySettingWriteRequiresConfirmation(
  key: CliGatewaySafeSettingKey,
  value: string | boolean,
  previousValue: string | boolean
): boolean {
  if (key === 'defaultYolo' && value === true && previousValue !== true)
    return true;
  if (key === 'updateChannel' && value !== previousValue) return true;
  return false;
}

export function updateSafeSetting(
  config: Config,
  input: CliGatewaySettingsUpdateInput
):
  | { ok: true; result: CliGatewaySettingsUpdateResult }
  | { ok: false; status: number; error: Record<string, unknown> } {
  const current = safeSettingsFromConfig(config);
  const previousValue = current[input.key];
  const validation = validateSettingValue(input.key, input.value);
  if (validation.ok === false) {
    return {
      ok: false,
      status: 400,
      error: {
        code: 'INVALID_ARGUMENT',
        message: validation.message,
        retryable: false,
        field: input.key,
      },
    };
  }

  const nextValue = validation.value;
  if (
    riskySettingWriteRequiresConfirmation(
      input.key,
      nextValue,
      previousValue
    ) &&
    input.confirmRiskyWrite !== true
  ) {
    return {
      ok: false,
      status: 409,
      error: {
        code: 'CONFIRMATION_REQUIRED',
        message: `${input.key} change requires confirmRiskyWrite=true`,
        retryable: false,
        reasonCode: 'RISKY_SETTING_WRITE_CONFIRMATION_REQUIRED',
        challenge: {
          kind: 'settings.update',
          key: input.key,
          requestedValue: nextValue,
        },
      },
    };
  }

  switch (input.key) {
    case 'defaultAgent':
      config.defaultFramework = nextValue as string;
      break;
    case 'defaultContinue':
      config.defaultContinue = nextValue as boolean;
      break;
    case 'defaultYolo':
      config.defaultYolo = nextValue as boolean;
      break;
    case 'defaultNotifications':
      config.defaultNotifications = nextValue as boolean;
      break;
    case 'claudeFullscreen':
      config.claudeFullscreen = nextValue as boolean;
      break;
    case 'renamerTool':
      config.renamerTool = nextValue as RenamerTool;
      break;
    case 'updateChannel':
      config.updateChannel = nextValue as 'stable' | 'nightly';
      break;
  }

  return {
    ok: true,
    result: {
      key: input.key,
      value: nextValue,
      previousValue,
      changed: nextValue !== previousValue,
      redaction: redactionSummary(),
    },
  };
}

function parseSettingsUpdateInput(
  body: unknown
):
  | { ok: true; input: CliGatewaySettingsUpdateInput }
  | { ok: false; message: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return {
      ok: false,
      message: 'settings.update input JSON must be an object',
    };
  }
  const record = body as Record<string, unknown>;
  if (!isSafeSettingKey(record['key'])) {
    return {
      ok: false,
      message: `key must be one of: ${CLI_GATEWAY_SAFE_SETTING_KEYS.join(', ')}`,
    };
  }
  if (!Object.prototype.hasOwnProperty.call(record, 'value')) {
    return { ok: false, message: 'value is required' };
  }
  const confirmRiskyWrite = record['confirmRiskyWrite'];
  if (
    confirmRiskyWrite !== undefined &&
    typeof confirmRiskyWrite !== 'boolean'
  ) {
    return { ok: false, message: 'confirmRiskyWrite must be a boolean' };
  }
  return {
    ok: true,
    input: {
      key: record['key'],
      value: record['value'] as string | boolean,
      ...(typeof confirmRiskyWrite === 'boolean' ? { confirmRiskyWrite } : {}),
    },
  };
}

export function webhookStatusFromConfig(
  config: Config
): CliGatewayWebhookStatusResult {
  const { smeeConnected, lastEventAt } = getSmeeStatus();
  const repoStatuses = Object.entries(config.repoSettings ?? {}).map(
    ([repoPath, settings]) => ({
      repoPath,
      webhookStatus: settings.webhookError
        ? settings.webhookError === 'not-admin'
          ? ('limited' as const)
          : ('error' as const)
        : settings.webhookEnabled === true
          ? ('live' as const)
          : ('manual' as const),
      webhookEnabled: settings.webhookEnabled === true,
      ...(settings.webhookError ? { webhookError: settings.webhookError } : {}),
      lastEventAt: null,
    })
  );
  return {
    configured: Boolean(config.github?.webhookSecret && config.github?.smeeUrl),
    smeeConnected,
    lastEventAt,
    autoProvision: config.github?.autoProvision ?? false,
    repoStatuses,
    redaction: {
      ...redactionSummary(),
      webhookSecretsReturned: false,
      rawWebhookUrlsReturned: false,
    },
  };
}

export function createCliGatewaySettingsRouter(deps: {
  configPath: string;
  requireAuth: RequestHandler;
}): Router {
  const router = Router();
  router.use(deps.requireAuth);

  router.get('/settings', (_req, res) => {
    const settings = safeSettingsFromConfig(loadConfig(deps.configPath));
    res.json({ settings, redaction: redactionSummary() });
  });

  router.patch('/settings', (req, res) => {
    const parsed = parseSettingsUpdateInput(req.body);
    if (parsed.ok === false) {
      res.status(400).json({
        error: {
          code: 'INVALID_ARGUMENT',
          message: parsed.message,
          retryable: false,
        },
      });
      return;
    }
    const config = loadConfig(deps.configPath);
    const updated = updateSafeSetting(config, parsed.input);
    if (updated.ok === false) {
      res.status(updated.status).json({ error: updated.error });
      return;
    }
    saveConfig(deps.configPath, config);
    res.json(updated.result);
  });

  router.get('/webhooks/status', (_req, res) => {
    res.json(webhookStatusFromConfig(loadConfig(deps.configPath)));
  });

  router.post('/webhooks/ping', (_req, res) => {
    const status = webhookStatusFromConfig(loadConfig(deps.configPath));
    res.json({
      ok: status.configured,
      configured: status.configured,
      smeeConnected: status.smeeConnected,
      lastEventAt: status.lastEventAt,
      message: status.configured
        ? 'webhook relay configuration is present; no secret or raw URL returned'
        : 'webhook relay is not configured',
      redaction: status.redaction,
    } satisfies CliGatewayWebhookPingResult);
  });

  return router;
}

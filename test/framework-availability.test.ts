import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  frameworkCapabilitiesWithChannelLane,
  getFrameworkAvailability,
  getFrameworkChannelAvailability,
  getFrameworkClientInfo,
  listConfiguredFrameworks,
  resolveExecutablePath,
} from '../server/frameworks.js';
import type { AgentFramework } from '../server/types.js';
import {
  CHANNEL_ADAPTER_LAUNCH_CONTRACTS,
  channelAdapterLaunchRequirement,
  sanitizeChannelAdapterProcessEnv,
  v2Adapters,
} from '../server/protocol-adapters/index.js';

const EXPECTED_CHANNEL_LAUNCH_CONTRACT = {
  mock: { kind: 'embedded', command: null, deny: [] },
  claude: {
    kind: 'command',
    command: 'claude',
    deny: ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT'],
  },
  codex: { kind: 'command', command: 'codex', deny: ['CLAUDECODE'] },
  'prime-agent': {
    kind: 'command',
    command: 'prime-agent',
    deny: ['CLAUDECODE'],
  },
  pi: { kind: 'command', command: 'pi', deny: ['CLAUDECODE'] },
  opencode: {
    kind: 'command',
    command: 'opencode',
    deny: [
      'CLAUDECODE',
      'OPENCODE_SERVER_PASSWORD',
      'OPENCODE_SERVER_USERNAME',
    ],
  },
  'opencode-attached': { kind: 'gateway', command: null, deny: [] },
  hermes: { kind: 'gateway', command: null, deny: [] },
} satisfies Record<
  keyof typeof CHANNEL_ADAPTER_LAUNCH_CONTRACTS,
  {
    kind: 'command' | 'gateway' | 'embedded';
    command: string | null;
    deny: string[];
  }
>;

const COMMAND_CONTRACTS = Object.entries(
  EXPECTED_CHANNEL_LAUNCH_CONTRACT
).filter(
  (
    entry
  ): entry is [
    keyof typeof EXPECTED_CHANNEL_LAUNCH_CONTRACT,
    { kind: 'command'; command: string; deny: string[] },
  ] => entry[1].kind === 'command' && entry[1].command !== null
);

function framework(command: string, id = command): AgentFramework {
  return {
    id,
    displayName: id,
    command,
    continueArgs: [],
    yoloArgs: [],
    parserType: command,
    eventSource: 'parser',
    capabilities: {
      supportsHooks: false,
      supportsContinue: false,
      supportsYolo: false,
      supportsTelemetry: false,
      supportsAttachedRuntime: false,
    },
  };
}

function channelFramework(command: string, id = command): AgentFramework {
  const result = framework(command, id);
  result.capabilities.supportsChannelAgents = true;
  return result;
}

describe('framework CLI availability', () => {
  it('marks a framework installed when its command resolves on PATH', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-fw-bin-'));
    const cliPath = path.join(tmpDir, 'agent-cli');
    fs.writeFileSync(cliPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

    expect(resolveExecutablePath('agent-cli', { PATH: tmpDir })).toBe(cliPath);
    expect(
      getFrameworkAvailability(framework('agent-cli'), { PATH: tmpDir })
    ).toMatchObject({
      installed: true,
      path: cliPath,
    });
  });

  it('marks a framework unavailable when its command is missing', () => {
    expect(
      getFrameworkAvailability(framework('definitely-missing-relay-agent'), {
        PATH: '',
      })
    ).toEqual({
      installed: false,
      reason: 'definitely-missing-relay-agent CLI not found on PATH',
    });
  });

  it('rejects blank commands and executable directories', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-fw-blank-'));

    expect(resolveExecutablePath('', { PATH: tmpDir })).toBeNull();
    expect(resolveExecutablePath('   ', { PATH: tmpDir })).toBeNull();
    expect(resolveExecutablePath(tmpDir, { PATH: '' })).toBeNull();
  });

  it('keeps one exhaustive provider launch and sanitation matrix', () => {
    const actual = Object.fromEntries(
      Object.entries(CHANNEL_ADAPTER_LAUNCH_CONTRACTS).map(
        ([providerId, contract]) => [
          providerId,
          {
            kind: contract.requirement.kind,
            command:
              contract.requirement.kind === 'command'
                ? contract.requirement.command
                : null,
            deny: [...contract.processEnvDenylist],
          },
        ]
      )
    );

    expect(actual).toEqual(EXPECTED_CHANNEL_LAUNCH_CONTRACT);
    expect(Object.keys(actual).sort()).toEqual(Object.keys(v2Adapters).sort());
  });

  it.each(COMMAND_CONTRACTS)(
    'probes missing and executable launch commands for %s',
    async (providerId, contract) => {
      await expect(
        getFrameworkChannelAvailability(
          channelFramework('terminal-only-command', providerId),
          { PATH: '' }
        )
      ).resolves.toEqual({
        available: false,
        reason: `${contract.command} is not installed on this node (not found on PATH).`,
        command: contract.command,
      });

      const tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), `relay-${providerId}-bin-`)
      );
      fs.writeFileSync(
        path.join(tmpDir, contract.command),
        '#!/bin/sh\nexit 0\n',
        { mode: 0o755 }
      );
      await expect(
        getFrameworkChannelAvailability(
          channelFramework('terminal-only-command', providerId),
          { PATH: tmpDir }
        )
      ).resolves.toEqual({
        available: true,
        command: contract.command,
      });
    }
  );

  it.each(Object.entries(EXPECTED_CHANNEL_LAUNCH_CONTRACT))(
    'applies the declared process-environment denylist for %s',
    (providerId, contract) => {
      const candidate = {
        SAFE_PROFILE_KEY: 'kept',
        CLAUDECODE: 'blocked',
        CLAUDE_CODE_ENTRYPOINT: 'blocked',
        OPENCODE_SERVER_PASSWORD: 'blocked',
        OPENCODE_SERVER_USERNAME: 'blocked',
      };
      const sanitized = sanitizeChannelAdapterProcessEnv(providerId, candidate);

      expect(sanitized.SAFE_PROFILE_KEY).toBe('kept');
      for (const key of Object.keys(candidate).filter(
        (key) => key !== 'SAFE_PROFILE_KEY'
      )) {
        expect(Object.hasOwn(sanitized, key)).toBe(
          !contract.deny.includes(key)
        );
      }
    }
  );

  it('removes mixed-case denylisted keys on Windows', () => {
    const sanitized = sanitizeChannelAdapterProcessEnv(
      'opencode',
      {
        ClaudeCode: 'blocked',
        opencode_server_password: 'blocked',
        OpenCode_Server_UserName: 'blocked',
        SAFE_PROFILE_KEY: 'kept',
      },
      'win32'
    );

    expect(sanitized).toEqual({ SAFE_PROFILE_KEY: 'kept' });
  });

  it('fails closed when a channel provider has no launch contract', async () => {
    await expect(
      getFrameworkChannelAvailability(
        channelFramework('future-agent', 'future-agent'),
        { PATH: '' }
      )
    ).resolves.toEqual({
      available: false,
      reason: 'future-agent has no registered channel runtime.',
    });
  });

  it('ignores a config override that tries to toggle the channel lane', async () => {
    // Deliberate delta: the provider descriptor is the ONE channel-lane gate, so
    // `config.frameworks.<id>.capabilities.supportsChannelAgents` decides nothing
    // in either direction. The claim direction is pinned by the fail-closed test
    // above (a custom framework with no descriptor stays unavailable); this pins
    // the disable direction, which the old deep-merged catalog boolean honored.
    const disabled = listConfiguredFrameworks({
      claude: {
        capabilities: {
          supportsHooks: true,
          supportsContinue: true,
          supportsYolo: true,
          supportsTelemetry: true,
          supportsAttachedRuntime: true,
          supportsChannelAgents: false,
        },
      },
    }).find((framework) => framework.id === 'claude');

    expect(disabled?.capabilities.supportsChannelAgents).toBe(false);
    expect(
      frameworkCapabilitiesWithChannelLane(disabled!).supportsChannelAgents
    ).toBe(true);
    await expect(
      getFrameworkChannelAvailability(
        disabled!,
        { PATH: '' },
        { probeLaunchCommand: false }
      )
    ).resolves.toEqual({ available: true, command: 'claude' });
  });

  it('includes custom future frameworks in the client list', () => {
    const result = getFrameworkClientInfo(
      {
        future: framework('future-agent', 'future'),
      },
      { PATH: '' }
    );

    expect(result.find((framework) => framework.id === 'future')).toMatchObject(
      {
        id: 'future',
        command: 'future-agent',
        availability: {
          installed: false,
          reason: 'future-agent CLI not found on PATH',
        },
      }
    );
  });

  it('marks a channel provider unavailable when its actual adapter command is missing', async () => {
    const result = await getFrameworkChannelAvailability(
      channelFramework('terminal-only-command', 'prime-agent'),
      { PATH: '' }
    );

    expect(result).toEqual({
      available: false,
      reason: 'prime-agent is not installed on this node (not found on PATH).',
      command: 'prime-agent',
    });
  });

  it('ignores terminal command overrides that the channel adapter does not consume', async () => {
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'relay-override-bin-')
    );
    const overridePath = path.join(tmpDir, 'override-agent');
    fs.writeFileSync(overridePath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const prime = channelFramework('prime-agent', 'prime-agent');
    prime.commandOverride = 'override-agent';

    await expect(
      getFrameworkChannelAvailability(prime, { PATH: tmpDir })
    ).resolves.toEqual({
      available: false,
      reason: 'prime-agent is not installed on this node (not found on PATH).',
      command: 'prime-agent',
    });
  });

  it('marks a channel provider available when its actual adapter command resolves', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-channel-bin-'));
    const cliPath = path.join(tmpDir, 'prime-agent');
    fs.writeFileSync(cliPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

    await expect(
      getFrameworkChannelAvailability(
        channelFramework('terminal-only-command', 'prime-agent'),
        { PATH: tmpDir }
      )
    ).resolves.toEqual({ available: true, command: 'prime-agent' });
  });

  it('declares a launch requirement for every registered channel adapter', () => {
    expect(
      Object.keys(v2Adapters).filter(
        (providerId) => !channelAdapterLaunchRequirement(providerId)
      )
    ).toEqual([]);
  });

  it('probes the attached OpenCode HTTP runtime without requiring a local CLI', async () => {
    const attached = channelFramework(
      'terminal-only-opencode-command',
      'opencode-attached'
    );
    const probes: Array<{ extra?: Record<string, unknown>; timeout?: number }> =
      [];

    await expect(
      getFrameworkChannelAvailability(
        attached,
        { PATH: '' },
        {
          gatewayProbeOverrides: {
            'opencode-attached': async (extra, timeout) => {
              probes.push({ ...(extra ? { extra } : {}), timeout });
              return { available: true, endpoint: 'http://127.0.0.1:4096' };
            },
          },
        }
      )
    ).resolves.toEqual({
      available: true,
      endpoint: 'http://127.0.0.1:4096',
    });
    expect(probes).toEqual([{ timeout: 500 }]);
  });

  it('probes the Hermes HTTP gateway without requiring a local Hermes CLI', async () => {
    const hermes = channelFramework('hermes', 'hermes');
    const probes: Array<{ endpoint?: string; timeout?: number }> = [];

    await expect(
      getFrameworkChannelAvailability(
        hermes,
        { PATH: '' },
        {
          gatewayProbeOverrides: {
            hermes: async (extra, timeout) => {
              probes.push({
                endpoint:
                  typeof extra?.['endpoint'] === 'string'
                    ? extra['endpoint']
                    : undefined,
                timeout,
              });
              return { available: true, endpoint: 'http://127.0.0.1:8642' };
            },
          },
        }
      )
    ).resolves.toEqual({
      available: true,
      endpoint: 'http://127.0.0.1:8642',
    });
    expect(probes).toEqual([{ endpoint: undefined, timeout: 500 }]);
  });
});

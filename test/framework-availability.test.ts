import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getFrameworkAvailability,
  getFrameworkClientInfo,
  resolveExecutablePath,
} from '../server/frameworks.js';
import type { AgentFramework } from '../server/types.js';

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
});

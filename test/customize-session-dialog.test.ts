import { describe, expect, it } from 'vitest';

import {
  defaultSessionModeForAgent,
  getSessionModeOptions,
} from '../frontend/src/components/dialogs/CustomizeSessionDialog.js';
import type { FrameworkInfo } from '../frontend/src/lib/types.js';

function framework(id: string): FrameworkInfo {
  return {
    id,
    displayName: id,
    command: id,
    capabilities: {
      supportsContinue: true,
      supportsYolo: true,
      supportsHooks: true,
      supportsTelemetry: false,
      supportsWebSessions: ['claude', 'codex', 'opencode', 'hermes'].includes(id),
    },
    eventSource: 'hooks',
  };
}

describe('CustomizeSessionDialog session mode options', () => {
  it('shows tui and web for agents with web-session adapters', () => {
    const frameworks = [framework('claude'), framework('codex'), framework('opencode')];

    expect(getSessionModeOptions(frameworks, 'claude')).toEqual([
      { value: 'pty', label: 'tui' },
      { value: 'web', label: 'web' },
    ]);
  });

  it('shows only tui for agents without web-session adapters', () => {
    expect(getSessionModeOptions([framework('custom')], 'custom')).toEqual([
      { value: 'pty', label: 'tui' },
    ]);
  });

  it('defaults hermes to web and other agents to tui', () => {
    expect(defaultSessionModeForAgent([framework('hermes')], 'hermes')).toBe('web');
    expect(defaultSessionModeForAgent([framework('claude')], 'claude')).toBe('pty');
  });
});

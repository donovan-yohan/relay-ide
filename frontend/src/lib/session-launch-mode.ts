import type { AgentType, FrameworkInfo } from './types.js';

export type SessionLaunchMode = 'pty' | 'web';

export interface SessionModeOption {
  value: SessionLaunchMode;
  label: string;
  disabled?: boolean;
  reason?: string;
}

export function isFrameworkAvailable(framework: FrameworkInfo): boolean {
  return framework.availability?.installed !== false;
}

export function isFrameworkWebAvailable(
  framework: FrameworkInfo | undefined
): boolean {
  return framework?.webAvailability?.available !== false;
}

export function selectLaunchAgent(
  frameworks: FrameworkInfo[],
  preferredAgent: AgentType
): AgentType {
  const preferred = frameworks.find((f) => f.id === preferredAgent);
  if (!preferred || isFrameworkAvailable(preferred)) return preferredAgent;
  return frameworks.find(isFrameworkAvailable)?.id ?? preferredAgent;
}

export function getSessionModeOptions(
  frameworks: FrameworkInfo[],
  selectedAgent: AgentType
): SessionModeOption[] {
  const selectedFramework = frameworks.find((f) => f.id === selectedAgent);
  if (selectedFramework?.capabilities.supportsWebSessions === true) {
    const webAvailable = isFrameworkWebAvailable(selectedFramework);
    return [
      { value: 'pty', label: 'tui' },
      {
        value: 'web',
        label: webAvailable ? 'web' : 'web (unavailable)',
        ...(!webAvailable ? { disabled: true } : {}),
        ...(selectedFramework.webAvailability?.reason
          ? { reason: selectedFramework.webAvailability.reason }
          : {}),
      },
    ];
  }
  return [{ value: 'pty', label: 'tui' }];
}

export function defaultSessionModeForAgent(
  frameworks: FrameworkInfo[],
  selectedAgent: AgentType
): SessionLaunchMode {
  const supportsWeb = getSessionModeOptions(frameworks, selectedAgent).some(
    (option) => option.value === 'web' && !option.disabled
  );
  return selectedAgent === 'hermes' && supportsWeb ? 'web' : 'pty';
}

/**
 * #1166: an agent launch in `web` mode now routes to a DM channel
 * (`ChannelView`) instead of spawning a `mode:'web'` session (`ChatView`).
 * Shared by every UI creation entry point (TopicComposer, CustomizeSessionDialog)
 * so "web session" can never be produced from a creation path. PTY/terminal
 * launches are unaffected.
 */
export function shouldRouteToChannel(
  type: 'agent' | 'terminal' | null | undefined,
  mode: SessionLaunchMode | null | undefined
): boolean {
  return type === 'agent' && mode === 'web';
}

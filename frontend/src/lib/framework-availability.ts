import type { AgentType, FrameworkInfo } from './types.js';

export function isFrameworkAvailable(framework: FrameworkInfo): boolean {
  return framework.availability?.installed !== false;
}

export function selectLaunchAgent(
  frameworks: FrameworkInfo[],
  preferredAgent: AgentType
): AgentType {
  const preferred = frameworks.find(
    (framework) => framework.id === preferredAgent
  );
  if (!preferred || isFrameworkAvailable(preferred)) return preferredAgent;
  return frameworks.find(isFrameworkAvailable)?.id ?? preferredAgent;
}

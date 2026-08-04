import type { AccountTelemetry, Session, TelemetryData } from './types.js';
import type { GlobalSessionId, NodeId } from '../shared/identity.js';
import type { AgentEventAdapter } from './agent-events.js';

export type TelemetrySession = Pick<Session, 'id'> & {
  nodeId?: NodeId;
  globalSessionId?: GlobalSessionId;
};

export interface TelemetryAdapter {
  readonly framework: string;
  attach(session: TelemetrySession): void;
  collectSnapshot(sessionId: string): TelemetryData | null;
  collectAccountTelemetry?(): AccountTelemetry | null;
  handleHookEvent?(
    sessionId: string,
    eventType: string,
    data: Record<string, unknown>
  ): void;
  detach(sessionId: string): void;
}

export interface TelemetryDeps {
  getActiveSessions: () => TelemetrySession[];
  broadcastEvent: (type: string, data?: Record<string, unknown>) => void;
  configDir: string;
  eventAdapter?: AgentEventAdapter;
}

const TELEMETRY_ADAPTERS = new Map<
  string,
  (deps: TelemetryDeps) => TelemetryAdapter
>();

export function getAdapterForFramework(
  frameworkId: string,
  deps: TelemetryDeps
): TelemetryAdapter | null {
  const factory = TELEMETRY_ADAPTERS.get(frameworkId);
  return factory ? factory(deps) : null;
}

export function registerTelemetryAdapter(
  frameworkId: string,
  factory: (deps: TelemetryDeps) => TelemetryAdapter
): void {
  TELEMETRY_ADAPTERS.set(frameworkId, factory);
}

export function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

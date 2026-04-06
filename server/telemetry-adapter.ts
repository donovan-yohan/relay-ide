import type { Session, TelemetryData } from './types.js';

export interface TelemetryAdapter {
  readonly framework: string;
  attach(session: Session): void;
  collectSnapshot(sessionId: string): TelemetryData | null;
  detach(sessionId: string): void;
}

export interface TelemetryDeps {
  getActiveSessions: () => Array<Pick<Session, 'id'>>;
  broadcastEvent: (type: string, data?: Record<string, unknown>) => void;
  configDir: string;
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

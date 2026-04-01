import type { AccountTelemetry, TelemetryData } from '../types.js';

let sessionTelemetry = $state<Map<string, TelemetryData>>(new Map());
let accountTelemetry = $state<AccountTelemetry | null>(null);

export function getTelemetryState() {
  return {
    get sessionTelemetry() { return sessionTelemetry; },
    get accountTelemetry() { return accountTelemetry; },
  };
}

export function hydrateTelemetry(
  sessions: Record<string, TelemetryData>,
  account: AccountTelemetry | null,
): void {
  sessionTelemetry = new Map(Object.entries(sessions));
  accountTelemetry = account;
}

export function getSessionTelemetry(sessionId: string): TelemetryData | undefined {
  return sessionTelemetry.get(sessionId);
}

export function handleTelemetryEvent(message: {
  type: string;
  sessionId?: string;
  data?: TelemetryData | AccountTelemetry;
}): void {
  if (message.type === 'session-telemetry' && message.sessionId && message.data) {
    sessionTelemetry.set(message.sessionId, message.data as TelemetryData);
    sessionTelemetry = new Map(sessionTelemetry);
    return;
  }

  if (message.type === 'account-telemetry') {
    accountTelemetry = (message.data as AccountTelemetry | undefined) ?? null;
    return;
  }

  if (message.type === 'session-ended' && message.sessionId) {
    sessionTelemetry.delete(message.sessionId);
    sessionTelemetry = new Map(sessionTelemetry);
  }
}

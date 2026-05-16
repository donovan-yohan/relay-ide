export type ControlMode = 'agent-driven' | 'human-driven' | 'co-driven';

export type ControlFreshness = 'fresh' | 'stale' | 'unknown';

export type ControlActorKind = 'agent' | 'human' | 'system';

export interface ControlActor {
  kind: ControlActorKind;
  /** Stable actor id when the source can provide one. */
  id?: string;
  /** User-facing label, e.g. "Codex" or "Local user". */
  displayName?: string;
  /** Execution node that observed or owns the actor. */
  nodeId?: string;
  /** Node-local or global session/tab id associated with the actor. */
  sessionId?: string;
}

/** Identity carried by control-state events, independent of repo binding. */
export interface TabControlIdentity {
  nodeId: string;
  sessionId: string;
  globalSessionId?: string;
  cwd: string;
  repoPath?: string;
  worktreePath?: string | null;
  repoName?: string;
  branchName?: string;
}

/** Event names reserved for control-state changes on tab/bench surfaces. */
export type TabControlEventType = 'tab.mode-changed' | 'tab.intervention';

export interface TabControlEventBase {
  eventId: string;
  type: TabControlEventType;
  occurredAt: string;
  identity: TabControlIdentity;
  actor: ControlActor;
  reason?: string;
}

export interface TabModeChangedEvent extends TabControlEventBase {
  type: 'tab.mode-changed';
  previousControlMode: ControlMode;
  controlMode: ControlMode;
}

export interface TabInterventionEvent extends TabControlEventBase {
  type: 'tab.intervention';
  controlMode: ControlMode;
}

export type TabControlEvent = TabModeChangedEvent | TabInterventionEvent;

/**
 * Product-level control state for a Tab/Bench surface.
 *
 * Keep this separate from session transport `mode` (`pty` | `web`). This
 * answers "who is driving the tab right now?" while transport mode answers
 * "how is the process connected?".
 */
export interface ControlStateSummary {
  controlMode: ControlMode;
  activeActors: ControlActor[];
  activeWorker?: ControlActor;
  lastInterventionAt: string | null;
  lastInterventionBy: ControlActor | null;
  lastInterventionEventId: string | null;
  controlFreshness: ControlFreshness;
  controlReason?: string;
}

export const LEGACY_CONTROL_ACTOR: ControlActor = {
  kind: 'human',
  id: 'local-user',
  displayName: 'Local user',
};

export function createLegacyControlStateSummary(
  reason = 'legacy-backfill'
): ControlStateSummary {
  return {
    controlMode: 'human-driven',
    activeActors: [{ ...LEGACY_CONTROL_ACTOR }],
    lastInterventionAt: null,
    lastInterventionBy: null,
    lastInterventionEventId: null,
    controlFreshness: 'unknown',
    controlReason: reason,
  };
}

export function isControlMode(value: unknown): value is ControlMode {
  return (
    value === 'agent-driven' || value === 'human-driven' || value === 'co-driven'
  );
}

export function isControlFreshness(
  value: unknown
): value is ControlFreshness {
  return value === 'fresh' || value === 'stale' || value === 'unknown';
}

export function isControlActorKind(value: unknown): value is ControlActorKind {
  return value === 'agent' || value === 'human' || value === 'system';
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function optionalNullableString(value: unknown): string | null {
  return optionalString(value) ?? null;
}

export function normalizeControlActor(value: unknown): ControlActor | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (!isControlActorKind(record.kind)) return undefined;
  const actor: ControlActor = { kind: record.kind };
  const id = optionalString(record.id);
  const displayName = optionalString(record.displayName);
  const nodeId = optionalString(record.nodeId);
  const sessionId = optionalString(record.sessionId);
  if (id) actor.id = id;
  if (displayName) actor.displayName = displayName;
  if (nodeId) actor.nodeId = nodeId;
  if (sessionId) actor.sessionId = sessionId;
  return actor;
}

export function normalizeControlActors(values: unknown): ControlActor[] {
  if (!Array.isArray(values)) return [];
  const actors: ControlActor[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const actor = normalizeControlActor(value);
    if (!actor) continue;
    const key = [actor.kind, actor.id, actor.nodeId, actor.sessionId].join(':');
    if (seen.has(key)) continue;
    seen.add(key);
    actors.push(actor);
  }
  return actors;
}

export function normalizeControlStateSummary(
  value: unknown,
  fallbackReason = 'legacy-backfill'
): ControlStateSummary {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return createLegacyControlStateSummary(fallbackReason);
  }

  const record = value as Record<string, unknown>;
  const legacy = createLegacyControlStateSummary(fallbackReason);
  const activeActors = normalizeControlActors(record.activeActors);
  const activeWorker = normalizeControlActor(record.activeWorker);
  const lastInterventionBy = normalizeControlActor(record.lastInterventionBy);
  const controlReason = optionalString(record.controlReason);

  const summary: ControlStateSummary = {
    controlMode: isControlMode(record.controlMode)
      ? record.controlMode
      : legacy.controlMode,
    activeActors: activeActors.length > 0 ? activeActors : legacy.activeActors,
    lastInterventionAt: optionalNullableString(record.lastInterventionAt),
    lastInterventionBy: lastInterventionBy ?? null,
    lastInterventionEventId: optionalNullableString(record.lastInterventionEventId),
    controlFreshness: isControlFreshness(record.controlFreshness)
      ? record.controlFreshness
      : legacy.controlFreshness,
  };
  if (activeWorker) summary.activeWorker = activeWorker;
  if (controlReason) {
    summary.controlReason = controlReason;
  } else if (legacy.controlReason) {
    summary.controlReason = legacy.controlReason;
  }
  return summary;
}

export function isControlStateSummary(
  value: unknown
): value is ControlStateSummary {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    isControlMode(record.controlMode) &&
    normalizeControlActors(record.activeActors).length > 0 &&
    isControlFreshness(record.controlFreshness) &&
    (record.activeWorker === undefined ||
      normalizeControlActor(record.activeWorker) !== undefined) &&
    (record.lastInterventionBy === null ||
      normalizeControlActor(record.lastInterventionBy) !== undefined) &&
    (record.lastInterventionAt === null ||
      typeof record.lastInterventionAt === 'string') &&
    (record.lastInterventionEventId === null ||
      typeof record.lastInterventionEventId === 'string') &&
    (record.controlReason === undefined || typeof record.controlReason === 'string')
  );
}

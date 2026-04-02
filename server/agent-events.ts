import type { EventSourceType } from './types.js';

export type AgentEventType =
  | 'session.started'
  | 'session.idle'
  | 'session.ended'
  | 'prompt.submitted'
  | 'tool.started'
  | 'tool.finished'
  | 'permission.requested'
  | 'permission.resolved'
  | 'telemetry.updated'
  | 'state.changed';

export interface AgentEvent {
  type: AgentEventType;
  sessionId: string;
  timestamp: string;
  source: EventSourceType;
  data: Record<string, unknown>;
}

// Thin adapter — each agent framework maps its native events into AgentEvent
export interface AgentEventAdapter {
  /** Emit a canonical event */
  emit(event: AgentEvent): void;
  /** Subscribe to a specific event type */
  on(type: AgentEventType, handler: (event: AgentEvent) => void): () => void;
  /** Subscribe to all events */
  onAny(handler: (event: AgentEvent) => void): () => void;
  /** Remove all listeners (cleanup) */
  removeAll(): void;
}

/** Default in-memory implementation */
export function createEventAdapter(): AgentEventAdapter {
  const listeners = new Map<AgentEventType | '*', Set<(event: AgentEvent) => void>>();

  return {
    emit(event: AgentEvent): void {
      // Notify type-specific listeners
      const typeListeners = listeners.get(event.type);
      if (typeListeners) {
        for (const handler of typeListeners) handler(event);
      }
      // Notify wildcard listeners
      const anyListeners = listeners.get('*');
      if (anyListeners) {
        for (const handler of anyListeners) handler(event);
      }
    },

    on(type: AgentEventType, handler: (event: AgentEvent) => void): () => void {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(handler);
      return () => { listeners.get(type)?.delete(handler); };
    },

    onAny(handler: (event: AgentEvent) => void): () => void {
      if (!listeners.has('*')) listeners.set('*', new Set());
      listeners.get('*')!.add(handler);
      return () => { listeners.get('*')?.delete(handler); };
    },

    removeAll(): void {
      listeners.clear();
    },
  };
}

import type { TerminalHandle } from '../components/Terminal.js';
import { resolveSessionByKey, scopedSessionKey } from './session-keys.js';
import { useSessionsStore } from './stores/sessions.js';
import { useUiStore } from './stores/ui.js';

/**
 * Per-session Terminal handle registry.
 *
 * Workspace layout mounts multiple Terminals concurrently (one per session
 * tab). Toolbar / global keyboard handlers need to dispatch imperative calls
 * (focusTerm, fitTerm, exitCopyMode, handleImageUpload) to the *active*
 * terminal without holding a single React ref.
 *
 * Each Terminal registers its handle on mount and unregisters on unmount.
 * Callers query via `getActiveTerminalHandle()` which routes via the same
 * "send to" target the PTY ws layer uses.
 */
const handles = new Map<string, TerminalHandle>();

export function setTerminalHandle(
  sessionId: string,
  handle: TerminalHandle | null
): void {
  if (handle) handles.set(sessionId, handle);
  else handles.delete(sessionId);
}

export function getTerminalHandle(sessionId: string): TerminalHandle | null {
  return handles.get(sessionId) ?? null;
}

export function getActiveTerminalHandle(): TerminalHandle | null {
  const id =
    useUiStore.getState().sendToTargetSessionId ??
    useSessionsStore.getState().activeSessionId;
  if (!id) return null;
  const session = resolveSessionByKey(useSessionsStore.getState().sessions, id);
  return handles.get(session ? scopedSessionKey(session) : id) ?? null;
}

/** @internal — exposed for tests */
export function _terminalHandlesForTesting(): Map<string, TerminalHandle> {
  return handles;
}

/** @internal — exposed for tests */
export function _clearTerminalHandlesForTesting(): void {
  handles.clear();
}

export const DEFAULT_MAX_PTY_SESSIONS = 64;

export interface PtyCapacityResponse {
  error: 'pty_capacity_exhausted';
  message: string;
  activePtySessions: number;
  maxPtySessions: number;
}

type SessionLike = {
  mode?: string;
  status?: string;
};

export function resolveMaxPtySessions(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_MAX_PTY_SESSIONS;
  }
  return Math.max(1, Math.floor(value));
}

export function countActivePtySessions(sessions: SessionLike[]): number {
  return sessions.filter(
    (session) =>
      session.mode === 'pty' && (session.status ?? 'active') === 'active'
  ).length;
}

export function buildPtyCapacityResponse(
  activePtySessions: number,
  maxPtySessions: unknown
): PtyCapacityResponse | null {
  const resolvedMax = resolveMaxPtySessions(maxPtySessions);
  if (activePtySessions < resolvedMax) return null;
  return {
    error: 'pty_capacity_exhausted',
    message: `Session limit reached: ${activePtySessions} active PTY sessions. Close inactive sessions and try again.`,
    activePtySessions,
    maxPtySessions: resolvedMax,
  };
}

function isPtySpawnCapacityError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const candidate = error as Error & { code?: string };
  if (candidate.message.includes('posix_spawnp failed')) return true;
  return ['EAGAIN', 'ENOMEM', 'EMFILE', 'ENFILE'].includes(
    candidate.code ?? ''
  );
}

export function sessionCreateErrorResponse(
  error: unknown,
  activePtySessions: number,
  maxPtySessions: unknown
): PtyCapacityResponse | null {
  if (!isPtySpawnCapacityError(error)) return null;
  return {
    error: 'pty_capacity_exhausted',
    message:
      'Unable to start a new terminal session. Too many PTY sessions may already be active; close inactive sessions and try again.',
    activePtySessions,
    maxPtySessions: resolveMaxPtySessions(maxPtySessions),
  };
}

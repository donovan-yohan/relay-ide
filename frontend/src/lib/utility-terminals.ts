import type { SessionSummary } from './types.js';

export function getMainWorkspaceSessions(
  sessions: SessionSummary[],
  utilityTerminalIds: readonly string[] | undefined
): SessionSummary[] {
  if (!utilityTerminalIds?.length) return sessions;
  const utilityIds = new Set(utilityTerminalIds);
  return sessions.filter(
    (session) => !(session.type === 'terminal' && utilityIds.has(session.id))
  );
}

export function getUtilityTerminalSessions(
  sessions: SessionSummary[],
  utilityTerminalIds: readonly string[] | undefined
): SessionSummary[] {
  if (!utilityTerminalIds?.length) return [];
  const byId = new Map(sessions.map((session) => [session.id, session]));
  return utilityTerminalIds.flatMap((id) => {
    const session = byId.get(id);
    return session?.type === 'terminal' ? [session] : [];
  });
}

function pathHint(session: SessionSummary, workspacePath: string): string | null {
  const path = session.cwd || session.worktreePath || session.repoPath || workspacePath;
  const cleaned = path.replace(/\/+$/, '');
  const base = cleaned.split('/').filter(Boolean).at(-1);
  return base || null;
}

export function getUtilityTerminalTitle(
  session: SessionSummary,
  index: number,
  workspacePath: string
): string {
  const displayName = session.displayName?.trim();
  if (displayName) return displayName;
  const fallback = `terminal ${index + 1}`;
  const hint = pathHint(session, workspacePath);
  return hint ? `${fallback} · ${hint}` : fallback;
}

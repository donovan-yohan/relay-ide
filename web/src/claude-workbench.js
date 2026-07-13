export const MAX_RECENT_CLAUDE_SESSIONS = 16;

const MAX_ID_LENGTH = 256;
const MAX_PTY_ID_LENGTH = 64;
const MAX_CWD_LENGTH = 512;
const MAX_TITLE_LENGTH = 96;
const STATUSES = new Set(["starting", "running", "exited", "closing", "closed"]);
const PTY_ID = /^claude-pty-[A-Za-z0-9-]+$/;

export function sessionSurface(session) {
  return session?.provider === "claude" ? "terminal" : "chat";
}

export function serializeRecentClaudeSessions(sessions) {
  const recent = [];
  for (const session of sessions) {
    const metadata = claudeMetadata(session);
    if (!metadata) continue;
    recent.push(metadata);
    if (recent.length >= MAX_RECENT_CLAUDE_SESSIONS) break;
  }
  return JSON.stringify(recent);
}

export function restoreRecentClaudeSessions(serialized) {
  let values;
  try {
    values = JSON.parse(serialized ?? "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(values)) return [];
  return values
    .slice(0, MAX_RECENT_CLAUDE_SESSIONS)
    .map((value) => claudeMetadata(value))
    .filter(Boolean);
}

export function mergeRecentClaudeSessions(liveSessions, recent, workspace) {
  if (!workspace) return [...liveSessions];
  const merged = [...liveSessions];
  const livePtyIds = new Set(
    liveSessions
      .filter((session) => session.provider === "claude")
      .map((session) => session.providerSessionId),
  );
  const restoredPtyIds = new Set();
  for (const metadata of recent) {
    if (
      metadata.workspaceCwd !== workspace.cwd
      || livePtyIds.has(metadata.providerSessionId)
      || restoredPtyIds.has(metadata.providerSessionId)
    ) continue;
    restoredPtyIds.add(metadata.providerSessionId);
    merged.push({
      ...metadata,
      workspaceId: workspace.id,
      staleCandidate: true,
      events: [],
    });
  }
  return merged;
}

export function claudeMetadata(session, workspaceCwd = session?.workspaceCwd) {
  if (
    session?.provider !== "claude"
    || !boundedText(session.id, MAX_ID_LENGTH)
    || !boundedText(workspaceCwd, MAX_CWD_LENGTH)
    || !boundedText(session.providerSessionId, MAX_PTY_ID_LENGTH)
    || !PTY_ID.test(session.providerSessionId)
    || !boundedText(session.title ?? "Claude Code", MAX_TITLE_LENGTH)
    || !STATUSES.has(session.status)
  ) {
    return null;
  }
  return {
    id: session.id,
    workspaceCwd,
    provider: "claude",
    providerSessionId: session.providerSessionId,
    status: session.status,
    title: session.title ?? "Claude Code",
  };
}

function boundedText(value, limit) {
  return typeof value === "string" && value.length > 0 && value.length <= limit;
}

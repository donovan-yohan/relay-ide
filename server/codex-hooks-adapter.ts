import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

interface CodexHook {
  type: 'command';
  command: string;
}

interface CodexHooksConfig {
  [eventName: string]: CodexHook[];
}

// Codex hook event names that we relay
const CODEX_EVENTS = ['SessionStart', 'Stop', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse'] as const;

// Map codex events to our canonical event types
const EVENT_MAP: Record<string, string> = {
  SessionStart: 'session.started',
  Stop: 'session.ended',
  UserPromptSubmit: 'prompt.submitted',
  PreToolUse: 'tool.started',
  PostToolUse: 'tool.finished',
};

/**
 * Write codex hooks adapter to a temp directory.
 * Returns the directory path (set as CODEX_CONFIG_DIR).
 */
export function writeCodexHooksAdapter(
  sessionId: string,
  port: number,
  hookToken: string,
  _configDir: string,
): string {
  const tmpDir = path.join(os.tmpdir(), 'claude-remote-cli', `codex-hooks-${sessionId}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  // Write relay script
  const relayScript = `#!/usr/bin/env bash
set -u
INPUT=$(cat)
EVENT="\${HOOK_EVENT_NAME:-unknown}"
CANONICAL_EVENT=""
case "$EVENT" in
  SessionStart) CANONICAL_EVENT="session.started" ;;
  Stop) CANONICAL_EVENT="session.ended" ;;
  UserPromptSubmit) CANONICAL_EVENT="prompt.submitted" ;;
  PreToolUse) CANONICAL_EVENT="tool.started" ;;
  PostToolUse) CANONICAL_EVENT="tool.finished" ;;
  *) CANONICAL_EVENT="$EVENT" ;;
esac
curl -s -X POST "http://127.0.0.1:${port}/hooks/agent-event" \\
  -H "Content-Type: application/json" \\
  -d "{\\"sessionId\\":\\"${sessionId}\\",\\"token\\":\\"${hookToken}\\",\\"eventType\\":\\"$CANONICAL_EVENT\\",\\"data\\":$INPUT,\\"timestamp\\":\\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\\"}" \\
  > /dev/null 2>&1 || true
`;
  const relayPath = path.join(tmpDir, 'relay.sh');
  fs.writeFileSync(relayPath, relayScript, { mode: 0o755 });

  // Read existing user hooks if present
  let existingHooks: CodexHooksConfig = {};
  const userHooksPath = path.join(os.homedir(), '.codex', 'hooks.json');
  try {
    existingHooks = JSON.parse(fs.readFileSync(userHooksPath, 'utf-8'));
  } catch { /* no existing hooks */ }

  // Build merged hooks: append our relay to each event
  const relayHook: CodexHook = { type: 'command', command: relayPath };
  const mergedHooks: CodexHooksConfig = { ...existingHooks };
  for (const event of CODEX_EVENTS) {
    const existing = mergedHooks[event] ?? [];
    mergedHooks[event] = [...existing, relayHook];
  }

  fs.writeFileSync(path.join(tmpDir, 'hooks.json'), JSON.stringify(mergedHooks, null, 2));

  return tmpDir;
}

/** Exported for testing */
export { CODEX_EVENTS, EVENT_MAP };

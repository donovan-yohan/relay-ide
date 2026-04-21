import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createLogger } from './logger.js';

const logger = createLogger('codex-hooks-adapter');

interface CodexHook {
  type: 'command';
  command: string;
}

interface CodexHooksConfig {
  [eventName: string]: CodexHook[];
}

// Codex hook event names that we relay
const CODEX_EVENTS = [
  'SessionStart',
  'Stop',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
] as const;

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
  _configDir: string
): string {
  const tmpDir = path.join(
    os.tmpdir(),
    'relay-ide',
    `codex-hooks-${sessionId}`
  );
  fs.mkdirSync(tmpDir, { recursive: true });

  // Write session config for the relay script to read
  const configPath = path.join(tmpDir, 'session.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify({ sessionId, port, hookToken }),
    'utf-8'
  );
  logger.debug('Wrote Codex session config', configPath);

  // Write relay script — reads config from file to avoid shell injection
  // Parse session.json once (single node invocation) to extract all values at once for performance.
  // Extracts transcript_path from the Codex hook payload (available on SessionStart and other events).
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
CONFIG_FILE="${configPath}"
  read -r SESSION_ID PORT TOKEN < <(node -e "const fs=require('node:fs');const{sessionId,port,hookToken}=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));process.stdout.write([sessionId,port,hookToken].join(' ')+'\\n');" "$CONFIG_FILE")
TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)
# Extract transcript_path from Codex hook payload using node for reliable JSON parsing
TRANSCRIPT_PATH=$(printf '%s' "$INPUT" | node -e "const fs=require('node:fs');const data=JSON.parse(fs.readFileSync(0,'utf8'));console.log(data.transcript_path||'')" 2>/dev/null || echo '')
# Build data payload with transcript_path if available
if [ -n "$TRANSCRIPT_PATH" ]; then
  DATA_PAYLOAD=$(printf '%s' "$INPUT" | node -e "const fs=require('node:fs');const data=JSON.parse(fs.readFileSync(0,'utf8'));data.transcript_path=data.transcript_path||'';console.log(JSON.stringify(data))" 2>/dev/null || echo "$INPUT")
else
  DATA_PAYLOAD="$INPUT"
fi
PAYLOAD=$(printf '{"sessionId":"%s","token":"%s","eventType":"%s","data":%s,"timestamp":"%s"}' "$SESSION_ID" "$TOKEN" "$CANONICAL_EVENT" "$DATA_PAYLOAD" "$TIMESTAMP")
curl -s -X POST "http://127.0.0.1:$PORT/hooks/agent-event" \\
  -H "Content-Type: application/json" \\
  -d "$PAYLOAD" \\
  > /dev/null 2>&1 || true
`;
  const relayPath = path.join(tmpDir, 'relay.sh');
  fs.writeFileSync(relayPath, relayScript, { mode: 0o755 });

  // Read existing user hooks if present
  let existingHooks: CodexHooksConfig = {};
  const userHooksPath = path.join(os.homedir(), '.codex', 'hooks.json');
  try {
    existingHooks = JSON.parse(fs.readFileSync(userHooksPath, 'utf-8'));
  } catch {
    /* no existing hooks */
  }

  // Build merged hooks: append our relay to each event
  const relayHook: CodexHook = { type: 'command', command: relayPath };
  const mergedHooks: CodexHooksConfig = { ...existingHooks };
  for (const event of CODEX_EVENTS) {
    const existing = mergedHooks[event] ?? [];
    mergedHooks[event] = [...existing, relayHook];
  }

  fs.writeFileSync(
    path.join(tmpDir, 'hooks.json'),
    JSON.stringify(mergedHooks, null, 2)
  );

  return tmpDir;
}

/**
 * Remove the codex hooks adapter temp directory for a session.
 * Called when the session ends to avoid leaking temp files.
 */
export function cleanupCodexHooksAdapter(sessionId: string): void {
  const tmpDir = path.join(
    os.tmpdir(),
    'relay-ide',
    `codex-hooks-${sessionId}`
  );
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    logger.debug('Cleaned up Codex hooks adapter', tmpDir);
  } catch {
    // Non-fatal — temp dir may not exist or already be cleaned up
  }
}

/** Exported for testing */
export { CODEX_EVENTS, EVENT_MAP };

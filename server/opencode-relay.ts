import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** Source code for the opencode relay plugin — written to opencode's plugin directory */
const RELAY_PLUGIN_SOURCE = `
// OpenCode plugin that relays lifecycle events to claude-remote-cli server.
// Reads CRC_RELAY_URL, CRC_SESSION_ID, CRC_RELAY_TOKEN from env (injected per session by PTY handler).
export default async () => {
  const relayUrl = process.env.CRC_RELAY_URL;
  const sessionId = process.env.CRC_SESSION_ID;
  const token = process.env.CRC_RELAY_TOKEN;

  if (!relayUrl || !sessionId || !token) return {};

  const relay = async (eventType, data = {}) => {
    try {
      await fetch(\`\${relayUrl}/hooks/agent-event\`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, token, eventType, data, timestamp: new Date().toISOString() }),
      });
    } catch { /* best-effort, don't crash opencode */ }
  };

  return {
    'session.created': async () => relay('session.started'),
    'session.idle': async () => relay('session.idle'),
    'session.status': async (input) => relay('state.changed', { status: input }),
    'session.error': async (input) => relay('state.changed', { status: 'error', error: input }),
    'permission.asked': async (input) => relay('permission.requested', { permission: input }),
    'permission.replied': async (input) => relay('permission.resolved', { reply: input }),
    'tool.execute.before': async (input) => relay('tool.started', { tool: input }),
    'tool.execute.after': async (input, output) => relay('tool.finished', { tool: input, result: output }),
    'message.updated': async (input) => relay('telemetry.updated', { message: input }),
  };
};
`.trim();

/**
 * Write the relay plugin to opencode's global plugin directory.
 * Idempotent — overwrites the same file each time.
 *
 * @param pluginDir - Override the plugin directory (defaults to ~/.config/opencode/plugins). Used in tests.
 * @returns The path to the written plugin file.
 */
export function installOpencodeRelayPlugin(pluginDir?: string): string {
  const dir =
    pluginDir ?? path.join(os.homedir(), '.config', 'opencode', 'plugins');
  fs.mkdirSync(dir, { recursive: true });
  const pluginPath = path.join(dir, 'crc-relay.ts');
  fs.writeFileSync(pluginPath, RELAY_PLUGIN_SOURCE, 'utf-8');
  return pluginPath;
}

/** Exported for testing */
export { RELAY_PLUGIN_SOURCE };

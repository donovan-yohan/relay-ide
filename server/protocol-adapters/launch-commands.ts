/**
 * Canonical subprocess commands for channel adapters. Keeping these outside the
 * adapter registry avoids registry/factory import cycles while making preflight
 * and spawn use the same values.
 */
export const CLAUDE_CHANNEL_COMMAND = 'claude';
export const CODEX_CHANNEL_COMMAND = 'codex';
export const PRIME_AGENT_CHANNEL_COMMAND = 'prime-agent';
export const PI_AGENT_CHANNEL_COMMAND = 'pi';
export const OPENCODE_CHANNEL_COMMAND = 'opencode';
export const ANTIGRAVITY_CHANNEL_COMMAND = 'agy';

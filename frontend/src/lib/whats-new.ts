/**
 * what's-new registry
 *
 * Keys are exact version strings. Each entry maps feature IDs to short
 * description strings shown as toasts on first visit after an upgrade.
 *
 * Rules:
 * - exact version match only (no semver comparison)
 * - max 2 toasts per page load (enforced by useWhatsNew hook)
 * - suppressed during active onboarding
 */
export const WHATS_NEW: Record<string, Record<string, string>> = {
  '0.1.0': {
    'remote-access': 'relay-ide is running. access from any device on your network via the remote access url in settings.',
    'command-palette': 'try cmd+k to open the command palette — search repos, sessions, prs, and settings.',
  },
};

export default WHATS_NEW;

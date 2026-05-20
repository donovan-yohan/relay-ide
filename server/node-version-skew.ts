/**
 * Hub↔node helper-version skew detection.
 *
 * Compatibility policy (ADR-017 / #655):
 *   - `compatible`         — node helperVersion equals hub version (or falls
 *                            within the same major and helper minor ≥ hub minor − 2)
 *   - `minor-skew-warn`    — same major, helper minor in range [hubMinor−2, hubMinor)
 *                            or > hubMinor (node is ahead); sessions are allowed
 *   - `major-skew-error`   — different major version; new session-create is blocked
 *                            (HTTP 503 with Retry-After); existing sessions drain
 *
 * The policy is intentionally lenient on minor skew: nodes are commonly one or
 * two minor versions behind the hub during a rolling fleet update, and their
 * surface compatibility is governed by the node-link protocol version check
 * (which already rejects incompatible protocol majors). Helper version skew is
 * an advisory warning at minor distance and a hard gate only at major distance.
 */

export type HelperSkewCategory =
  | 'compatible'
  | 'minor-skew-warn'
  | 'major-skew-error';

export interface HelperSkewResult {
  category: HelperSkewCategory;
  helperVersion: string;
  hubVersion: string;
  /** Human-readable message suitable for UI and logs. */
  message: string;
  /** Remediation hint shown when category is not `compatible`. */
  remediationHint?: string;
}

function parseMajorMinor(version: string): { major: number; minor: number } {
  const withoutPre = version.split('-', 1)[0]!;
  const parts = withoutPre.split('.');
  return {
    major: Number(parts[0] ?? '0'),
    minor: Number(parts[1] ?? '0'),
  };
}

/**
 * Classify the helper version skew between a node and the hub.
 *
 * @param helperVersion  The version string from `NodeManifest.helperVersion`
 *                       (or `relayVersion` for pre-#651 nodes).
 * @param hubVersion     The hub's own package.json version.
 */
export function classifyHelperSkew(
  helperVersion: string,
  hubVersion: string
): HelperSkewResult {
  if (!helperVersion || helperVersion === 'unknown') {
    return {
      category: 'minor-skew-warn',
      helperVersion,
      hubVersion,
      message:
        'node helper version is unknown; cannot determine compatibility. sessions are allowed.',
      remediationHint:
        'run `relay-ide node update` on the node to install the latest version.',
    };
  }

  const node = parseMajorMinor(helperVersion);
  const hub = parseMajorMinor(hubVersion);

  if (node.major !== hub.major) {
    return {
      category: 'major-skew-error',
      helperVersion,
      hubVersion,
      message: `node helper v${helperVersion} is a different major version than hub v${hubVersion}; new sessions blocked until node is updated.`,
      remediationHint: `run \`relay-ide node update\` on the node to install relay-ide v${hubVersion}.`,
    };
  }

  // Same major. Accept helper minor within [hubMinor − 2, ∞).
  // Nodes ahead of the hub (minor > hub.minor) are allowed — hub may be behind.
  const minorGap = hub.minor - node.minor;
  if (minorGap <= 0 || minorGap <= 2) {
    // compatible or close-enough
    if (helperVersion === hubVersion) {
      return {
        category: 'compatible',
        helperVersion,
        hubVersion,
        message: `node helper v${helperVersion} matches hub v${hubVersion}.`,
      };
    }
    if (minorGap === 0 && node.minor === hub.minor) {
      // same major.minor but pre-release mismatch — treat as compatible
      return {
        category: 'compatible',
        helperVersion,
        hubVersion,
        message: `node helper v${helperVersion} is compatible with hub v${hubVersion}.`,
      };
    }
    // minor gap ≤ 2 but not identical — warn
    return {
      category: 'minor-skew-warn',
      helperVersion,
      hubVersion,
      message: `node helper v${helperVersion} is slightly behind hub v${hubVersion}; sessions are allowed but an update is recommended.`,
      remediationHint: `run \`relay-ide node update\` on the node to install relay-ide v${hubVersion}.`,
    };
  }

  // minor gap > 2 — still same major, but warn louder
  return {
    category: 'minor-skew-warn',
    helperVersion,
    hubVersion,
    message: `node helper v${helperVersion} is ${minorGap} minor versions behind hub v${hubVersion}; sessions are allowed but update is strongly recommended.`,
    remediationHint: `run \`relay-ide node update\` on the node to install relay-ide v${hubVersion}.`,
  };
}

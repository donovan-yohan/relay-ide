import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import {
  RELAY_CLI_GATEWAY_CONTRACT,
  gatewayOk,
  stableCommandNames,
} from '../shared/cli-gateway-contract.js';
import {
  RELAY_COMMAND_MANIFEST,
  relayCommandDefinitionsForSurface,
} from '../shared/relay-command-manifest.js';

/**
 * Control character regex forbidding unescaped C0 control codes except \t (0x09), \n (0x0A), and \r (0x0D).
// eslint-disable-next-line no-control-regex -- the control characters ARE the assertion * Matches ASCII range [\x00-\x08\x0b\x0c\x0e-\x1f].
 */
const CONTROL_CHAR_REGEX = /[\x00-\x08\x0b\x0c\x0e-\x1f]/;

/**
 * Documented allowlist for intentional gaps between the Relay command manifest
 * and the CLI gateway contract.
 *
 * If a command is temporarily present in one definition and omitted in another
 * during active development, add an entry here with a tracking issue / TODO.
 * Under normal conditions, this allowlist must remain empty.
 */
export const KNOWN_CONTRACT_MANIFEST_GAPS: readonly {
  command: string;
  presentIn: 'manifest-only' | 'contract-only';
  reason: string;
  todo: string;
}[] = [];

function extractRelayCliGatewayCommandUnion(source: string): string[] {
  const match = source.match(
    /export\s+type\s+RelayCliGatewayCommand\s*=\s*([\s\S]*?);/
  );
  if (!match || !match[1]) {
    throw new Error(
      'Failed to locate RelayCliGatewayCommand union in shared/cli-gateway-contract.ts'
    );
  }
  const commandMatches = match[1].matchAll(/'([^']+)'/g);
  return Array.from(commandMatches, (m) => m[1]).filter((s): s is string => s !== undefined);
}

function extractCommandLabelsKeys(source: string): string[] {
  const match = source.match(
    /const\s+COMMAND_LABELS:\s*Record<RelayCliGatewayCommand,\s*string>\s*=\s*\{([\s\S]*?)\};/
  );
  if (!match || !match[1]) {
    throw new Error(
      'Failed to locate COMMAND_LABELS in shared/relay-command-manifest.ts'
    );
  }
  const keyMatches = match[1].matchAll(/'([^']+)':/g);
  return Array.from(keyMatches, (m) => m[1]).filter((s): s is string => s !== undefined);
}

function collectAllStrings(value: unknown, path: string = ''): { path: string; text: string }[] {
  const results: { path: string; text: string }[] = [];
  if (typeof value === 'string') {
    results.push({ path, text: value });
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => {
      results.push(...collectAllStrings(item, `${path}[${index}]`));
    });
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, propValue] of Object.entries(value)) {
      results.push(...collectAllStrings(propValue, path ? `${path}.${key}` : key));
    }
  }
  return results;
}

describe('CLI gateway contract and command manifest completeness', () => {
  it('enforces two-way completeness between command manifest and CLI gateway contract schemas', () => {
    const contractSource = readFileSync(
      new URL('../shared/cli-gateway-contract.ts', import.meta.url),
      'utf8'
    );
    const manifestSource = readFileSync(
      new URL('../shared/relay-command-manifest.ts', import.meta.url),
      'utf8'
    );

    const manifestCommandNames = RELAY_COMMAND_MANIFEST.commands.map(
      (cmd) => cmd.name
    );
    const contractCommandNames =
      RELAY_CLI_GATEWAY_CONTRACT.commandSchemas.map((spec) => spec.name);
    const stableNames = stableCommandNames();
    const unionCommandNames = extractRelayCliGatewayCommandUnion(contractSource);
    const labelCommandKeys = extractCommandLabelsKeys(manifestSource);

    // Verify uniqueness
    expect(new Set(manifestCommandNames).size).toBe(manifestCommandNames.length);
    expect(new Set(contractCommandNames).size).toBe(contractCommandNames.length);
    expect(new Set(unionCommandNames).size).toBe(unionCommandNames.length);
    expect(new Set(labelCommandKeys).size).toBe(labelCommandKeys.length);

    const allowedManifestOnly = new Set(
      KNOWN_CONTRACT_MANIFEST_GAPS.filter(
        (gap) => gap.presentIn === 'manifest-only'
      ).map((gap) => gap.command)
    );
    const allowedContractOnly = new Set(
      KNOWN_CONTRACT_MANIFEST_GAPS.filter(
        (gap) => gap.presentIn === 'contract-only'
      ).map((gap) => gap.command)
    );

    // 1. Every command in manifest must exist in contract schemas (unless allowlisted)
    for (const name of manifestCommandNames) {
      if (!allowedManifestOnly.has(name)) {
        expect(
          contractCommandNames,
          `Manifest command "${name}" missing from RELAY_CLI_GATEWAY_CONTRACT.commandSchemas`
        ).toContain(name);
      }
    }

    // 2. Every command in contract schemas must exist in manifest (unless allowlisted)
    for (const name of contractCommandNames) {
      if (!allowedContractOnly.has(name)) {
        expect(
          manifestCommandNames,
          `Contract command "${name}" missing from RELAY_COMMAND_MANIFEST.commands`
        ).toContain(name);
      }
    }

    // 3. stableCommandNames() must match contractCommandNames exactly
    expect(stableNames).toEqual(contractCommandNames);

    // 4. RelayCliGatewayCommand union in source must contain the exact same commands
    expect(new Set(unionCommandNames)).toEqual(new Set(contractCommandNames));
    expect(unionCommandNames.length).toBe(contractCommandNames.length);

    // 5. COMMAND_LABELS in manifest source must contain the exact same commands
    expect(new Set(labelCommandKeys)).toEqual(new Set(manifestCommandNames));
    expect(labelCommandKeys.length).toBe(manifestCommandNames.length);

    // 6. Manifest commands must match contract commands in exact order when no gaps exist
    if (KNOWN_CONTRACT_MANIFEST_GAPS.length === 0) {
      expect(manifestCommandNames).toEqual(contractCommandNames);
    }
  });

  it('enforces that all surface projections (cli, agent, web) contain every gateway command', () => {
    const contractCommandNames =
      RELAY_CLI_GATEWAY_CONTRACT.commandSchemas.map((spec) => spec.name);

    for (const surface of ['cli', 'agent', 'web'] as const) {
      const surfaceCommandNames = relayCommandDefinitionsForSurface(surface).map(
        (cmd) => cmd.name
      );
      expect(surfaceCommandNames).toEqual(contractCommandNames);
    }
  });

  it('enforces strict-JSON serialization on v1 schema payloads without control characters', () => {
    // Builders discovered from bin/relay-ide.ts (runGatewayV1) and shared/cli-gateway-contract.ts
    const schemaPayload = gatewayOk(
      'contract.schema',
      RELAY_CLI_GATEWAY_CONTRACT
    );
    const listPayload = gatewayOk('contract.list', {
      commands: RELAY_CLI_GATEWAY_CONTRACT.commandSchemas,
      errorEnvelopeSchema: RELAY_CLI_GATEWAY_CONTRACT.errorEnvelopeSchema,
    });
    const manifestPayload = RELAY_COMMAND_MANIFEST;
    const rawContractPayload = RELAY_CLI_GATEWAY_CONTRACT;

    const payloads = [
      { name: 'contract.schema payload', payload: schemaPayload },
      { name: 'contract.list payload', payload: listPayload },
      { name: 'RELAY_COMMAND_MANIFEST', payload: manifestPayload },
      { name: 'RELAY_CLI_GATEWAY_CONTRACT', payload: rawContractPayload },
    ];

    for (const { name, payload } of payloads) {
      // Compact JSON round-trip
      const compactJson = JSON.stringify(payload);
      expect(
        JSON.parse(compactJson),
        `${name} must round-trip via compact JSON`
      ).toEqual(payload);
      expect(
        CONTROL_CHAR_REGEX.test(compactJson),
        `${name} compact JSON must contain zero unescaped control characters`
      ).toBe(false);

      // Pretty JSON round-trip
      const prettyJson = JSON.stringify(payload, null, 2);
      expect(
        JSON.parse(prettyJson),
        `${name} must round-trip via formatted JSON`
      ).toEqual(payload);
      expect(
        CONTROL_CHAR_REGEX.test(prettyJson),
        `${name} formatted JSON must contain zero unescaped control characters`
      ).toBe(false);
    }
  });

  it('guards against raw control characters in all schema string values', () => {
    const contractStrings = collectAllStrings(RELAY_CLI_GATEWAY_CONTRACT, 'contract');
    for (const { path, text } of contractStrings) {
      expect(
        CONTROL_CHAR_REGEX.test(text),
        `Control character detected in contract at ${path}: ${JSON.stringify(text)}`
      ).toBe(false);
    }

    const manifestStrings = collectAllStrings(RELAY_COMMAND_MANIFEST, 'manifest');
    for (const { path, text } of manifestStrings) {
      expect(
        CONTROL_CHAR_REGEX.test(text),
        `Control character detected in manifest at ${path}: ${JSON.stringify(text)}`
      ).toBe(false);
    }
  });
});

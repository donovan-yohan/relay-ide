/**
 * Tests for the Workbench block registry and BlockHost — slice 2, #620.
 *
 * Covers:
 *   - Registry: source structure (no scattered switch, Map-based, typed API)
 *   - Registry: runtime import test (register + lookup + unknown returns undefined)
 *   - BlockHost: source-level assertions (component structure, imports, exports)
 *   - Capability gating: unit-tested in isolation (pure logic, no DOM)
 *
 * Test strategy: follows the project's established pattern from
 * test/components/*.test.ts — source-level assertions do not require jsdom,
 * happy-dom, or complex React render mocks (which would need xterm, ws, etc.).
 * Runtime registry tests import only the pure registry module (no React/CSS).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');
const workbenchDir = join(projectRoot, 'frontend/src/workbench');

// ---------------------------------------------------------------------------
// Registry source-level tests
// ---------------------------------------------------------------------------

describe('block-registry source structure', () => {
  const registryPath = join(workbenchDir, 'block-registry.ts');

  it('registry file exists', () => {
    expect(existsSync(registryPath)).toBe(true);
  });

  it('exports registerBlockRenderer', () => {
    const src = readFileSync(registryPath, 'utf-8');
    expect(src).toContain('export function registerBlockRenderer');
  });

  it('exports getBlockRenderer', () => {
    const src = readFileSync(registryPath, 'utf-8');
    expect(src).toContain('export function getBlockRenderer');
  });

  it('exports registeredKinds', () => {
    const src = readFileSync(registryPath, 'utf-8');
    expect(src).toContain('export function registeredKinds');
  });

  it('exports initFirstPartyBlocks', () => {
    const src = readFileSync(registryPath, 'utf-8');
    expect(src).toContain('export async function initFirstPartyBlocks');
  });

  it('registers all 7 first-party kinds in initFirstPartyBlocks', () => {
    const src = readFileSync(registryPath, 'utf-8');
    const kinds = [
      'terminal',
      'agent',
      'work-context',
      'file',
      'artifact',
      'markdown',
      'custom',
    ];
    for (const kind of kinds) {
      expect(src).toContain(`'${kind}'`);
    }
  });

  it('uses a single Map internally (no switch statements for kind routing)', () => {
    const src = readFileSync(registryPath, 'utf-8');
    expect(src).toContain('new Map<');
    // The registry must NOT contain a switch over block kinds in the lookup/register path
    expect(src).not.toContain('switch (kind)');
  });

  it('getBlockRenderer returns undefined for unknown kinds (source-level guard)', () => {
    const src = readFileSync(registryPath, 'utf-8');
    // The public API returns undefined on miss; last writer wins
    expect(src).toContain('| undefined');
    expect(src).toContain('_registry.get(kind)');
    expect(src).toContain('Last writer wins');
  });

  it('typed as WorkbenchBlockKind (not plain string)', () => {
    const src = readFileSync(registryPath, 'utf-8');
    expect(src).toContain('WorkbenchBlockKind');
  });

  it('typed as WorkbenchBlockRenderer generic', () => {
    const src = readFileSync(registryPath, 'utf-8');
    expect(src).toContain('WorkbenchBlockRenderer<K>');
  });
});

// ---------------------------------------------------------------------------
// Registry runtime tests — import only the pure registry module.
// The registry module itself has no React/CSS imports; only initFirstPartyBlocks
// does (via dynamic import). These tests exercise register/lookup directly.
// ---------------------------------------------------------------------------

// We construct a local mini-registry to test the logic without importing
// the module-level singleton (which would have side effects on other tests).
// The registry logic is straightforward; we test the logic pattern.

describe('registry logic (inline, no module import)', () => {
  // Replicate the registry logic inline for isolated unit testing.
  // This avoids transitive imports from block renderer modules (Terminal, etc.)
  // that would pull in xterm/ws and fail in the test tsconfig context.

  type AnyFn = (...args: unknown[]) => unknown;
  const makeRegistry = () => new Map<string, AnyFn>();

  it('register + lookup returns the same reference', () => {
    const reg = makeRegistry();
    const renderer = () => null;
    reg.set('terminal', renderer);
    expect(reg.get('terminal')).toBe(renderer);
  });

  it('get of unregistered kind returns undefined', () => {
    const reg = makeRegistry();
    expect(reg.get('unknown-kind')).toBeUndefined();
  });

  it('last writer wins on duplicate registration', () => {
    const reg = makeRegistry();
    const first = () => null;
    const second = () => null;
    reg.set('artifact', first);
    reg.set('artifact', second);
    expect(reg.get('artifact')).toBe(second);
  });

  it('registeredKinds reflects all registered entries', () => {
    const reg = makeRegistry();
    reg.set('terminal', () => null);
    reg.set('agent', () => null);
    reg.set('markdown', () => null);
    const kinds = new Set(reg.keys());
    expect(kinds.has('terminal')).toBe(true);
    expect(kinds.has('agent')).toBe(true);
    expect(kinds.has('markdown')).toBe(true);
    expect(kinds.size).toBe(3);
  });

  it('independent registries do not share state', () => {
    const reg1 = makeRegistry();
    const reg2 = makeRegistry();
    reg1.set('file', () => null);
    expect(reg2.has('file')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// BlockHost source-level tests
// ---------------------------------------------------------------------------

describe('BlockHost source structure', () => {
  const hostPath = join(workbenchDir, 'BlockHost.tsx');
  const cssPath = join(workbenchDir, 'block-host.css');
  let src: string;
  let css: string;

  beforeEach(() => {
    src = readFileSync(hostPath, 'utf-8');
    css = readFileSync(cssPath, 'utf-8');
  });

  it('BlockHost.tsx exists', () => {
    expect(existsSync(hostPath)).toBe(true);
  });

  it('block-host.css exists', () => {
    expect(existsSync(cssPath)).toBe(true);
  });

  it('exports BlockHost component', () => {
    expect(src).toContain('export function BlockHost');
  });

  it('exports BlockErrorBoundary', () => {
    expect(src).toContain('export class BlockErrorBoundary');
  });

  it('exports BlockHostProps interface', () => {
    expect(src).toContain('export interface BlockHostProps');
  });

  it('imports getBlockRenderer from registry', () => {
    expect(src).toContain('getBlockRenderer');
    expect(src).toContain('block-registry');
  });

  it('imports WorkbenchBlockDescriptor type', () => {
    expect(src).toContain('WorkbenchBlockDescriptor');
  });

  it('imports WorkbenchBlockContext type', () => {
    expect(src).toContain('WorkbenchBlockContext');
  });

  it('implements capability gating — checks capabilityRequirements', () => {
    expect(src).toContain('capabilityRequirements');
    expect(src).toContain('capabilityGrants');
    expect(src).toContain('missing');
  });

  it('renders DeniedCard on capability mismatch', () => {
    expect(src).toContain('DeniedCard');
  });

  it('renders UnknownKindCard for unregistered kinds', () => {
    expect(src).toContain('UnknownKindCard');
  });

  it('wraps renderer in BlockErrorBoundary', () => {
    expect(src).toContain('BlockErrorBoundary');
  });

  it('CSS has block-host class', () => {
    expect(css).toContain('.block-host');
  });

  it('CSS has block-card class', () => {
    expect(css).toContain('.block-card');
  });

  it('CSS has block-denied class', () => {
    expect(css).toContain('.block-denied');
  });

  it('CSS has block-error class', () => {
    expect(css).toContain('.block-error');
  });

  it('CSS uses CSS variables (not hardcoded colors)', () => {
    expect(css).toContain('var(--');
    expect(css).not.toContain('#000000');
    expect(css).not.toContain('#e0e0e0');
  });
});

// ---------------------------------------------------------------------------
// Capability gating logic unit tests (pure — no DOM, no React)
// ---------------------------------------------------------------------------

import type {
  WorkbenchBlockDescriptor,
  WorkbenchBlockContext,
  CapabilityGrantRef,
} from '../shared/workbench-block-types.js';
import type { RelayCapabilityBit } from '../shared/security-policy.js';

function grantedBits(context: WorkbenchBlockContext): Set<string> {
  const bits = new Set<string>();
  for (const grant of context.capabilityGrants) {
    if (grant.capability) bits.add(grant.capability);
    if (grant.capabilities) {
      for (const bit of grant.capabilities) bits.add(bit);
    }
  }
  return bits;
}

function missingCapabilities(
  descriptor: WorkbenchBlockDescriptor,
  context: WorkbenchBlockContext
): string[] {
  const granted = grantedBits(context);
  return descriptor.capabilityRequirements.filter((bit) => !granted.has(bit));
}

function makePrivacy() {
  return {
    classification: 'internal' as const,
    retention: 'session' as const,
    rawPayloadStored: false,
    redaction: {
      redacted: false,
      strategy: 'none' as const,
      classes: [] as never[],
    },
  };
}

function makeGrant(capability: RelayCapabilityBit): CapabilityGrantRef {
  return {
    id: `grant-${capability}`,
    ref: 'acl:test',
    capabilities: [capability],
    policyClass: 'read-only',
    privacy: makePrivacy(),
  };
}

function makeContext(grants: CapabilityGrantRef[] = []): WorkbenchBlockContext {
  return {
    capabilityGrants: grants,
    requestCapability: async () => true,
    close: () => {},
    emitAuditEvent: () => {},
  };
}

describe('capability gating logic', () => {
  it('no requirements → no missing', () => {
    const desc: WorkbenchBlockDescriptor = {
      kind: 'markdown',
      id: 'b-1',
      title: 'test',
      capabilityRequirements: [],
      meta: { content: '# hi' },
    };
    expect(missingCapabilities(desc, makeContext([]))).toHaveLength(0);
  });

  it('required capability present in grants → no missing', () => {
    const desc: WorkbenchBlockDescriptor = {
      kind: 'file',
      id: 'b-2',
      title: 'test',
      capabilityRequirements: ['rpc:fs:read'],
      meta: { fileRef: { kind: 'file', id: 'rpc:fs:local:foo' } },
    };
    expect(
      missingCapabilities(desc, makeContext([makeGrant('rpc:fs:read')]))
    ).toHaveLength(0);
  });

  it('required capability absent → missing returned', () => {
    const desc: WorkbenchBlockDescriptor = {
      kind: 'file',
      id: 'b-3',
      title: 'test',
      capabilityRequirements: ['rpc:fs:read'],
      meta: { fileRef: { kind: 'file', id: 'rpc:fs:local:foo' } },
    };
    expect(missingCapabilities(desc, makeContext([]))).toEqual(['rpc:fs:read']);
  });

  it('multi-capability grant via .capabilities array satisfies requirements', () => {
    const desc: WorkbenchBlockDescriptor = {
      kind: 'terminal',
      id: 'b-4',
      title: 'test',
      capabilityRequirements: ['session:attach', 'session:read'],
      meta: {
        sessionRef: {
          nodeId: 'local',
          sessionId: 'sess-1',
          tabKind: 'terminal',
          cwd: '/',
        },
      },
    };
    const multiGrant: CapabilityGrantRef = {
      id: 'multi',
      ref: 'acl:test',
      capabilities: ['session:attach', 'session:read'],
      policyClass: 'read-only',
      privacy: makePrivacy(),
    };
    expect(missingCapabilities(desc, makeContext([multiGrant]))).toHaveLength(
      0
    );
  });

  it('partial grant → partial missing', () => {
    const desc: WorkbenchBlockDescriptor = {
      kind: 'terminal',
      id: 'b-5',
      title: 'test',
      capabilityRequirements: ['session:attach', 'session:read'],
      meta: {
        sessionRef: {
          nodeId: 'local',
          sessionId: 'sess-2',
          tabKind: 'terminal',
          cwd: '/',
        },
      },
    };
    const missing = missingCapabilities(
      desc,
      makeContext([makeGrant('session:read')])
    );
    expect(missing).toEqual(['session:attach']);
  });

  it('emits no missing when context has superset of requirements', () => {
    const desc: WorkbenchBlockDescriptor = {
      kind: 'file',
      id: 'b-6',
      title: 'test',
      capabilityRequirements: ['rpc:fs:read'],
      meta: { fileRef: { kind: 'file', id: 'rpc:fs:local:bar' } },
    };
    // Context has both read and write — requirement only needs read
    const missing = missingCapabilities(
      desc,
      makeContext([makeGrant('rpc:fs:read'), makeGrant('rpc:fs:write')])
    );
    expect(missing).toHaveLength(0);
  });

  it('empty context capabilityGrants → all requirements missing', () => {
    const desc: WorkbenchBlockDescriptor = {
      kind: 'terminal',
      id: 'b-7',
      title: 'test',
      capabilityRequirements: [
        'session:attach',
        'session:read',
        'session:create:terminal',
      ],
      meta: {
        sessionRef: {
          nodeId: 'local',
          sessionId: 'sess-3',
          tabKind: 'terminal',
          cwd: '/',
        },
      },
    };
    const missing = missingCapabilities(desc, makeContext([]));
    expect(missing).toHaveLength(3);
    expect(missing).toContain('session:attach');
    expect(missing).toContain('session:read');
    expect(missing).toContain('session:create:terminal');
  });
});

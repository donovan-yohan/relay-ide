import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  createHubNodeRegistry,
  DEFAULT_NODE_HEARTBEAT_TIMEOUTS,
} from '../server/hub-node-registry.js';
import { isNodeManifest, type NodeManifest } from '../shared/node-manifest.js';
import { buildManifestWithAgents } from './helpers/manifest-fixtures.js';

// Test-local agent list. Specific ids are an INPUT to the fixture,
// not a hardcoded global assumption baked into the core. Each test
// asserts round-trip behavior on whatever it supplies here.
const TEST_AGENTS = [
  { id: 'claude', label: 'Claude', status: 'available' as const },
  {
    id: 'codex',
    label: 'Codex',
    status: 'unavailable' as const,
    message: 'missing',
  },
];

function manifest(overrides: Partial<NodeManifest> = {}): NodeManifest {
  return buildManifestWithAgents({ agents: TEST_AGENTS, overrides });
}

function withTmpRegistry<T>(
  fn: (registry: ReturnType<typeof createHubNodeRegistry>) => T
): T {
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'relay-hub-node-registry-')
  );
  try {
    return fn(
      createHubNodeRegistry({
        storagePath: path.join(tmpDir, 'nodes.json'),
        now: () => new Date('2026-01-02T03:04:05.000Z'),
      })
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function malformedManifest(
  mutator: (candidate: Record<string, unknown>) => void
): unknown {
  const candidate = JSON.parse(JSON.stringify(manifest())) as Record<
    string,
    unknown
  >;
  mutator(candidate);
  return candidate;
}

describe('hub node registry', () => {
  it('rejects malformed nested node manifests at the shared runtime guard', () => {
    const validWithOptionalStrings = manifest({
      wsl: {
        detected: true,
        version: 2,
        distroName: 'Ubuntu',
        systemd: true,
        message: 'wsl ready',
      },
      serviceManager: {
        ...manifest().serviceManager,
        servicePath: '/tmp/relay.plist',
        unitName: 'relay.service',
        statusCommand: 'systemctl --user status relay',
        caveats: ['manual restart required'],
      },
      capabilities: {
        ...manifest().capabilities,
        tmux: {
          ...manifest().capabilities.tmux,
          path: '/usr/bin/tmux',
          version: 'tmux 3.4',
        },
      },
    });
    expect(isNodeManifest(validWithOptionalStrings)).toBe(true);

    const malformedCases: Array<[string, unknown]> = [
      [
        'capability path',
        malformedManifest((candidate) => {
          const capabilities = candidate['capabilities'] as Record<
            string,
            unknown
          >;
          const tmux = capabilities['tmux'] as Record<string, unknown>;
          tmux['path'] = 42;
        }),
      ],
      [
        'capability version',
        malformedManifest((candidate) => {
          const capabilities = candidate['capabilities'] as Record<
            string,
            unknown
          >;
          const git = capabilities['git'] as Record<string, unknown>;
          git['version'] = { text: 'git 2.0' };
        }),
      ],
      [
        'wsl version',
        malformedManifest((candidate) => {
          const wsl = candidate['wsl'] as Record<string, unknown>;
          wsl['version'] = 3;
        }),
      ],
      [
        'wsl optional string',
        malformedManifest((candidate) => {
          const wsl = candidate['wsl'] as Record<string, unknown>;
          wsl['distroName'] = false;
        }),
      ],
      [
        'agents record',
        malformedManifest((candidate) => {
          const capabilities = candidate['capabilities'] as Record<
            string,
            unknown
          >;
          capabilities['agents'] = [];
        }),
      ],
      [
        'service manager kind',
        malformedManifest((candidate) => {
          const serviceManager = candidate['serviceManager'] as Record<
            string,
            unknown
          >;
          serviceManager['kind'] = 'launchctl';
        }),
      ],
      [
        'service manager optional string',
        malformedManifest((candidate) => {
          const serviceManager = candidate['serviceManager'] as Record<
            string,
            unknown
          >;
          serviceManager['statusCommand'] = ['systemctl'];
        }),
      ],
      [
        'service manager caveats',
        malformedManifest((candidate) => {
          const serviceManager = candidate['serviceManager'] as Record<
            string,
            unknown
          >;
          serviceManager['caveats'] = ['ok', 404];
        }),
      ],
    ];

    for (const [name, candidate] of malformedCases) {
      expect(isNodeManifest(candidate), name).toBe(false);
    }
  });

  it('exchanges a one-time pair token for a durable credential without storing raw secret material', () => {
    withTmpRegistry((registry) => {
      const pair = registry.createPairToken({ displayName: 'Dev Mac' });
      expect(pair.pairToken).toMatch(/^pair_/);
      expect(pair.expiresAt).toBe('2026-01-02T03:14:05.000Z');
      expect(pair).not.toHaveProperty('bootstrapCommand');

      const exchanged = registry.exchangePairToken({
        pairToken: pair.pairToken,
        manifest: manifest({ homeDir: '/Users/dev' }),
        displayName: 'Dev Mac',
      });

      expect(exchanged.credential).toMatchObject({
        protocol: 'relay-node-link',
        protocolVersion: '1.0',
        nodeId: exchanged.node.nodeId,
      });
      expect(exchanged.credential.token).toMatch(
        new RegExp(`^${exchanged.node.nodeId}\\.`)
      );
      expect(exchanged.node).toMatchObject({
        displayName: 'Dev Mac',
        hostname: 'test-host',
        homeDir: '/Users/dev',
        platform: 'darwin',
        relayVersion: '9.9.9',
        protocolVersion: '1.0',
        status: 'online',
        trust: {
          state: 'active',
          level: 'dev',
          tier: 'dev',
          warning: expect.stringContaining('blast radius'),
          policy: {
            policyVersion: '1.0',
            trustTier: 'dev',
            allowed: expect.arrayContaining([
              'session:create:terminal',
              'session:create:agent',
              'session:attach',
              'rpc:fs:read',
              'rpc:git:read',
            ]),
            requiresConfirmation: [],
          },
        },
        credentialState: 'active',
        version: {
          state: 'compatible',
          nodeProtocolVersion: '1.0',
          hubProtocolVersion: '1.0',
        },
        capabilities: {
          totals: { available: 6, degraded: 1, unavailable: 2, unknown: 0 },
          agents: { claude: 'available', codex: 'unavailable' },
        },
      });

      expect(() =>
        registry.exchangePairToken({
          pairToken: pair.pairToken,
          manifest: manifest(),
        })
      ).toThrow(/TOKEN_ALREADY_USED/);

      const persisted = fs.readFileSync(registry.storagePath, 'utf8');
      expect(persisted).not.toContain(pair.pairToken);
      expect(persisted).not.toContain(exchanged.credential.token);
      expect(persisted).not.toContain(
        exchanged.credential.token.split('.')[1]!
      );
      const parsed = JSON.parse(persisted) as {
        nodes: Array<{ acl?: { grants?: { allowed?: string[] } } }>;
      };
      expect(parsed.nodes[0]?.acl?.grants?.allowed).toEqual(
        expect.arrayContaining(['session:read', 'rpc:fs:read'])
      );
      for (const forbidden of [
        'rpc:fs:write',
        'rpc:fs:delete',
        'rpc:git:write',
        'pty:exec:arbitrary',
        'preview:port-forward',
      ]) {
        expect(parsed.nodes[0]?.acl?.grants?.allowed).not.toContain(forbidden);
      }
    });
  });

  it('persists paired nodes and authenticates durable node credentials after reload', () => {
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'relay-hub-node-registry-')
    );
    try {
      const storagePath = path.join(tmpDir, 'nodes.json');
      const registry = createHubNodeRegistry({
        storagePath,
        now: () => new Date('2026-01-02T03:04:05.000Z'),
      });
      const pair = registry.createPairToken({});
      const exchanged = registry.exchangePairToken({
        pairToken: pair.pairToken,
        manifest: manifest({ hostname: 'persisted-host' }),
      });

      const reloaded = createHubNodeRegistry({
        storagePath,
        now: () => new Date('2026-01-02T03:04:06.000Z'),
      });

      expect(
        reloaded.authenticateCredential(exchanged.credential.token)?.nodeId
      ).toBe(exchanged.node.nodeId);
      expect(reloaded.listNodes()[0]).toMatchObject({
        nodeId: exchanged.node.nodeId,
        hostname: 'persisted-host',
        status: 'online',
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('migrates legacy paired nodes to hub-owned default ACL before summaries are returned', () => {
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'relay-hub-node-registry-')
    );
    const storagePath = path.join(tmpDir, 'nodes.json');
    try {
      fs.writeFileSync(
        storagePath,
        JSON.stringify({
          schemaVersion: 1,
          pairTokens: [],
          nodes: [
            {
              nodeId: 'node_legacy',
              credentialId: 'cred_legacy',
              credentialHash: '0'.repeat(64),
              displayName: 'Legacy node',
              hostname: 'legacy-host',
              platform: 'darwin',
              arch: 'arm64',
              relayVersion: '0.1.0',
              protocolVersion: '1.0',
              capabilities: {
                totals: {
                  available: 0,
                  degraded: 0,
                  unavailable: 0,
                  unknown: 0,
                },
                agents: {},
                serviceManager: 'manual',
                wsl: false,
              },
              createdAt: '2026-01-01T00:00:00.000Z',
              pairedAt: '2026-01-01T00:00:00.000Z',
              lastSeenAt: '2026-01-01T00:00:00.000Z',
            },
            {
              nodeId: 'node_null_acl',
              credentialId: 'cred_null_acl',
              credentialHash: '1'.repeat(64),
              displayName: 'Null ACL node',
              hostname: 'null-acl-host',
              platform: 'darwin',
              arch: 'arm64',
              relayVersion: '0.1.0',
              protocolVersion: '1.0',
              capabilities: {
                totals: {
                  available: 0,
                  degraded: 0,
                  unavailable: 0,
                  unknown: 0,
                },
                agents: {},
                serviceManager: 'manual',
                wsl: false,
              },
              acl: null,
              createdAt: '2026-01-01T00:00:00.000Z',
              pairedAt: '2026-01-01T00:00:00.000Z',
              lastSeenAt: '2026-01-01T00:00:00.000Z',
            },
            {
              nodeId: 'node_drifted_acl',
              credentialId: 'cred_drifted_acl',
              credentialHash: '2'.repeat(64),
              displayName: 'Drifted ACL node',
              hostname: 'drifted-acl-host',
              platform: 'darwin',
              arch: 'arm64',
              relayVersion: '0.1.0',
              protocolVersion: '1.0',
              capabilities: {
                totals: {
                  available: 0,
                  degraded: 0,
                  unavailable: 0,
                  unknown: 0,
                },
                agents: {},
                serviceManager: 'manual',
                wsl: false,
              },
              acl: {
                schemaVersion: 1,
                policyVersion: '1.0',
                ref: 'acl:other-node:1.0',
                peer: {
                  kind: 'node',
                  nodeId: 'other-node',
                  credentialId: 'other-credential',
                },
                node: { nodeId: 'other-node', trustTier: 'dev' },
                grants: { allowed: ['session:read'], requiresConfirmation: [] },
                scope: { kind: 'node' },
                lifecycle: {
                  createdAt: '2026-01-01T00:00:00.000Z',
                  updatedAt: '2026-01-01T00:00:00.000Z',
                },
              },
              createdAt: '2026-01-01T00:00:00.000Z',
              pairedAt: '2026-01-01T00:00:00.000Z',
              lastSeenAt: '2026-01-01T00:00:00.000Z',
            },
          ],
        })
      );

      const registry = createHubNodeRegistry({
        storagePath,
        now: () => new Date('2026-01-02T03:04:05.000Z'),
      });
      const node = registry.listNodes()[0];

      expect(node?.trust).toMatchObject({
        state: 'active',
        level: 'dev',
        tier: 'dev',
        policy: {
          policyVersion: '1.0',
          ref: 'acl:node_legacy:1.0',
          trustTier: 'dev',
          allowed: expect.arrayContaining([
            'session:read',
            'session:create:terminal',
            'rpc:fs:read',
            'rpc:git:read',
          ]),
          requiresConfirmation: [],
        },
      });
      for (const forbidden of [
        'rpc:fs:write',
        'rpc:fs:delete',
        'rpc:git:write',
        'pty:exec:arbitrary',
        'preview:port-forward',
      ]) {
        expect(node?.trust.policy.allowed).not.toContain(forbidden);
      }

      const migrated = JSON.parse(fs.readFileSync(storagePath, 'utf8')) as {
        nodes: Array<{
          nodeId: string;
          credentialId: string;
          acl?: {
            peer?: { nodeId?: string; credentialId?: string };
            node?: { nodeId?: string };
          };
        }>;
      };
      for (const migratedNode of migrated.nodes) {
        expect(migratedNode.acl).toBeDefined();
        expect(migratedNode.acl?.peer?.nodeId).toBe(migratedNode.nodeId);
        expect(migratedNode.acl?.node?.nodeId).toBe(migratedNode.nodeId);
        expect(migratedNode.acl?.peer?.credentialId).toBe(
          migratedNode.credentialId
        );
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('keeps node manifest availability separate from hub ACL grants', () => {
    withTmpRegistry((registry) => {
      const exchanged = registry.exchangePairToken({
        pairToken: registry.createPairToken({}).pairToken,
        manifest: manifest(),
      });
      registry.recordHeartbeat({
        nodeId: exchanged.node.nodeId,
        protocolVersion: '1.0',
        manifest: manifest({
          capabilities: {
            ...manifest().capabilities,
            git: {
              id: 'git',
              label: 'Git',
              status: 'unavailable',
              message: 'not installed',
            },
          },
        }),
      });

      const node = registry.listNodes()[0];

      expect(node?.capabilities.core.git).toBe('unavailable');
      expect(node?.trust.policy.allowed).toEqual(
        expect.arrayContaining(['rpc:git:read'])
      );
      expect(node?.trust.policy.allowed).not.toContain('rpc:git:write');
    });
  });

  it('quarantines corrupt registry JSON and starts with empty replacement state', () => {
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'relay-hub-node-registry-')
    );
    const storagePath = path.join(tmpDir, 'nodes.json');
    const leakedSecret = 'pair_secret-from-corrupt-file';
    fs.writeFileSync(storagePath, `{ "pairTokens": ["${leakedSecret}"],`);

    try {
      const registry = createHubNodeRegistry({
        storagePath,
        now: () => new Date('2026-01-02T03:04:05.000Z'),
      });

      expect(registry.listNodes()).toEqual([]);
      expect(fs.existsSync(storagePath)).toBe(false);
      const quarantined = fs
        .readdirSync(tmpDir)
        .filter((name) => name.startsWith('nodes.json.corrupt-'));
      expect(quarantined).toHaveLength(1);

      registry.createPairToken({ displayName: 'replacement' });

      const persisted = fs.readFileSync(storagePath, 'utf8');
      const parsed = JSON.parse(persisted) as {
        pairTokens: unknown[];
        nodes: unknown[];
      };
      expect(parsed.pairTokens).toHaveLength(1);
      expect(parsed.nodes).toEqual([]);
      expect(persisted).not.toContain(leakedSecret);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('computes deterministic stale and offline states from heartbeat age', () => {
    const storagePath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'relay-hub-node-registry-')),
      'nodes.json'
    );
    let now = new Date('2026-01-02T03:04:05.000Z');
    try {
      const registry = createHubNodeRegistry({ storagePath, now: () => now });
      const exchanged = registry.exchangePairToken({
        pairToken: registry.createPairToken({}).pairToken,
        manifest: manifest(),
      });

      now = new Date(
        Date.parse(exchanged.node.lastSeenAt) +
          DEFAULT_NODE_HEARTBEAT_TIMEOUTS.staleMs +
          1
      );
      expect(registry.listNodes()[0]?.status).toBe('stale');

      now = new Date(
        Date.parse(exchanged.node.lastSeenAt) +
          DEFAULT_NODE_HEARTBEAT_TIMEOUTS.offlineMs +
          1
      );
      expect(registry.listNodes()[0]?.status).toBe('offline');

      registry.recordHeartbeat({
        nodeId: exchanged.node.nodeId,
        protocolVersion: '1.0',
        manifest: manifest({ relayVersion: '10.0.0' }),
      });

      expect(registry.listNodes()[0]).toMatchObject({
        status: 'online',
        relayVersion: '10.0.0',
      });
    } finally {
      fs.rmSync(path.dirname(storagePath), { recursive: true, force: true });
    }
  });

  it('debounces heartbeat persistence and flushes the latest node state deterministically', async () => {
    const storagePath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'relay-hub-node-registry-')),
      'nodes.json'
    );
    let now = new Date('2026-01-02T03:04:05.000Z');
    try {
      const registry = createHubNodeRegistry({
        storagePath,
        now: () => now,
        heartbeatPersistDebounceMs: 60_000,
      });
      const exchanged = registry.exchangePairToken({
        pairToken: registry.createPairToken({}).pairToken,
        manifest: manifest(),
      });
      const persistedBeforeHeartbeat = JSON.parse(
        fs.readFileSync(storagePath, 'utf8')
      ) as {
        nodes: Array<{ lastSeenAt: string; hostname: string }>;
      };

      now = new Date('2026-01-02T03:05:05.000Z');
      registry.recordHeartbeat({
        nodeId: exchanged.node.nodeId,
        protocolVersion: '1.0',
        manifest: manifest({
          hostname: 'heartbeat-host',
          relayVersion: '10.0.0',
        }),
      });

      const persistedImmediatelyAfterHeartbeat = JSON.parse(
        fs.readFileSync(storagePath, 'utf8')
      ) as {
        nodes: Array<{
          lastSeenAt: string;
          hostname: string;
          relayVersion: string;
        }>;
      };
      expect(persistedImmediatelyAfterHeartbeat.nodes[0]).toMatchObject({
        lastSeenAt: persistedBeforeHeartbeat.nodes[0]?.lastSeenAt,
        hostname: 'test-host',
        relayVersion: '9.9.9',
      });

      await registry.flushPendingHeartbeatPersist();

      const persistedAfterFlush = JSON.parse(
        fs.readFileSync(storagePath, 'utf8')
      ) as {
        nodes: Array<{
          lastSeenAt: string;
          hostname: string;
          relayVersion: string;
        }>;
      };
      expect(persistedAfterFlush.nodes[0]).toMatchObject({
        lastSeenAt: '2026-01-02T03:05:05.000Z',
        hostname: 'heartbeat-host',
        relayVersion: '10.0.0',
      });
    } finally {
      fs.rmSync(path.dirname(storagePath), { recursive: true, force: true });
    }
  });

  it('still throws heartbeat persistence failures to explicit flush callers', async () => {
    const tmpRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'relay-hub-node-registry-')
    );
    const storageDir = path.join(tmpRoot, 'registry-dir');
    const storagePath = path.join(storageDir, 'nodes.json');
    let now = new Date('2026-01-02T03:04:05.000Z');
    try {
      const registry = createHubNodeRegistry({
        storagePath,
        now: () => now,
        heartbeatPersistDebounceMs: 60_000,
      });
      const exchanged = registry.exchangePairToken({
        pairToken: registry.createPairToken({}).pairToken,
        manifest: manifest(),
      });

      fs.rmSync(storageDir, { recursive: true, force: true });
      fs.writeFileSync(storageDir, 'not a directory');
      now = new Date('2026-01-02T03:05:05.000Z');
      registry.recordHeartbeat({
        nodeId: exchanged.node.nodeId,
        protocolVersion: '1.0',
        manifest: manifest({
          hostname: 'heartbeat-host',
          relayVersion: '10.0.0',
        }),
      });

      await expect(registry.flushPendingHeartbeatPersist()).rejects.toThrow();
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('revokes node credentials with typed trust state and rejects later heartbeats', () => {
    withTmpRegistry((registry) => {
      const exchanged = registry.exchangePairToken({
        pairToken: registry.createPairToken({}).pairToken,
        manifest: manifest(),
      });

      const revoked = registry.revokeNode(exchanged.node.nodeId);

      expect(revoked).toMatchObject({
        nodeId: exchanged.node.nodeId,
        status: 'revoked',
        credentialState: 'revoked',
        trust: {
          state: 'revoked',
          level: 'dev',
          tier: 'dev',
          warning: expect.stringContaining('blast radius'),
        },
      });
      expect(registry.listNodes()[0]).toMatchObject({
        nodeId: exchanged.node.nodeId,
        status: 'revoked',
        credentialState: 'revoked',
      });
      expect(
        registry.authenticateCredential(exchanged.credential.token)
      ).toBeNull();
      expect(() =>
        registry.recordHeartbeat({
          nodeId: exchanged.node.nodeId,
          protocolVersion: '1.0',
          manifest: manifest(),
        })
      ).toThrow(/NODE_REVOKED/);
    });
  });

  it('isolates revoke listener exceptions and continues notifying later listeners', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      withTmpRegistry((registry) => {
        const exchanged = registry.exchangePairToken({
          pairToken: registry.createPairToken({}).pairToken,
          manifest: manifest(),
        });
        const notifiedNodeIds: string[] = [];

        registry.onNodeRevoked(() => {
          throw new Error('listener should not leak');
        });
        registry.onNodeRevoked((nodeId) => {
          notifiedNodeIds.push(nodeId);
        });

        expect(() => registry.revokeNode(exchanged.node.nodeId)).not.toThrow();

        expect(notifiedNodeIds).toEqual([exchanged.node.nodeId]);
        expect(registry.listNodes()[0]).toMatchObject({
          nodeId: exchanged.node.nodeId,
          status: 'revoked',
          credentialState: 'revoked',
        });
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining(
            '[hub-node-registry] hub node revoke listener failed; continuing revoke notifications for node %s'
          ),
          exchanged.node.nodeId
        );
      });
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('returns typed errors for expired tokens, bad credentials, and incompatible protocol versions', () => {
    withTmpRegistry((registry) => {
      const pair = registry.createPairToken({ ttlMs: 1 });
      registry.setNowForTest(() => new Date('2026-01-02T03:04:06.000Z'));
      expect(() =>
        registry.exchangePairToken({
          pairToken: pair.pairToken,
          manifest: manifest(),
        })
      ).toThrow(/TOKEN_EXPIRED/);

      registry.setNowForTest(() => new Date('2026-01-02T03:04:07.000Z'));
      expect(registry.authenticateCredential('node_missing.bad')).toBeNull();

      const minorSkew = registry.createPairToken({});
      expect(() =>
        registry.exchangePairToken({
          pairToken: minorSkew.pairToken,
          manifest: manifest(),
          protocolVersion: '1.1',
        })
      ).toThrow(/VERSION_SKEW/);

      const incompatible = registry.createPairToken({});
      expect(() =>
        registry.exchangePairToken({
          pairToken: incompatible.pairToken,
          manifest: manifest(),
          protocolVersion: '2.0',
        })
      ).toThrow(/PROTOCOL_INCOMPATIBLE/);
    });
  });

  it('rotates node credentials without invalidating the previous token until proof', () => {
    withTmpRegistry((registry) => {
      const exchanged = registry.exchangePairToken({
        pairToken: registry.createPairToken({}).pairToken,
        manifest: manifest(),
      });

      const rotation = registry.beginCredentialRotation(exchanged.node.nodeId);

      expect(rotation.node).toMatchObject({
        nodeId: exchanged.node.nodeId,
        credentialState: 'rotating',
        credentialId: exchanged.credential.credentialId,
        credentialRotation: {
          state: 'issuing',
          previousCredentialId: exchanged.credential.credentialId,
          nextCredentialId: rotation.credential.credentialId,
        },
      });
      expect(rotation.credential.token).not.toEqual(exchanged.credential.token);
      expect(
        registry.authenticateCredentialDetailed(exchanged.credential.token)
      ).toMatchObject({
        ok: true,
        credentialId: exchanged.credential.credentialId,
      });
      expect(
        registry.authenticateCredentialDetailed(rotation.credential.token)
      ).toMatchObject({
        ok: true,
        credentialId: rotation.credential.credentialId,
        rotationId: rotation.rotation.rotationId,
      });
      expect(() =>
        registry.beginCredentialRotation(exchanged.node.nodeId)
      ).toThrow(/ROTATION_IN_PROGRESS/);

      const delivered = registry.markCredentialRotationDelivered(
        exchanged.node.nodeId,
        rotation.rotation.rotationId
      );
      expect(delivered.rotation.state).toBe('delivered');

      const proved = registry.recordHeartbeat({
        nodeId: exchanged.node.nodeId,
        protocolVersion: '1.0',
        credentialId: rotation.credential.credentialId,
        manifest: manifest(),
      });

      expect(proved).toMatchObject({
        credentialId: rotation.credential.credentialId,
        credentialState: 'active',
        credentialRotation: {
          state: 'stable',
          previousCredentialId: exchanged.credential.credentialId,
          nextCredentialId: rotation.credential.credentialId,
        },
      });
      expect(registry.authenticateCredential(exchanged.credential.token)).toBeNull();
      expect(registry.authenticateCredential(rotation.credential.token)).toMatchObject({
        credentialId: rotation.credential.credentialId,
        credentialState: 'active',
      });
    });
  });

  it('clears failed credential rotations before allowing recovery attempts', () => {
    withTmpRegistry((registry) => {
      const exchanged = registry.exchangePairToken({
        pairToken: registry.createPairToken({}).pairToken,
        manifest: manifest(),
      });
      const rotation = registry.beginCredentialRotation(exchanged.node.nodeId);

      const failed = registry.failCredentialRotation(
        exchanged.node.nodeId,
        rotation.rotation.rotationId,
        'delivery failed'
      );

      expect(failed.node).toMatchObject({
        credentialState: 'rotation-failed',
        credentialRotation: {
          state: 'failed',
          failureReason: 'delivery failed',
        },
      });
      expect(() =>
        registry.beginCredentialRotation(exchanged.node.nodeId)
      ).toThrow(/ROTATION_IN_PROGRESS/);

      const cleared = registry.clearCredentialRotationFailure(exchanged.node.nodeId);

      expect(cleared).toMatchObject({
        credentialState: 'active',
        credentialId: exchanged.credential.credentialId,
      });
      expect(cleared.credentialRotation).toBeUndefined();
      expect(() =>
        registry.beginCredentialRotation(exchanged.node.nodeId)
      ).not.toThrow();
    });
  });

  it('clears a delivered rotation without invalidating the previous credential', () => {
    withTmpRegistry((registry) => {
      const exchanged = registry.exchangePairToken({
        pairToken: registry.createPairToken({}).pairToken,
        manifest: manifest(),
      });
      const rotation = registry.beginCredentialRotation(exchanged.node.nodeId);
      registry.markCredentialRotationDelivered(
        exchanged.node.nodeId,
        rotation.rotation.rotationId
      );

      expect(() =>
        registry.beginCredentialRotation(exchanged.node.nodeId)
      ).toThrow(/ROTATION_IN_PROGRESS/);

      const cleared = registry.clearCredentialRotationFailure(exchanged.node.nodeId);

      expect(cleared).toMatchObject({
        credentialState: 'active',
        credentialId: exchanged.credential.credentialId,
      });
      expect(cleared.credentialRotation).toBeUndefined();
      expect(registry.authenticateCredential(exchanged.credential.token)).toMatchObject({
        credentialId: exchanged.credential.credentialId,
        credentialState: 'active',
      });
      expect(registry.authenticateCredential(rotation.credential.token)).toBeNull();
      expect(() =>
        registry.beginCredentialRotation(exchanged.node.nodeId)
      ).not.toThrow();
    });
  });
});

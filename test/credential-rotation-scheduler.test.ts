import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  createHubNodeRegistry,
  type HubNodeRegistry,
} from '../server/hub-node-registry.js';
import {
  createCredentialRotationScheduler,
  type CredentialRotationNodeLinks,
} from '../server/credential-rotation-scheduler.js';
import type { SecurityAuditEntryInput } from '../shared/security-audit.js';
import type { NodeManifest } from '../shared/node-manifest.js';
import { buildManifestWithAgents } from './helpers/manifest-fixtures.js';

function manifest(overrides: Partial<NodeManifest> = {}): NodeManifest {
  return buildManifestWithAgents({
    agents: [{ id: 'claude', label: 'Claude', status: 'available' as const }],
    overrides,
  });
}

interface Harness {
  registry: HubNodeRegistry;
  audits: SecurityAuditEntryInput[];
  setNow: (now: Date) => void;
}

function withHarness(
  fn: (harness: Harness) => Promise<void> | void
): Promise<void> {
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'relay-credential-rotation-scheduler-')
  );
  let currentNow = new Date('2026-01-02T00:00:00.000Z');
  const audits: SecurityAuditEntryInput[] = [];
  const registry = createHubNodeRegistry({
    storagePath: path.join(tmpDir, 'nodes.json'),
    now: () => currentNow,
    auditSink: { append: (entry) => audits.push(entry) },
  });
  const setNow = (next: Date): void => {
    currentNow = next;
    registry.setNowForTest(() => currentNow);
  };
  return Promise.resolve(fn({ registry, audits, setNow })).finally(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
}

function fakeNodeLinks(connected: Set<string>): CredentialRotationNodeLinks & {
  calls: Array<{ nodeId: string; type: string; payload: unknown }>;
  rejectWith?: Error;
} {
  const calls: Array<{ nodeId: string; type: string; payload: unknown }> = [];
  return {
    calls,
    hasActiveNode(nodeId: string) {
      return connected.has(nodeId);
    },
    request(nodeId: string, type: string, payload: unknown) {
      calls.push({ nodeId, type, payload });
      if ((this as { rejectWith?: Error }).rejectWith) {
        return Promise.reject((this as { rejectWith?: Error }).rejectWith);
      }
      return Promise.resolve({ ok: true });
    },
  } as CredentialRotationNodeLinks & {
    calls: Array<{ nodeId: string; type: string; payload: unknown }>;
    rejectWith?: Error;
  };
}

describe('credential rotation scheduler', () => {
  it('refuses to start with a non-positive intervalMs', () => {
    const noopRegistry = {} as HubNodeRegistry;
    const noopLinks: CredentialRotationNodeLinks = {
      hasActiveNode: () => false,
      request: () => Promise.resolve(undefined),
    };
    expect(() =>
      createCredentialRotationScheduler({
        registry: noopRegistry,
        nodeLinks: noopLinks,
        intervalMs: 0,
      })
    ).toThrow(/intervalMs/);
  });

  it('rotates an aged credential for an online node and audits the decision', async () => {
    await withHarness(async ({ registry, audits, setNow }) => {
      const exchanged = registry.exchangePairToken({
        pairToken: registry.createPairToken({}).pairToken,
        manifest: manifest(),
      });
      const links = fakeNodeLinks(new Set([exchanged.node.nodeId]));
      const scheduler = createCredentialRotationScheduler({
        registry,
        nodeLinks: links,
        auditSink: { append: (entry) => audits.push(entry) },
        intervalMs: 60_000,
        checkIntervalMs: 1_000,
        now: () => new Date(),
      });

      // First tick: credential is fresh, nothing should happen.
      let result = await scheduler.runOnce();
      expect(result.triggered).toHaveLength(0);
      expect(result.skipped).toHaveLength(0);
      expect(links.calls).toHaveLength(0);

      // Age the credential past the interval.
      setNow(new Date('2026-01-02T00:02:00.000Z'));

      result = await scheduler.runOnce();
      expect(result.triggered).toHaveLength(1);
      expect(result.triggered[0]?.nodeId).toBe(exchanged.node.nodeId);
      expect(links.calls).toEqual([
        expect.objectContaining({
          nodeId: exchanged.node.nodeId,
          type: 'credential.rotate',
        }),
      ]);

      const reasonCodes = audits.map((entry) => entry.reasonCode);
      expect(reasonCodes).toContain('CREDENTIAL_ROTATION_SCHEDULED_TRIGGERED');
      expect(reasonCodes).toContain('CREDENTIAL_ROTATION_SCHEDULED_DELIVERED');

      const triggered = audits.find(
        (entry) =>
          entry.reasonCode === 'CREDENTIAL_ROTATION_SCHEDULED_TRIGGERED'
      );
      const params =
        (triggered?.material?.params as Record<string, unknown> | undefined) ??
        {};
      expect(params['trigger']).toBe('scheduled');
      expect(typeof params['rotationId']).toBe('string');
    });
  });

  it('skips offline nodes without throwing or starting a rotation', async () => {
    await withHarness(async ({ registry, audits, setNow }) => {
      const exchanged = registry.exchangePairToken({
        pairToken: registry.createPairToken({}).pairToken,
        manifest: manifest(),
      });
      const links = fakeNodeLinks(new Set()); // no connected nodes
      const scheduler = createCredentialRotationScheduler({
        registry,
        nodeLinks: links,
        auditSink: { append: (entry) => audits.push(entry) },
        intervalMs: 60_000,
        now: () => new Date(),
      });

      setNow(new Date('2026-01-02T00:02:00.000Z'));
      const result = await scheduler.runOnce();
      expect(result.triggered).toHaveLength(0);
      expect(result.skipped).toEqual([
        { nodeId: exchanged.node.nodeId, reasonCode: 'NODE_OFFLINE' },
      ]);
      expect(links.calls).toHaveLength(0);

      // Offline-node skips are intentionally silent in the audit log so a
      // long-offline node does not flood the audit DB once per tick.
      const offlineAudits = audits.filter(
        (entry) =>
          entry.reasonCode === 'CREDENTIAL_ROTATION_SCHEDULED_SKIPPED' &&
          (entry.material?.params as Record<string, unknown> | undefined)?.[
            'reason'
          ] === 'NODE_OFFLINE'
      );
      expect(offlineAudits).toHaveLength(0);
    });
  });

  it('skips nodes with an in-progress rotation', async () => {
    await withHarness(async ({ registry, audits, setNow }) => {
      const exchanged = registry.exchangePairToken({
        pairToken: registry.createPairToken({}).pairToken,
        manifest: manifest(),
      });
      // Begin a rotation outside the scheduler so the node has an
      // unresolved rotation when the scheduler ticks.
      registry.beginCredentialRotation(exchanged.node.nodeId);

      const links = fakeNodeLinks(new Set([exchanged.node.nodeId]));
      const scheduler = createCredentialRotationScheduler({
        registry,
        nodeLinks: links,
        auditSink: { append: (entry) => audits.push(entry) },
        intervalMs: 60_000,
        now: () => new Date(),
      });

      setNow(new Date('2026-01-02T00:02:00.000Z'));
      const result = await scheduler.runOnce();
      // The candidate filter should exclude rotating nodes, so nothing is
      // triggered and nothing is skipped at the scheduler level.
      expect(result.candidates).toBe(0);
      expect(result.triggered).toHaveLength(0);
      expect(result.skipped).toHaveLength(0);
      expect(links.calls).toHaveLength(0);
    });
  });

  it('marks the rotation failed and audits when delivery rejects', async () => {
    await withHarness(async ({ registry, audits, setNow }) => {
      const exchanged = registry.exchangePairToken({
        pairToken: registry.createPairToken({}).pairToken,
        manifest: manifest(),
      });
      const links = fakeNodeLinks(new Set([exchanged.node.nodeId]));
      (links as { rejectWith?: Error }).rejectWith = new Error(
        'delivery timeout'
      );
      const scheduler = createCredentialRotationScheduler({
        registry,
        nodeLinks: links,
        auditSink: { append: (entry) => audits.push(entry) },
        intervalMs: 60_000,
        now: () => new Date(),
      });

      setNow(new Date('2026-01-02T00:02:00.000Z'));
      const result = await scheduler.runOnce();
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0]?.reasonCode).toBe(
        'CREDENTIAL_ROTATION_SCHEDULED_FAILED'
      );

      const failed = audits.find(
        (entry) => entry.reasonCode === 'CREDENTIAL_ROTATION_SCHEDULED_FAILED'
      );
      expect(failed?.decision).toBe('failed');

      // The registry should reflect the failure so the next tick does not
      // try to rotate the same node again.
      const node = registry
        .listNodes()
        .find((n) => n.nodeId === exchanged.node.nodeId);
      expect(node?.credentialRotation?.state).toBe('failed');
    });
  });

  it('audits failure (not delivered) when markCredentialRotationDelivered throws', async () => {
    await withHarness(async ({ registry, audits, setNow }) => {
      const exchanged = registry.exchangePairToken({
        pairToken: registry.createPairToken({}).pairToken,
        manifest: manifest(),
      });
      const links = fakeNodeLinks(new Set([exchanged.node.nodeId]));
      vi.spyOn(registry, 'markCredentialRotationDelivered').mockImplementation(
        () => {
          throw new Error('persist failed');
        }
      );
      const scheduler = createCredentialRotationScheduler({
        registry,
        nodeLinks: links,
        auditSink: { append: (entry) => audits.push(entry) },
        intervalMs: 60_000,
        now: () => new Date(),
      });
      setNow(new Date('2026-01-02T00:02:00.000Z'));
      const result = await scheduler.runOnce();
      expect(result.failed).toHaveLength(1);
      const reasonCodes = audits.map((entry) => entry.reasonCode);
      expect(reasonCodes).toContain('CREDENTIAL_ROTATION_SCHEDULED_FAILED');
      expect(reasonCodes).not.toContain(
        'CREDENTIAL_ROTATION_SCHEDULED_DELIVERED'
      );
    });
  });

  it('does not re-enter while a previous tick is still running', async () => {
    await withHarness(async ({ registry, audits, setNow }) => {
      const exchanged = registry.exchangePairToken({
        pairToken: registry.createPairToken({}).pairToken,
        manifest: manifest(),
      });
      const connected = new Set([exchanged.node.nodeId]);
      let resolveDelivery!: () => void;
      const requestSpy = vi.fn(() => {
        return new Promise<unknown>((resolve) => {
          resolveDelivery = () => resolve({ ok: true });
        });
      });
      const links: CredentialRotationNodeLinks = {
        hasActiveNode: (nodeId) => connected.has(nodeId),
        request: requestSpy,
      };
      const scheduler = createCredentialRotationScheduler({
        registry,
        nodeLinks: links,
        auditSink: { append: (entry) => audits.push(entry) },
        intervalMs: 60_000,
        now: () => new Date(),
      });

      setNow(new Date('2026-01-02T00:02:00.000Z'));
      const first = scheduler.runOnce();
      const second = scheduler.runOnce();
      expect(first).toBe(second);
      resolveDelivery();
      await first;
      expect(requestSpy).toHaveBeenCalledTimes(1);
    });
  });
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  RELAY_AUTOMATION_RUN_RETIRE_ACTION,
  RelayAutomationRunFinalizerAdapter,
  registerRelayAutomationRunFinalizers,
} from '../server/automation-run-finalizers.js';
import {
  createAutomationRunStore,
  type AutomationRunStore,
} from '../server/automation-runs.js';

const tempRoots: string[] = [];

function makeStore(): AutomationRunStore {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'relay-automation-run-finalizers-')
  );
  tempRoots.push(root);
  return createAutomationRunStore({
    dbPath: path.join(root, 'automation-runs.db'),
    now: () => '2026-06-23T20:30:00.000Z',
  });
}

const registerInput = {
  id: 'automation-run:finalizer-1',
  name: 'release-slice-watchdog',
  kind: 'watchdog' as const,
  runId: 'dw-run-1',
  owner: { orchestrator: 'dynamic-workflows', actorId: 'workflow:31' },
  repoPath: '/repo/relay-ide',
  workContextId: 'wc:31',
  targets: [{ sessionId: 'relay-session-1' }],
  ttlSeconds: 300,
};

function context(
  automationRunId: string,
  action: string = RELAY_AUTOMATION_RUN_RETIRE_ACTION
) {
  return contextFromHandle({ automationRunId }, action);
}

function contextFromHandle(
  handle: Record<string, string>,
  action: string = RELAY_AUTOMATION_RUN_RETIRE_ACTION,
  args?: Record<string, string>
) {
  return {
    trigger: 'success',
    resource: {
      id: 'relay-run-resource',
      kind: 'relay.automation_run',
      handle,
    },
    finalizer: { id: 'retire-run', action, policy: 'required', args },
  };
}

afterEach(() => {
  for (const root of tempRoots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

describe('Relay automation-run Dynamic Workflows finalizer adapter', () => {
  it('retires an active automation run and returns bounded evidence', () => {
    const store = makeStore();
    try {
      const run = store.register(registerInput);
      const adapter = new RelayAutomationRunFinalizerAdapter({
        store,
        ownerOrchestrator: 'dynamic-workflows',
        retiredBy: 'ebi',
      });

      const result = adapter.retireAutomationRun(context(run.id));
      const after = store.get(run.id);

      expect(result.ok).toBe(true);
      expect(result.summary).toBe('Relay automation run retired');
      expect(after?.status).toBe('retired');
      expect(after?.cleanup).toMatchObject({
        state: 'retired',
        retiredBy: 'ebi',
      });
      expect(result.evidence?.[0]).toMatchObject({
        automationRunId: run.id,
        found: true,
        wasRetired: false,
        retired: true,
        cleanupStateAfter: 'retired',
        versionBefore: 1,
        versionAfter: 2,
        targetCount: 1,
      });
      expect(JSON.stringify(result)).not.toContain('relay-session-1');
      expect(JSON.stringify(result)).not.toContain('/repo/relay-ide');
    } finally {
      store.close();
    }
  });

  it('is idempotent for already-retired and absent automation runs', () => {
    const store = makeStore();
    try {
      const run = store.register(registerInput);
      const adapter = new RelayAutomationRunFinalizerAdapter({ store });

      const first = adapter.retireAutomationRun(context(run.id));
      const second = adapter.retireAutomationRun(context(run.id));
      const absent = adapter.retireAutomationRun(
        context('automation-run:missing')
      );

      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      expect(second.summary).toBe('Relay automation run already retired');
      expect(second.evidence?.[0]).toMatchObject({
        wasRetired: true,
        versionBefore: 2,
        versionAfter: 2,
      });
      expect(absent).toMatchObject({
        ok: true,
        summary: 'Relay automation run already absent',
        evidence: [{ found: false, statusAfter: 'absent' }],
      });
    } finally {
      store.close();
    }
  });

  it('resolves automation run ids from every documented handle and args source', () => {
    const variants = [
      {
        label: 'snake-handle',
        makeContext: (id: string) =>
          contextFromHandle({ automation_run_id: id }),
      },
      {
        label: 'id-handle',
        makeContext: (id: string) => contextFromHandle({ id }),
      },
      {
        label: 'camel-args',
        makeContext: (id: string) =>
          contextFromHandle({}, RELAY_AUTOMATION_RUN_RETIRE_ACTION, {
            automationRunId: id,
          }),
      },
      {
        label: 'snake-args',
        makeContext: (id: string) =>
          contextFromHandle({}, RELAY_AUTOMATION_RUN_RETIRE_ACTION, {
            automation_run_id: id,
          }),
      },
    ];

    for (const variant of variants) {
      const store = makeStore();
      try {
        const run = store.register({
          ...registerInput,
          id: `automation-run:${variant.label}`,
        });
        const adapter = new RelayAutomationRunFinalizerAdapter({ store });

        const result = adapter.retireAutomationRun(variant.makeContext(run.id));

        expect(result.ok, variant.label).toBe(true);
        expect(store.get(run.id)?.status, variant.label).toBe('retired');
      } finally {
        store.close();
      }
    }
  });

  it('fails closed for missing id, unsupported action, and owner mismatch', () => {
    const store = makeStore();
    try {
      const run = store.register(registerInput);
      const adapter = new RelayAutomationRunFinalizerAdapter({
        store,
        ownerOrchestrator: 'other',
      });

      const missing = adapter.retireAutomationRun({
        resource: { handle: {} },
        finalizer: {},
      });
      const unsupported = adapter.retireAutomationRun(
        context(run.id, 'ath.listener.retire')
      );
      const mismatch = adapter.retireAutomationRun(context(run.id));

      expect(missing.ok).toBe(false);
      expect(missing.error).toContain('requires an automation run id');
      expect(unsupported.ok).toBe(false);
      expect(unsupported.error).toContain('unsupported Relay finalizer action');
      expect(mismatch.ok).toBe(false);
      expect(mismatch.error).toContain('owner does not match');
      expect(store.get(run.id)?.status).toBe('active');
    } finally {
      store.close();
    }
  });

  it('registers with a Dynamic Workflows-style registry without importing Dynamic Workflows', () => {
    const store = makeStore();
    try {
      const run = store.register(registerInput);
      const calls: Array<{
        action: string;
        handler: (context: ReturnType<typeof context>) => unknown;
        replace?: boolean;
      }> = [];
      const registry = {
        register(
          action: string,
          handler: (context: ReturnType<typeof context>) => unknown,
          options?: { replace?: boolean }
        ) {
          calls.push({ action, handler, replace: options?.replace });
          return this;
        },
      };

      const returned = registerRelayAutomationRunFinalizers(registry, {
        store,
        replace: true,
      });
      const result = calls[0]?.handler(context(run.id)) as {
        ok: boolean;
        summary?: string;
      };

      expect(returned).toBe(registry);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.action).toBe(RELAY_AUTOMATION_RUN_RETIRE_ACTION);
      expect(calls[0]?.replace).toBe(true);
      expect(result.ok).toBe(true);
      expect(result.summary).toBe('Relay automation run retired');
    } finally {
      store.close();
    }
  });
});

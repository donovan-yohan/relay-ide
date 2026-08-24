import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ClaudeJsonlStateAdapter,
  CodexJsonlStateAdapter,
  PiStateAdapter,
  NativeSessionAdapterRegistry,
} from '../../../server/provider-state/index.js';

async function writeClaudeFixture(
  root: string
): Promise<{ sessionPath: string }> {
  const projectDir = path.join(root, 'projects', '-tmp-repo');
  await mkdir(projectDir, { recursive: true });
  const sessionPath = path.join(projectDir, 'claude-session-1.jsonl');
  const lines = [
    {
      type: 'summary',
      summary: 'Claude investigation',
      sessionId: 'claude-session-1',
      cwd: '/tmp/repo',
      timestamp: '2026-01-01T00:00:00.000Z',
    },
    {
      type: 'user',
      sessionId: 'claude-session-1',
      uuid: 'user-1',
      cwd: '/tmp/repo',
      timestamp: '2026-01-01T00:00:01.000Z',
      message: {
        role: 'user',
        content: 'investigate the setup token=abc123',
      },
    },
  ];
  await writeFile(
    sessionPath,
    `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`
  );
  return { sessionPath };
}

async function writeCodexFixture(
  root: string
): Promise<{ sessionPath: string }> {
  const sessionDir = path.join(root, 'rollout-2026-01-01T00-00-00');
  await mkdir(sessionDir, { recursive: true });
  const sessionPath = path.join(sessionDir, 'codex-session-1.jsonl');
  const lines = [
    {
      type: 'session.started',
      session_id: 'codex-session-1',
      cwd: '/tmp/repo',
      timestamp: '2026-01-01T00:00:00.000Z',
    },
    {
      type: 'user',
      session_id: 'codex-session-1',
      id: 'user-1',
      cwd: '/tmp/repo',
      timestamp: '2026-01-01T00:00:01.000Z',
      message: {
        role: 'user',
        content: 'codex investigation',
      },
    },
  ];
  await writeFile(
    sessionPath,
    `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`
  );
  return { sessionPath };
}

describe('NativeSessionAdapterRegistry', () => {
  it('aggregates sessions across providers with per-provider install status', async () => {
    const claudeRoot = await mkdtemp(
      path.join(tmpdir(), 'relay-registry-claude-')
    );
    const codexRoot = await mkdtemp(
      path.join(tmpdir(), 'relay-registry-codex-')
    );
    const piRoot = await mkdtemp(path.join(tmpdir(), 'relay-registry-pi-'));

    await writeClaudeFixture(claudeRoot);
    await writeCodexFixture(codexRoot);

    const registry = new NativeSessionAdapterRegistry();
    registry.register(new ClaudeJsonlStateAdapter({ stateRoot: claudeRoot }));
    registry.register(new CodexJsonlStateAdapter({ stateRoot: codexRoot }));
    registry.register(new PiStateAdapter({ stateRoot: piRoot }));

    const report = await registry.listAllSessions();

    expect(report.sessions).toHaveLength(2);
    expect(report.sessions.map((s) => s.provider).sort()).toEqual([
      'claude',
      'codex',
    ]);

    expect(report.providers).toHaveLength(3);
    const providerStatuses = Object.fromEntries(
      report.providers.map((p) => [p.provider, p.status])
    );
    expect(providerStatuses['claude']).toBe('installed');
    expect(providerStatuses['codex']).toBe('installed');
    expect(providerStatuses['pi']).toBe('unsupported');
  });

  it('filters by provider when scope.provider is set', async () => {
    const claudeRoot = await mkdtemp(
      path.join(tmpdir(), 'relay-registry-filter-claude-')
    );
    const codexRoot = await mkdtemp(
      path.join(tmpdir(), 'relay-registry-filter-codex-')
    );
    const piRoot = await mkdtemp(
      path.join(tmpdir(), 'relay-registry-filter-pi-')
    );

    await writeClaudeFixture(claudeRoot);
    await writeCodexFixture(codexRoot);

    const registry = new NativeSessionAdapterRegistry();
    registry.register(new ClaudeJsonlStateAdapter({ stateRoot: claudeRoot }));
    registry.register(new CodexJsonlStateAdapter({ stateRoot: codexRoot }));
    registry.register(new PiStateAdapter({ stateRoot: piRoot }));

    const report = await registry.listAllSessions({ provider: 'claude' });

    expect(report.sessions).toHaveLength(1);
    expect(report.sessions[0]?.provider).toBe('claude');
  });

  it('degrades gracefully when a provider is unavailable', async () => {
    const claudeRoot = await mkdtemp(
      path.join(tmpdir(), 'relay-registry-degrade-claude-')
    );
    await writeClaudeFixture(claudeRoot);

    const registry = new NativeSessionAdapterRegistry();
    registry.register(new ClaudeJsonlStateAdapter({ stateRoot: claudeRoot }));
    registry.register(
      new CodexJsonlStateAdapter({
        stateRoot: '/nonexistent/codex/path',
      })
    );
    registry.register(new PiStateAdapter({ stateRoot: '/nonexistent/pi/path' }));

    const report = await registry.listAllSessions();

    expect(report.sessions).toHaveLength(1);
    expect(report.sessions[0]?.provider).toBe('claude');

    const codexStatus = report.providers.find((p) => p.provider === 'codex');
    expect(codexStatus?.status).toBe('unavailable');

    const piStatus = report.providers.find((p) => p.provider === 'pi');
    expect(piStatus?.status).toBe('unavailable');
  });

  it('throws when no adapter is registered for a provider', () => {
    const registry = new NativeSessionAdapterRegistry();
    expect(() =>
      registry.resumeCommand({ provider: 'claude', nativeId: 'x' })
    ).toThrow(/adapter registered/);
  });

  it('prevents duplicate adapter registration', () => {
    const registry = new NativeSessionAdapterRegistry();
    registry.register(new PiStateAdapter({ stateRoot: '/tmp/pi' }));
    expect(() =>
      registry.register(new PiStateAdapter({ stateRoot: '/tmp/pi2' }))
    ).toThrow(/already registered/);
  });
});
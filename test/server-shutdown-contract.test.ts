import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const serverSource = readFileSync(
  new URL('../server/index.ts', import.meta.url),
  'utf8'
);

describe('server shutdown store closing contract', () => {
  it('closes the WorkContext artifact store during normal graceful shutdown', () => {
    const gracefulShutdownStart = serverSource.indexOf(
      'async function gracefulShutdown()'
    );
    const signalHandlerStart = serverSource.indexOf(
      "process.on('SIGTERM', gracefulShutdown)",
      gracefulShutdownStart
    );
    const gracefulShutdownSource = serverSource.slice(
      gracefulShutdownStart,
      signalHandlerStart
    );

    expect(gracefulShutdownStart).toBeGreaterThanOrEqual(0);
    expect(signalHandlerStart).toBeGreaterThan(gracefulShutdownStart);
    expect(gracefulShutdownSource).toContain(
      'workContextArtifactStore?.close();'
    );
    expect(gracefulShutdownSource).toContain(
      'workContextMessageStore?.close();'
    );
    expect(gracefulShutdownSource).toContain('agentPresenceStore?.close();');
    expect(gracefulShutdownSource).toContain('workspaceSurfaceStore?.close();');
    expect(gracefulShutdownSource).toMatch(
      /contextPacketStore\?\.close\(\);\s+agentPresenceStore\?\.close\(\);\s+workContextArtifactStore\?\.close\(\);\s+workflowRunStore\?\.close\(\);\s+automationRunStore\?\.close\(\);\s+workspaceSurfaceStore\?\.close\(\);\s+workspaceTopicStore\?\.close\(\);\s+prOverseerStore\?\.close\(\);\s+workContextMessageStore\?\.close\(\);\s+closeInterventionLog\(\);/
    );
  });

  it('keeps the existing update-restart artifact store close path', () => {
    const updateRestartStart = serverSource.indexOf('if (restarting) {');
    const updateResponseStart = serverSource.indexOf(
      'res.json({ ok: true, restarting });'
    );
    const updateRestartSource = serverSource.slice(
      updateRestartStart,
      updateResponseStart
    );

    expect(updateRestartStart).toBeGreaterThanOrEqual(0);
    expect(updateResponseStart).toBeGreaterThan(updateRestartStart);
    expect(updateRestartSource).toContain('agentPresenceStore?.close();');
    expect(updateRestartSource).toContain('workContextArtifactStore?.close();');
    expect(updateRestartSource).toContain('workContextMessageStore?.close();');
    expect(updateRestartSource).toContain('workspaceSurfaceStore?.close();');
    expect(updateRestartSource).toMatch(
      /contextPacketStore\?\.close\(\);\s+agentPresenceStore\?\.close\(\);\s+workContextArtifactStore\?\.close\(\);\s+workflowRunStore\?\.close\(\);\s+automationRunStore\?\.close\(\);\s+workspaceSurfaceStore\?\.close\(\);\s+workspaceTopicStore\?\.close\(\);\s+prOverseerStore\?\.close\(\);\s+workContextMessageStore\?\.close\(\);/
    );
  });
});

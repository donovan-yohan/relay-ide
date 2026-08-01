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
    expect(gracefulShutdownSource).toContain('agentProfileStore?.close();');
    expect(gracefulShutdownSource).toContain('workspaceSurfaceStore?.close();');
    expect(gracefulShutdownSource).toContain(
      'channelAttachmentStore?.close();'
    );
    expect(gracefulShutdownSource).toMatch(
      /contextPacketStore\?\.close\(\);\s+agentProfileStore\?\.close\(\);\s+workContextArtifactStore\?\.close\(\);\s+workflowRunStore\?\.close\(\);\s+automationRunStore\?\.close\(\);\s+workspaceSurfaceStore\?\.close\(\);\s+workspaceTopicStore\?\.close\(\);\s+prOverseerStore\?\.close\(\);\s+workContextMessageStore\?\.close\(\);\s+channelAgentBinder\?\.close\(\);\s+await channelAgentRuntimes\.close\(\);\s+channelHub\.close\(\);\s+channelMessageStore\?\.close\(\);\s+channelAttachmentStore\?\.close\(\);\s+closeInterventionLog\(\);/
    );
  });

  it('keeps the existing update-restart artifact store close path', () => {
    // First `if (restarting)` is the store-close branch; the second one below
    // the response only schedules the exit.
    const updateRestartStart = serverSource.indexOf('if (restarting) {');
    // Bound the slice on the shape of the /update response, not on its fields:
    // the payload keeps growing (#1285 added supervision + bootId) while the
    // store-close sequence inside the restart branch is what this test pins.
    const updateResponseStart = serverSource.indexOf(
      'res.json({',
      updateRestartStart
    );
    const updateRestartSource = serverSource.slice(
      updateRestartStart,
      updateResponseStart
    );

    expect(updateRestartStart).toBeGreaterThanOrEqual(0);
    expect(updateResponseStart).toBeGreaterThan(updateRestartStart);
    // Guard the anchor: it must be the /update success response, not some
    // other `res.json({` that drifted into the restart branch.
    expect(
      serverSource.slice(updateResponseStart, updateResponseStart + 200)
    ).toContain('restarting,');
    expect(updateRestartSource).toContain('agentProfileStore?.close();');
    expect(updateRestartSource).toContain('workContextArtifactStore?.close();');
    expect(updateRestartSource).toContain('workContextMessageStore?.close();');
    expect(updateRestartSource).toContain('workspaceSurfaceStore?.close();');
    expect(updateRestartSource).toContain('channelAttachmentStore?.close();');
    expect(updateRestartSource).toMatch(
      /contextPacketStore\?\.close\(\);\s+agentProfileStore\?\.close\(\);\s+workContextArtifactStore\?\.close\(\);\s+workflowRunStore\?\.close\(\);\s+automationRunStore\?\.close\(\);\s+workspaceSurfaceStore\?\.close\(\);\s+workspaceTopicStore\?\.close\(\);\s+prOverseerStore\?\.close\(\);\s+workContextMessageStore\?\.close\(\);\s+channelAgentBinder\?\.close\(\);\s+await channelAgentRuntimes\.close\(\);\s+channelHub\.close\(\);\s+channelMessageStore\?\.close\(\);\s+channelAttachmentStore\?\.close\(\);/
    );
  });
});

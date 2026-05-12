import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

describe('relay-node bootstrap docs', () => {
  it('keeps macOS launchd diagnostics aligned with the service label and CLI log hint', () => {
    const cliSource = readRepoFile('bin/relay-ide.ts');
    const docs = readRepoFile('docs/RELAY_NODE_BOOTSTRAP.md');
    const serviceSource = readRepoFile('server/service.ts');
    const serviceLabelMatch = serviceSource.match(/\bSERVICE_LABEL\s*=\s*['"]([^'"]+)['"]/);
    expect(serviceLabelMatch).not.toBeNull();
    const serviceLabel = serviceLabelMatch![1];

    expect(serviceLabel).toBe('com.relay-ide');

    const launchdLogHint = `launchctl print gui/$(id -u)/${serviceLabel}`;
    expect(cliSource).toContain(launchdLogHint);
    expect(docs).toContain(launchdLogHint);
    expect(docs).not.toContain(`${serviceLabel}.node`);
  });

  it('keeps node install docs and CLI diagnostics honest about reverse-link lifecycle', () => {
    const cliSource = readRepoFile('bin/relay-ide.ts');
    const docs = readRepoFile('docs/RELAY_NODE_BOOTSTRAP.md');

    expect(docs).toContain('do **not** start or maintain the reverse WebSocket link `/hub/node-link`');
    expect(cliSource).toContain('does not start or maintain /hub/node-link');
    expect(docs).not.toMatch(/node install[^\n]+establishes steady-state/i);
    expect(docs).not.toMatch(/install\/start creates steady-state/i);
  });
});
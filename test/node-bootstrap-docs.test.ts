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
  it('keeps macOS launchd diagnostics aligned with local CLI log behavior', () => {
    const cliSource = readRepoFile('bin/relay-ide.ts');
    const docs = readRepoFile('docs/RELAY_NODE_BOOTSTRAP.md');
    const serviceSource = readRepoFile('server/service.ts');
    const serviceLabelMatch = serviceSource.match(
      /\bSERVICE_LABEL\s*=\s*['"]([^'"]+)['"]/
    );
    expect(serviceLabelMatch).not.toBeNull();
    const serviceLabel = serviceLabelMatch![1];

    expect(serviceLabel).toBe('com.relay-ide');
    expect(cliSource).toContain('logs [--lines <n>] [--follow]');
    expect(cliSource).toContain('readLocalLogSnapshot');
    expect(docs).not.toContain(`${serviceLabel}.node`);
  });

  it('keeps node install docs and CLI diagnostics honest about reverse-link lifecycle', () => {
    const cliSource = readRepoFile('bin/relay-ide.ts');
    const docs = readRepoFile('docs/RELAY_NODE_BOOTSTRAP.md');

    expect(docs).toContain(
      'Bootstrap commands (`node pair`, `node install`) themselves do not open or maintain `/hub/node-link`'
    );
    expect(docs).toContain('relay-ide node link --hub');
    expect(cliSource).toContain('does not start or maintain /hub/node-link');
    expect(docs).not.toMatch(/node install[^\n]+establishes steady-state/i);
    expect(docs).not.toMatch(/install\/start creates steady-state/i);
  });

  it('documents WSL support as simulated and keeps real-host validation open', () => {
    const bootstrapDocs = readRepoFile('docs/RELAY_NODE_BOOTSTRAP.md');
    const wslDocs = readRepoFile('docs/WSL2_RELAY_NODE_SUPPORT.md');
    const joined = `${bootstrapDocs}\n${wslDocs}`;

    expect(joined).toContain('tier-1.5');
    expect(joined).toContain('simulated diagnostics/manifest coverage');
    expect(joined).toContain('#378 must remain open');
    expect(joined).toContain(
      'Native Windows relay-node support remains out of scope'
    );
    expect(wslDocs).toContain('Real WSL2 host smoke');
    expect(wslDocs).toContain('Blocked');
    expect(joined).toContain('real-host validation is pending (#378)');
  });

  it('keeps the WSL manifest example valid JSON with escaped UNC paths', () => {
    const wslDocs = readRepoFile('docs/WSL2_RELAY_NODE_SUPPORT.md');
    const manifestJsonMatch = wslDocs.match(/```json\n([\s\S]*?)\n```/);

    expect(manifestJsonMatch).not.toBeNull();
    const manifest = JSON.parse(manifestJsonMatch?.[1] ?? '{}') as {
      windowsPath?: string;
    };

    expect(manifest.windowsPath).toBe(
      '\\\\wsl.localhost\\Ubuntu\\mnt\\c\\Users\\dev\\relay-ide'
    );
  });
});

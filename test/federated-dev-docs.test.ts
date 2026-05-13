import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

function read(rel: string): string {
  return fs.readFileSync(path.join(repoRoot, rel), 'utf8');
}

describe('federated dev workflow surfaces', () => {
  it('docs/FEDERATED_DEV.md exists and references the path-C synced checkout flow', () => {
    const doc = read('docs/FEDERATED_DEV.md');
    expect(doc).toContain('synced git checkout per machine');
    expect(doc).toContain('scripts/dev-resync.sh');
    expect(doc).toContain('npm run dev:node');
    expect(doc).toMatch(/There is no\s+`@dev` tag/);
    expect(doc).toMatch(/intentionally no\s+`@dev`/);
    expect(doc).toContain('(source <short-sha>)');
    expect(doc).toContain('PROTOCOL_INCOMPATIBLE');
  });

  it('doc map indexes the new doc from AGENTS.md / CLAUDE.md', () => {
    const map = read('AGENTS.md');
    expect(map).toContain('docs/FEDERATED_DEV.md');
    expect(map).toContain('Federated dev');
  });

  it('package.json declares dev:node script', () => {
    const pkg = JSON.parse(read('package.json')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['dev:node']).toBeDefined();
    expect(pkg.scripts['dev:node']).toContain('node link');
  });

  it('scripts/dev-resync.sh is committed and executable shape', () => {
    const script = read('scripts/dev-resync.sh');
    expect(script.startsWith('#!/usr/bin/env bash')).toBe(true);
    expect(script).toContain('git pull --ff-only');
    expect(script).toContain('npm ci');
    expect(script).toContain('npm run build');
    expect(script).toContain('npm link --force');
  });
});

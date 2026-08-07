import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

function readRepoFile(rel: string): string {
  return fs.readFileSync(path.join(repoRoot, rel), 'utf8');
}

describe('committed ADRs', () => {
  it('ADR-015 (core primitives domain-agnostic) is committed and indexed', () => {
    const adr = readRepoFile('docs/adrs/ADR-015-core-primitives-domain-agnostic.md');
    expect(adr).toMatch(/^# ADR-015:/m);
    expect(adr).toContain('Status:** Accepted');
    expect(adr).toContain('domain-agnostic');
    expect(adr).toContain('feature layer');
    expect(adr).toContain('hub-node-link.ts');

    const arch = readRepoFile('docs/ARCHITECTURE.md');
    expect(arch).toContain('ADR-015-core-primitives-domain-agnostic.md');
  });

  it('ADR-016 (node-to-node isolation invariant) is committed and indexed', () => {
    const adr = readRepoFile('docs/adrs/ADR-016-node-to-node-isolation.md');
    expect(adr).toMatch(/^# ADR-016:/m);
    expect(adr).toContain('Status:** Accepted');
    expect(adr).toContain('inter-node traffic flows through the hub');
    expect(adr).toContain('never proxies a request from node A');

    const arch = readRepoFile('docs/ARCHITECTURE.md');
    expect(arch).toContain('ADR-016-node-to-node-isolation.md');
  });

  it('ARCHITECTURE.md drops the "never committed" disclaimer once ADR files land', () => {
    const arch = readRepoFile('docs/ARCHITECTURE.md');
    expect(arch).not.toContain('were never committed to the repository');
  });
});

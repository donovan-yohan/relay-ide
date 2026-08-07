import { describe, expect, it } from 'vitest';
import {
  shikiLazyChunkViolation,
  type ShikiChunkGraphNode,
} from '../frontend/src/lib/shiki-lazy-chunk-gate.js';

const SHIKI_MODULE = '/repo/node_modules/shiki/dist/index.mjs';

function chunk(
  fileName: string,
  overrides: Partial<ShikiChunkGraphNode> = {}
): ShikiChunkGraphNode {
  return {
    fileName,
    isEntry: false,
    imports: [],
    dynamicImports: [],
    moduleIds: [`/repo/frontend/${fileName}.ts`],
    ...overrides,
  };
}

describe('frontend Shiki lazy-chunk build gate', () => {
  it('rejects Shiki hidden behind transitive static imports from an entry', () => {
    const violation = shikiLazyChunkViolation([
      chunk('entry.js', { isEntry: true, imports: ['shared.js'] }),
      chunk('shared.js', { imports: ['syntax.js'] }),
      chunk('syntax.js', { moduleIds: [SHIKI_MODULE] }),
    ]);

    expect(violation).toContain('entry static graph includes');
  });

  it('accepts Shiki reached only after a dynamic-import edge', () => {
    const violation = shikiLazyChunkViolation([
      chunk('entry.js', {
        isEntry: true,
        dynamicImports: ['syntax-loader.js'],
      }),
      chunk('syntax-loader.js', { imports: ['syntax.js'] }),
      chunk('syntax.js', { moduleIds: [SHIKI_MODULE] }),
    ]);

    expect(violation).toBeNull();
  });

  it('rejects an emitted Shiki chunk outside every entry dynamic graph', () => {
    const violation = shikiLazyChunkViolation([
      chunk('entry.js', { isEntry: true }),
      chunk('orphan-syntax.js', { moduleIds: [SHIKI_MODULE] }),
    ]);

    expect(violation).toContain('not reachable through a dynamic import');
  });
});

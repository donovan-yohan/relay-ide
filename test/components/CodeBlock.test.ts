import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── DJB2 hash — mirrors the inline implementation in CodeBlock.tsx ─────────────
function djb2Hash(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
    hash = hash >>> 0;
  }
  return hash.toString(16);
}

describe('djb2Hash (collision resistance)', () => {
  it('produces different hashes for inputs that share the first 64 characters', () => {
    // Two import headers that differ only after character 64.
    const prefix =
      'import React from "react";\nimport { useState } from "react";\n// ';
    const codeA = prefix + 'moduleA specific content';
    const codeB = prefix + 'moduleB specific content';
    expect(prefix.length).toBeGreaterThanOrEqual(64);

    const hashA = djb2Hash('typescript:' + codeA);
    const hashB = djb2Hash('typescript:' + codeB);
    expect(hashA).not.toBe(hashB);
  });

  it('returns the same hash for identical inputs (deterministic)', () => {
    const input = 'typescript:const x = 1;';
    expect(djb2Hash(input)).toBe(djb2Hash(input));
  });

  it('returns different hashes for the same code in different languages', () => {
    const code = 'const x = 1;';
    expect(djb2Hash('typescript:' + code)).not.toBe(
      djb2Hash('javascript:' + code)
    );
  });

  it('produces no collisions in a sample of 100 distinct strings', () => {
    const hashes = new Set<string>();
    for (let i = 0; i < 100; i++) {
      hashes.add(djb2Hash(`typescript:const x_${i} = ${i};`));
    }
    expect(hashes.size).toBe(100);
  });
});

describe('CodeBlock', () => {
  const projectRoot = join(__dirname, '../..');
  const componentPath = join(
    projectRoot,
    'frontend/src/components/CodeBlock.tsx'
  );
  const cssPath = join(projectRoot, 'frontend/src/components/CodeBlock.css');

  it('CodeBlock.tsx file exists', () => {
    expect(existsSync(componentPath)).toBeTruthy();
  });

  it('CodeBlock.css file exists', () => {
    expect(existsSync(cssPath)).toBeTruthy();
  });

  it('exports CodeBlock component', () => {
    const content = readFileSync(componentPath, 'utf-8');
    expect(content).toContain('export function CodeBlock');
    expect(content).toContain('export default CodeBlock');
  });

  it('exports CodeBlockProps interface', () => {
    const content = readFileSync(componentPath, 'utf-8');
    expect(content).toContain('interface CodeBlockProps');
  });

  it('has required props', () => {
    const content = readFileSync(componentPath, 'utf-8');
    expect(content).toContain('code: string');
    expect(content).toContain('language?:');
    expect(content).toContain('showLineNumbers?:');
    expect(content).toContain('startLine?:');
  });

  it('imports useShikiHighlight for GC-aware caching', () => {
    const content = readFileSync(componentPath, 'utf-8');
    expect(content).toContain("from '../hooks/useShikiHighlight.js'");
    expect(content).toContain('useShikiHighlight');
  });

  it('imports CSS', () => {
    const content = readFileSync(componentPath, 'utf-8');
    expect(content).toContain("import './CodeBlock.css'");
  });

  it('accepts a cacheKey prop for GC tracking', () => {
    const content = readFileSync(componentPath, 'utf-8');
    expect(content).toContain('cacheKey?:');
  });

  it('uses a full-content hash for the default cacheKey (not a 64-char prefix)', () => {
    const content = readFileSync(componentPath, 'utf-8');
    // The old collision-prone default was code.slice(0, 64).
    // Ensure the new implementation uses a hash function instead.
    expect(content).not.toContain('code.slice(0, 64)');
    expect(content).toContain('djb2Hash');
  });

  it('CSS has required classes', () => {
    const content = readFileSync(cssPath, 'utf-8');
    expect(content).toContain('.code-block');
    expect(content).toContain('.line');
    expect(content).toContain('.line-number');
    expect(content).toContain('.fallback');
    expect(content).toContain('.loading');
  });

  it('CSS uses CSS variables for theming', () => {
    const content = readFileSync(cssPath, 'utf-8');
    expect(content).toContain('var(--font-mono');
    expect(content).toContain('var(--font-size-xs');
    expect(content).toContain('var(--text');
  });
});

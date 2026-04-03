import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe('CodeBlock', () => {
  const projectRoot = join(__dirname, '../../..');
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

  it('imports tokenizeCode from shiki', () => {
    const content = readFileSync(componentPath, 'utf-8');
    expect(content).toContain("from '../lib/shiki.js'");
    expect(content).toContain('tokenizeCode');
  });

  it('imports CSS', () => {
    const content = readFileSync(componentPath, 'utf-8');
    expect(content).toContain("import './CodeBlock.css'");
  });

  it('uses React hooks', () => {
    const content = readFileSync(componentPath, 'utf-8');
    expect(content).toContain('useState');
    expect(content).toContain('useEffect');
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

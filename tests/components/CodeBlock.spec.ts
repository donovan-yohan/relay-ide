import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe('CodeBlock', () => {
  const projectRoot = join(__dirname, '../../..');
  const componentPath = join(projectRoot, 'frontend/src/components/CodeBlock.tsx');
  const cssPath = join(projectRoot, 'frontend/src/components/CodeBlock.css');

  it('CodeBlock.tsx file exists', () => {
    assert.ok(existsSync(componentPath), 'CodeBlock.tsx should exist');
  });

  it('CodeBlock.css file exists', () => {
    assert.ok(existsSync(cssPath), 'CodeBlock.css should exist');
  });

  it('exports CodeBlock component', () => {
    const content = readFileSync(componentPath, 'utf-8');
    assert.ok(
      content.includes('export function CodeBlock'),
      'Should export CodeBlock function'
    );
    assert.ok(
      content.includes('export default CodeBlock'),
      'Should have default export'
    );
  });

  it('exports CodeBlockProps interface', () => {
    const content = readFileSync(componentPath, 'utf-8');
    assert.ok(
      content.includes('interface CodeBlockProps'),
      'Should define CodeBlockProps interface'
    );
  });

  it('has required props', () => {
    const content = readFileSync(componentPath, 'utf-8');
    assert.ok(content.includes('code: string'), 'Should have code prop');
    assert.ok(content.includes('language?:'), 'Should have optional language prop');
    assert.ok(
      content.includes('showLineNumbers?:'),
      'Should have optional showLineNumbers prop'
    );
    assert.ok(
      content.includes('startLine?:'),
      'Should have optional startLine prop'
    );
  });

  it('imports tokenizeCode from shiki', () => {
    const content = readFileSync(componentPath, 'utf-8');
    assert.ok(
      content.includes("from '../lib/shiki.js'"),
      'Should import from shiki.js'
    );
    assert.ok(
      content.includes('tokenizeCode'),
      'Should import tokenizeCode'
    );
  });

  it('imports CSS', () => {
    const content = readFileSync(componentPath, 'utf-8');
    assert.ok(
      content.includes("import './CodeBlock.css'"),
      'Should import CodeBlock.css'
    );
  });

  it('uses React hooks', () => {
    const content = readFileSync(componentPath, 'utf-8');
    assert.ok(content.includes('useState'), 'Should use useState');
    assert.ok(content.includes('useEffect'), 'Should use useEffect');
  });

  it('CSS has required classes', () => {
    const content = readFileSync(cssPath, 'utf-8');
    assert.ok(content.includes('.code-block'), 'Should have .code-block class');
    assert.ok(content.includes('.line'), 'Should have .line class');
    assert.ok(
      content.includes('.line-number'),
      'Should have .line-number class'
    );
    assert.ok(content.includes('.fallback'), 'Should have .fallback class');
    assert.ok(content.includes('.loading'), 'Should have .loading class');
  });

  it('CSS uses CSS variables for theming', () => {
    const content = readFileSync(cssPath, 'utf-8');
    assert.ok(
      content.includes('var(--font-mono'),
      'Should use --font-mono CSS variable'
    );
    assert.ok(
      content.includes('var(--font-size-xs'),
      'Should use --font-size-xs CSS variable'
    );
    assert.ok(
      content.includes('var(--text'),
      'Should use --text CSS variable'
    );
  });
});
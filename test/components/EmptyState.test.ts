import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '../..');
const componentPath = join(
  projectRoot,
  'frontend/src/components/EmptyState.tsx'
);
const cssPath = join(projectRoot, 'frontend/src/components/EmptyState.css');

describe('EmptyState', () => {
  const tsxSource = readFileSync(componentPath, 'utf-8');
  const cssSource = readFileSync(cssPath, 'utf-8');

  it('EmptyState.tsx file exists', () => {
    expect(existsSync(componentPath)).toBeTruthy();
  });

  it('EmptyState.css file exists', () => {
    expect(existsSync(cssPath)).toBeTruthy();
  });

  it('exports EmptyState component', () => {
    expect(tsxSource).toContain('export function EmptyState');
    expect(tsxSource).toContain('export default EmptyState');
  });

  it('exports EmptyStateProps interface', () => {
    expect(tsxSource).toContain('interface EmptyStateProps');
  });

  it('has required props', () => {
    expect(tsxSource).toContain('heading: string');
    expect(tsxSource).toContain('icon?:');
    expect(tsxSource).toContain('description?:');
    expect(tsxSource).toContain('actionLabel?:');
    expect(tsxSource).toContain('onAction?:');
  });

  it('imports TuiButton', () => {
    expect(tsxSource).toContain("from './TuiButton'");
  });

  it('imports CSS', () => {
    expect(tsxSource).toContain("import './EmptyState.css'");
  });

  it('CSS has required classes', () => {
    expect(cssSource).toContain('.empty-state');
    expect(cssSource).toContain('.empty-icon');
    expect(cssSource).toContain('.empty-heading');
    expect(cssSource).toContain('.empty-description');
  });
});

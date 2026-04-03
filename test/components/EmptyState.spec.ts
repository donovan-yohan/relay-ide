import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe('EmptyState', () => {
  const projectRoot = join(__dirname, '../..');
  const componentPath = join(
    projectRoot,
    'frontend/src/components/EmptyState.tsx'
  );
  const cssPath = join(projectRoot, 'frontend/src/components/EmptyState.css');

  it('EmptyState.tsx file exists', () => {
    expect(existsSync(componentPath)).toBeTruthy();
  });

  it('EmptyState.css file exists', () => {
    expect(existsSync(cssPath)).toBeTruthy();
  });

  it('exports EmptyState component', () => {
    const content = readFileSync(componentPath, 'utf-8');
    expect(content.includes('export function EmptyState')).toBeTruthy();
    expect(content.includes('export default EmptyState')).toBeTruthy();
  });

  it('exports EmptyStateProps interface', () => {
    const content = readFileSync(componentPath, 'utf-8');
    expect(content.includes('interface EmptyStateProps')).toBeTruthy();
  });

  it('has required props', () => {
    const content = readFileSync(componentPath, 'utf-8');
    expect(content.includes('heading: string')).toBeTruthy();
    expect(content.includes('icon?:')).toBeTruthy();
    expect(content.includes('description?:')).toBeTruthy();
    expect(content.includes('actionLabel?:')).toBeTruthy();
    expect(content.includes('onAction?:')).toBeTruthy();
  });

  it('imports TuiButton', () => {
    const content = readFileSync(componentPath, 'utf-8');
    expect(content.includes("from './TuiButton'")).toBeTruthy();
  });

  it('imports CSS', () => {
    const content = readFileSync(componentPath, 'utf-8');
    expect(content.includes("import './EmptyState.css'")).toBeTruthy();
  });

  it('CSS has required classes', () => {
    const content = readFileSync(cssPath, 'utf-8');
    expect(content.includes('.empty-state')).toBeTruthy();
    expect(content.includes('.empty-icon')).toBeTruthy();
    expect(content.includes('.empty-heading')).toBeTruthy();
    expect(content.includes('.empty-description')).toBeTruthy();
  });
});

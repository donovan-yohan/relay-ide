import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe('EmptyState', () => {
  const projectRoot = join(__dirname, '../../..');
  const componentPath = join(projectRoot, 'frontend/src/components/EmptyState.tsx');
  const cssPath = join(projectRoot, 'frontend/src/components/EmptyState.css');

  it('EmptyState.tsx file exists', () => {
    assert.ok(existsSync(componentPath), 'EmptyState.tsx should exist');
  });

  it('EmptyState.css file exists', () => {
    assert.ok(existsSync(cssPath), 'EmptyState.css should exist');
  });

  it('exports EmptyState component', () => {
    const content = readFileSync(componentPath, 'utf-8');
    assert.ok(
      content.includes('export function EmptyState'),
      'Should export EmptyState function'
    );
    assert.ok(
      content.includes('export default EmptyState'),
      'Should have default export'
    );
  });

  it('exports EmptyStateProps interface', () => {
    const content = readFileSync(componentPath, 'utf-8');
    assert.ok(
      content.includes('interface EmptyStateProps'),
      'Should define EmptyStateProps interface'
    );
  });

  it('has required props', () => {
    const content = readFileSync(componentPath, 'utf-8');
    assert.ok(
      content.includes('heading: string'),
      'Should have heading prop'
    );
    assert.ok(content.includes('icon?:'), 'Should have optional icon prop');
    assert.ok(
      content.includes('description?:'),
      'Should have optional description prop'
    );
    assert.ok(
      content.includes('actionLabel?:'),
      'Should have optional actionLabel prop'
    );
    assert.ok(
      content.includes('onAction?:'),
      'Should have optional onAction prop'
    );
  });

  it('imports TuiButton', () => {
    const content = readFileSync(componentPath, 'utf-8');
    assert.ok(
      content.includes("from './TuiButton'"),
      'Should import TuiButton'
    );
  });

  it('imports CSS', () => {
    const content = readFileSync(componentPath, 'utf-8');
    assert.ok(
      content.includes("import './EmptyState.css'"),
      'Should import EmptyState.css'
    );
  });

  it('CSS has required classes', () => {
    const content = readFileSync(cssPath, 'utf-8');
    assert.ok(
      content.includes('.empty-state'),
      'Should have .empty-state class'
    );
    assert.ok(
      content.includes('.empty-icon'),
      'Should have .empty-icon class'
    );
    assert.ok(
      content.includes('.empty-heading'),
      'Should have .empty-heading class'
    );
    assert.ok(
      content.includes('.empty-description'),
      'Should have .empty-description class'
    );
  });
});
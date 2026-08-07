// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import WorkspaceEditor, {
  WORKSPACE_EDITOR_DEFAULT_PLACEHOLDERS,
  validateEnvPortVarName,
  validateEnvPortVarNames,
} from '../frontend/src/components/dialogs/WorkspaceEditor.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('WorkspaceEditor env var validation', () => {
  test('validateEnvPortVarName accepts valid names', () => {
    expect(validateEnvPortVarName('PORT')).toBe('');
    expect(validateEnvPortVarName('API_PORT')).toBe('');
  });

  test('validateEnvPortVarName rejects invalid names', () => {
    expect(validateEnvPortVarName('')).toBe('Name cannot be empty');
    expect(validateEnvPortVarName('port')).toContain('Must start');
    expect(validateEnvPortVarName('123PORT')).toContain('Must start');
    expect(validateEnvPortVarName('BAD-NAME')).toContain('Must start');
  });

  test('validateEnvPortVarNames reports invalid and duplicate entries', () => {
    expect(
      validateEnvPortVarNames(['PORT', 'BAD-NAME', 'PORT', 'API_PORT'])
    ).toEqual({
      1: 'Invalid format',
      2: 'Duplicate',
    });
  });
});

describe('<WorkspaceEditor /> default placeholder copy', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function renderEditor() {
    act(() => {
      root.render(
        React.createElement(WorkspaceEditor, {
          values: {
            defaultBranch: '',
            remote: '',
            branchPrefix: '',
            defaultAgent: 'claude',
            portVariables: [],
          },
          onChange: vi.fn(),
          branches: [],
          overriddenKeys: [],
        })
      );
    });
  }

  function inputPlaceholders(): string[] {
    return Array.from(container.querySelectorAll('input, textarea')).map(
      (input) => input.getAttribute('placeholder') ?? ''
    );
  }

  test('shows known defaults instead of example-only settings placeholders', () => {
    renderEditor();

    expect(inputPlaceholders()).toEqual(
      expect.arrayContaining([
        WORKSPACE_EDITOR_DEFAULT_PLACEHOLDERS.remote,
        WORKSPACE_EDITOR_DEFAULT_PLACEHOLDERS.branchPrefix,
        WORKSPACE_EDITOR_DEFAULT_PLACEHOLDERS.portVariable,
      ])
    );

    expect(inputPlaceholders().some((value) => /e\.g\./i.test(value))).toBe(
      false
    );
  });
});

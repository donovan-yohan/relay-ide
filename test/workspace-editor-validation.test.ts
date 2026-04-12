import { describe, expect, test } from 'vitest';
import {
  validateEnvPortVarName,
  validateEnvPortVarNames,
} from '../frontend/src/components/dialogs/WorkspaceEditor.js';

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

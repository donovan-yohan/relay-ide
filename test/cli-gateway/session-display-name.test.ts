import { describe, expect, it } from 'vitest';
import { commandSpec } from '../../shared/cli-gateway-contract.js';
import { validateAndSanitizeGatewayCreateInput } from '../../shared/cli-gateway-runtime.js';

const REPO_CWD = '/home/dev/repo';

describe('sessions.create displayName', () => {
  it('accepts displayName on a local cwd create', () => {
    const result = validateAndSanitizeGatewayCreateInput({
      cwd: REPO_CWD,
      type: 'agent',
      agent: 'codex',
      displayName: 'implementer-codex-1',
    });
    expect(result.ok).toBe(true);
    if (result.ok !== true) return;
    expect(result.input['displayName']).toBe('implementer-codex-1');
  });

  it('rejects a non-string displayName', () => {
    const result = validateAndSanitizeGatewayCreateInput({
      cwd: REPO_CWD,
      type: 'agent',
      displayName: 7,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_ARGUMENT');
  });
});

describe('sessions.create role', () => {
  it('declares the role enum on create input and session descriptors', () => {
    const create = commandSpec('sessions.create');
    expect(create.inputSchema.properties?.['role']?.enum).toContain(
      'orchestrator'
    );
    expect(
      create.outputSchema.properties?.['data']?.properties?.['role']?.enum
    ).toContain('orchestrator');
  });

  it('accepts a known collaboration role', () => {
    const result = validateAndSanitizeGatewayCreateInput({
      cwd: REPO_CWD,
      type: 'agent',
      mode: 'web',
      agent: 'claude',
      role: 'orchestrator',
    });
    expect(result.ok).toBe(true);
    if (result.ok !== true) return;
    expect(result.input['role']).toBe('orchestrator');
  });

  it('rejects an unknown collaboration role', () => {
    const result = validateAndSanitizeGatewayCreateInput({
      cwd: REPO_CWD,
      type: 'agent',
      mode: 'web',
      role: 'manager',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_ARGUMENT');
    expect(result.error.details?.['field']).toBe('role');
  });
});

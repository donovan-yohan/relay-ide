import { describe, expect, it } from 'vitest';
import { commandSpec } from '../../shared/cli-gateway-contract.js';
import { validateAndSanitizeGatewayCreateInput } from '../../shared/cli-gateway-runtime.js';

const REPO_CWD = '/home/dev/repo';

describe('sessions.create displayName', () => {
  it('accepts displayName on a local cwd create', () => {
    const result = validateAndSanitizeGatewayCreateInput({
      cwd: REPO_CWD,
      type: 'terminal',
      displayName: 'implementer-codex-1',
    });
    expect(result.ok).toBe(true);
    if (result.ok !== true) return;
    expect(result.input['displayName']).toBe('implementer-codex-1');
  });

  it('rejects a non-string displayName', () => {
    const result = validateAndSanitizeGatewayCreateInput({
      cwd: REPO_CWD,
      type: 'terminal',
      displayName: 7,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_ARGUMENT');
  });
});

describe('sessions.create retired agent fields', () => {
  it('does not advertise role on terminal create input', () => {
    const create = commandSpec('sessions.create');
    expect(create.inputSchema.properties?.['role']).toBeUndefined();
  });

  it('rejects collaboration roles on terminal creation', () => {
    const result = validateAndSanitizeGatewayCreateInput({
      cwd: REPO_CWD,
      type: 'terminal',
      role: 'orchestrator',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('UNSUPPORTED');
    expect(result.error.details?.['field']).toBe('role');
  });
});

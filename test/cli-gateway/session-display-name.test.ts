import { describe, expect, it } from 'vitest';
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

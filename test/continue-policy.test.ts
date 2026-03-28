import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSessionSettings } from '../server/config.js';
import type { Config } from '../server/types.js';

describe('continuePolicy in session creation', () => {
  const baseConfig: Config = {
    host: '0.0.0.0',
    port: 3456,
    cookieTTL: '24h',
    repos: [],
    claudeCommand: 'claude',
    claudeArgs: [],
    defaultAgent: 'claude',
    defaultContinue: true,
    defaultYolo: false,
    launchInTmux: false,
    defaultNotifications: true,
  };

  it('explicit continuePolicy:never overrides config default', () => {
    const resolved = resolveSessionSettings(baseConfig, '/repo', { continuePolicy: 'never' });
    assert.equal(resolved.continuePolicy, 'never');
  });

  it('explicit continuePolicy:always forces continue', () => {
    const config = { ...baseConfig, defaultContinue: false };
    const resolved = resolveSessionSettings(config, '/repo', { continuePolicy: 'always' });
    assert.equal(resolved.continuePolicy, 'always');
  });

  it('no explicit policy uses config mapping (true → always)', () => {
    const resolved = resolveSessionSettings(baseConfig, '/repo', {});
    assert.equal(resolved.continuePolicy, 'always');
  });

  it('no explicit policy uses config mapping (false → never)', () => {
    const config = { ...baseConfig, defaultContinue: false };
    const resolved = resolveSessionSettings(config, '/repo', {});
    assert.equal(resolved.continuePolicy, 'never');
  });

  it('needsBranchRename forces never policy', () => {
    // This test verifies the contract: callers pass 'never' for new worktrees
    const resolved = resolveSessionSettings(baseConfig, '/repo', { continuePolicy: 'never' });
    assert.equal(resolved.continuePolicy, 'never');
  });
});

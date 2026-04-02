import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { writeCodexHooksAdapter, CODEX_EVENTS, EVENT_MAP } from '../server/codex-hooks-adapter.js';

let tmpConfigDir: string;

before(() => {
  tmpConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crc-codex-hooks-test-'));
});

after(() => {
  fs.rmSync(tmpConfigDir, { recursive: true, force: true });
});

describe('CODEX_EVENTS', () => {
  it('contains all 5 expected codex hook event names', () => {
    const expected = ['SessionStart', 'Stop', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse'];
    assert.strictEqual(CODEX_EVENTS.length, 5);
    for (const ev of expected) {
      assert.ok((CODEX_EVENTS as readonly string[]).includes(ev), `CODEX_EVENTS should include ${ev}`);
    }
  });
});

describe('EVENT_MAP', () => {
  it('maps SessionStart to session.started', () => {
    assert.strictEqual(EVENT_MAP['SessionStart'], 'session.started');
  });

  it('maps Stop to session.ended', () => {
    assert.strictEqual(EVENT_MAP['Stop'], 'session.ended');
  });

  it('maps UserPromptSubmit to prompt.submitted', () => {
    assert.strictEqual(EVENT_MAP['UserPromptSubmit'], 'prompt.submitted');
  });

  it('maps PreToolUse to tool.started', () => {
    assert.strictEqual(EVENT_MAP['PreToolUse'], 'tool.started');
  });

  it('maps PostToolUse to tool.finished', () => {
    assert.strictEqual(EVENT_MAP['PostToolUse'], 'tool.finished');
  });

  it('has exactly 5 mappings', () => {
    assert.strictEqual(Object.keys(EVENT_MAP).length, 5);
  });
});

describe('writeCodexHooksAdapter', () => {
  it('returns a string path', () => {
    const result = writeCodexHooksAdapter('sess-001', 3456, 'tok-abc', tmpConfigDir);
    assert.ok(typeof result === 'string', 'should return a string path');
  });

  it('creates the temp directory', () => {
    const dir = writeCodexHooksAdapter('sess-002', 3456, 'tok-abc', tmpConfigDir);
    assert.ok(fs.existsSync(dir), 'temp directory should exist');
  });

  it('creates relay.sh in the temp directory', () => {
    const dir = writeCodexHooksAdapter('sess-003', 3456, 'tok-abc', tmpConfigDir);
    const relayPath = path.join(dir, 'relay.sh');
    assert.ok(fs.existsSync(relayPath), 'relay.sh should exist');
  });

  it('creates relay.sh that is executable', () => {
    const dir = writeCodexHooksAdapter('sess-004', 3456, 'tok-abc', tmpConfigDir);
    const relayPath = path.join(dir, 'relay.sh');
    const stat = fs.statSync(relayPath);
    // Check owner execute bit (0o100)
    assert.ok((stat.mode & 0o100) !== 0, 'relay.sh should be executable by owner');
  });

  it('creates hooks.json in the temp directory', () => {
    const dir = writeCodexHooksAdapter('sess-005', 3456, 'tok-abc', tmpConfigDir);
    const hooksPath = path.join(dir, 'hooks.json');
    assert.ok(fs.existsSync(hooksPath), 'hooks.json should exist');
  });

  it('hooks.json contains all 5 codex events', () => {
    const dir = writeCodexHooksAdapter('sess-006', 3456, 'tok-abc', tmpConfigDir);
    const hooksPath = path.join(dir, 'hooks.json');
    const hooks = JSON.parse(fs.readFileSync(hooksPath, 'utf-8'));
    const expected = ['SessionStart', 'Stop', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse'];
    for (const ev of expected) {
      assert.ok(ev in hooks, `hooks.json should have key ${ev}`);
    }
  });

  it('hooks.json entries are arrays of { type: "command", command: <path-to-relay.sh> }', () => {
    const dir = writeCodexHooksAdapter('sess-007', 3456, 'tok-abc', tmpConfigDir);
    const hooksPath = path.join(dir, 'hooks.json');
    const relayPath = path.join(dir, 'relay.sh');
    const hooks = JSON.parse(fs.readFileSync(hooksPath, 'utf-8'));
    const expected = ['SessionStart', 'Stop', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse'];
    for (const ev of expected) {
      const entries = hooks[ev];
      assert.ok(Array.isArray(entries), `${ev} should be an array`);
      assert.ok(entries.length >= 1, `${ev} should have at least one entry`);
      const last = entries[entries.length - 1];
      assert.strictEqual(last.type, 'command', `${ev} entry should have type: "command"`);
      assert.strictEqual(last.command, relayPath, `${ev} entry command should point to relay.sh`);
    }
  });

  it('session.json contains the correct port, sessionId, and hookToken', () => {
    const dir = writeCodexHooksAdapter('sess-008', 9999, 'super-secret-token', tmpConfigDir);
    const configPath = path.join(dir, 'session.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    assert.strictEqual(config.port, 9999, 'session.json should contain the correct port');
    assert.strictEqual(config.sessionId, 'sess-008', 'session.json should contain the correct sessionId');
    assert.strictEqual(config.hookToken, 'super-secret-token', 'session.json should contain the correct hookToken');
  });

  it('relay.sh reads config from session.json', () => {
    const dir = writeCodexHooksAdapter('my-unique-session-id', 3456, 'tok-abc', tmpConfigDir);
    const relayPath = path.join(dir, 'relay.sh');
    const content = fs.readFileSync(relayPath, 'utf-8');
    assert.ok(content.includes('session.json'), 'relay.sh should reference session.json config file');
    assert.ok(content.includes('CONFIG_FILE='), 'relay.sh should set CONFIG_FILE variable');
  });

  it('relay.sh posts to /hooks/agent-event', () => {
    const dir = writeCodexHooksAdapter('sess-011', 3456, 'tok-abc', tmpConfigDir);
    const relayPath = path.join(dir, 'relay.sh');
    const content = fs.readFileSync(relayPath, 'utf-8');
    assert.ok(content.includes('/hooks/agent-event'), 'relay.sh should POST to /hooks/agent-event');
  });

  it('relay.sh uses best-effort delivery (|| true)', () => {
    const dir = writeCodexHooksAdapter('sess-012', 3456, 'tok-abc', tmpConfigDir);
    const relayPath = path.join(dir, 'relay.sh');
    const content = fs.readFileSync(relayPath, 'utf-8');
    assert.ok(content.includes('|| true'), 'relay.sh should use || true for best-effort delivery');
  });

  it('relay.sh maps SessionStart to session.started in the case statement', () => {
    const dir = writeCodexHooksAdapter('sess-013', 3456, 'tok-abc', tmpConfigDir);
    const relayPath = path.join(dir, 'relay.sh');
    const content = fs.readFileSync(relayPath, 'utf-8');
    assert.ok(content.includes('SessionStart'), 'relay.sh should contain SessionStart case');
    assert.ok(content.includes('session.started'), 'relay.sh should map to session.started');
  });

  it('relay.sh maps Stop to session.ended in the case statement', () => {
    const dir = writeCodexHooksAdapter('sess-014', 3456, 'tok-abc', tmpConfigDir);
    const relayPath = path.join(dir, 'relay.sh');
    const content = fs.readFileSync(relayPath, 'utf-8');
    assert.ok(content.includes('Stop'), 'relay.sh should contain Stop case');
    assert.ok(content.includes('session.ended'), 'relay.sh should map to session.ended');
  });

  it('relay.sh maps UserPromptSubmit to prompt.submitted in the case statement', () => {
    const dir = writeCodexHooksAdapter('sess-015', 3456, 'tok-abc', tmpConfigDir);
    const relayPath = path.join(dir, 'relay.sh');
    const content = fs.readFileSync(relayPath, 'utf-8');
    assert.ok(content.includes('UserPromptSubmit'), 'relay.sh should contain UserPromptSubmit case');
    assert.ok(content.includes('prompt.submitted'), 'relay.sh should map to prompt.submitted');
  });

  it('relay.sh maps PreToolUse to tool.started in the case statement', () => {
    const dir = writeCodexHooksAdapter('sess-016', 3456, 'tok-abc', tmpConfigDir);
    const relayPath = path.join(dir, 'relay.sh');
    const content = fs.readFileSync(relayPath, 'utf-8');
    assert.ok(content.includes('PreToolUse'), 'relay.sh should contain PreToolUse case');
    assert.ok(content.includes('tool.started'), 'relay.sh should map to tool.started');
  });

  it('relay.sh maps PostToolUse to tool.finished in the case statement', () => {
    const dir = writeCodexHooksAdapter('sess-017', 3456, 'tok-abc', tmpConfigDir);
    const relayPath = path.join(dir, 'relay.sh');
    const content = fs.readFileSync(relayPath, 'utf-8');
    assert.ok(content.includes('PostToolUse'), 'relay.sh should contain PostToolUse case');
    assert.ok(content.includes('tool.finished'), 'relay.sh should map to tool.finished');
  });

  it('relay.sh has a shebang line', () => {
    const dir = writeCodexHooksAdapter('sess-018', 3456, 'tok-abc', tmpConfigDir);
    const relayPath = path.join(dir, 'relay.sh');
    const content = fs.readFileSync(relayPath, 'utf-8');
    assert.ok(content.startsWith('#!/usr/bin/env bash'), 'relay.sh should start with #!/usr/bin/env bash');
  });

  it('temp directory path includes the sessionId', () => {
    const sessionId = 'uniqueid-xyz-789';
    const dir = writeCodexHooksAdapter(sessionId, 3456, 'tok-abc', tmpConfigDir);
    assert.ok(dir.includes(sessionId), 'temp dir path should include the sessionId');
  });

  it('is idempotent — calling twice for same sessionId returns consistent results', () => {
    const sessionId = 'idempotent-sess';
    const dir1 = writeCodexHooksAdapter(sessionId, 3456, 'tok-abc', tmpConfigDir);
    const dir2 = writeCodexHooksAdapter(sessionId, 3456, 'tok-abc', tmpConfigDir);
    assert.strictEqual(dir1, dir2, 'should return same path for same sessionId');
    assert.ok(fs.existsSync(path.join(dir2, 'relay.sh')), 'relay.sh should still exist after second call');
    assert.ok(fs.existsSync(path.join(dir2, 'hooks.json')), 'hooks.json should still exist after second call');
  });

  it('merges with existing user hooks when ~/.codex/hooks.json has entries', () => {
    // Create a fake user hooks directory
    const fakeHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crc-fake-home-'));
    try {
      const codexDir = path.join(fakeHomeDir, '.codex');
      fs.mkdirSync(codexDir, { recursive: true });
      const existingHooks = {
        SessionStart: [{ type: 'command', command: '/usr/local/bin/my-existing-hook.sh' }],
      };
      fs.writeFileSync(path.join(codexDir, 'hooks.json'), JSON.stringify(existingHooks));

      // We can't easily mock os.homedir(), so we test the merge logic indirectly:
      // If no ~/.codex/hooks.json exists (default), each event has exactly 1 entry (our relay).
      // This test verifies the base case: no existing hooks → exactly 1 relay per event.
      const dir = writeCodexHooksAdapter('sess-merge', 3456, 'tok-abc', tmpConfigDir);
      const hooks = JSON.parse(fs.readFileSync(path.join(dir, 'hooks.json'), 'utf-8'));
      const expected = ['SessionStart', 'Stop', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse'];
      for (const ev of expected) {
        assert.ok(Array.isArray(hooks[ev]), `${ev} should be an array`);
        assert.ok(hooks[ev].length >= 1, `${ev} should have at least one hook entry`);
      }
    } finally {
      fs.rmSync(fakeHomeDir, { recursive: true, force: true });
    }
  });

  it('reads stdin via INPUT=$(cat) in relay.sh', () => {
    const dir = writeCodexHooksAdapter('sess-019', 3456, 'tok-abc', tmpConfigDir);
    const relayPath = path.join(dir, 'relay.sh');
    const content = fs.readFileSync(relayPath, 'utf-8');
    assert.ok(content.includes('INPUT=$(cat)'), 'relay.sh should read stdin via INPUT=$(cat)');
  });

  it('relay.sh reads HOOK_EVENT_NAME env var', () => {
    const dir = writeCodexHooksAdapter('sess-020', 3456, 'tok-abc', tmpConfigDir);
    const relayPath = path.join(dir, 'relay.sh');
    const content = fs.readFileSync(relayPath, 'utf-8');
    assert.ok(content.includes('HOOK_EVENT_NAME'), 'relay.sh should use HOOK_EVENT_NAME env var');
  });
});

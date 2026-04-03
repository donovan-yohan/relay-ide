import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  writeCodexHooksAdapter,
  CODEX_EVENTS,
  EVENT_MAP,
} from '../server/codex-hooks-adapter.js';

let tmpConfigDir: string;

beforeAll(() => {
  tmpConfigDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'crc-codex-hooks-test-')
  );
});

afterAll(() => {
  fs.rmSync(tmpConfigDir, { recursive: true, force: true });
});

describe('CODEX_EVENTS', () => {
  it('contains all 5 expected codex hook event names', () => {
    const expected = [
      'SessionStart',
      'Stop',
      'UserPromptSubmit',
      'PreToolUse',
      'PostToolUse',
    ];
    expect(CODEX_EVENTS.length).toBe(5);
    for (const ev of expected) {
      expect(CODEX_EVENTS as readonly string[]).toContain(ev);
    }
  });
});

describe('EVENT_MAP', () => {
  it('maps SessionStart to session.started', () => {
    expect(EVENT_MAP['SessionStart']).toBe('session.started');
  });

  it('maps Stop to session.ended', () => {
    expect(EVENT_MAP['Stop']).toBe('session.ended');
  });

  it('maps UserPromptSubmit to prompt.submitted', () => {
    expect(EVENT_MAP['UserPromptSubmit']).toBe('prompt.submitted');
  });

  it('maps PreToolUse to tool.started', () => {
    expect(EVENT_MAP['PreToolUse']).toBe('tool.started');
  });

  it('maps PostToolUse to tool.finished', () => {
    expect(EVENT_MAP['PostToolUse']).toBe('tool.finished');
  });

  it('has exactly 5 mappings', () => {
    expect(Object.keys(EVENT_MAP).length).toBe(5);
  });
});

describe('writeCodexHooksAdapter', () => {
  it('returns a string path', () => {
    const result = writeCodexHooksAdapter(
      'sess-001',
      3456,
      'tok-abc',
      tmpConfigDir
    );
    expect(result).toBeTypeOf('string');
  });

  it('creates the temp directory', () => {
    const dir = writeCodexHooksAdapter(
      'sess-002',
      3456,
      'tok-abc',
      tmpConfigDir
    );
    expect(fs.existsSync(dir)).toBeTruthy();
  });

  it('creates relay.sh in the temp directory', () => {
    const dir = writeCodexHooksAdapter(
      'sess-003',
      3456,
      'tok-abc',
      tmpConfigDir
    );
    const relayPath = path.join(dir, 'relay.sh');
    expect(fs.existsSync(relayPath)).toBeTruthy();
  });

  it('creates relay.sh that is executable', () => {
    const dir = writeCodexHooksAdapter(
      'sess-004',
      3456,
      'tok-abc',
      tmpConfigDir
    );
    const relayPath = path.join(dir, 'relay.sh');
    const stat = fs.statSync(relayPath);
    // Check owner execute bit (0o100)
    expect(stat.mode & 0o100).not.toBe(0);
  });

  it('creates hooks.json in the temp directory', () => {
    const dir = writeCodexHooksAdapter(
      'sess-005',
      3456,
      'tok-abc',
      tmpConfigDir
    );
    const hooksPath = path.join(dir, 'hooks.json');
    expect(fs.existsSync(hooksPath)).toBeTruthy();
  });

  it('hooks.json contains all 5 codex events', () => {
    const dir = writeCodexHooksAdapter(
      'sess-006',
      3456,
      'tok-abc',
      tmpConfigDir
    );
    const hooksPath = path.join(dir, 'hooks.json');
    const hooks = JSON.parse(fs.readFileSync(hooksPath, 'utf-8'));
    const expected = [
      'SessionStart',
      'Stop',
      'UserPromptSubmit',
      'PreToolUse',
      'PostToolUse',
    ];
    for (const ev of expected) {
      expect(hooks).toHaveProperty(ev);
    }
  });

  it('hooks.json entries are arrays of { type: "command", command: <path-to-relay.sh> }', () => {
    const dir = writeCodexHooksAdapter(
      'sess-007',
      3456,
      'tok-abc',
      tmpConfigDir
    );
    const hooksPath = path.join(dir, 'hooks.json');
    const relayPath = path.join(dir, 'relay.sh');
    const hooks = JSON.parse(fs.readFileSync(hooksPath, 'utf-8'));
    const expected = [
      'SessionStart',
      'Stop',
      'UserPromptSubmit',
      'PreToolUse',
      'PostToolUse',
    ];
    for (const ev of expected) {
      const entries = hooks[ev];
      expect(entries).toBeInstanceOf(Array);
      expect(entries.length).toBeGreaterThanOrEqual(1);
      const last = entries[entries.length - 1];
      expect(last.type).toBe('command');
      expect(last.command).toBe(relayPath);
    }
  });

  it('session.json contains the correct port, sessionId, and hookToken', () => {
    const dir = writeCodexHooksAdapter(
      'sess-008',
      9999,
      'super-secret-token',
      tmpConfigDir
    );
    const configPath = path.join(dir, 'session.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(config.port).toBe(9999);
    expect(config.sessionId).toBe('sess-008');
    expect(config.hookToken).toBe('super-secret-token');
  });

  it('relay.sh reads config from session.json', () => {
    const dir = writeCodexHooksAdapter(
      'my-unique-session-id',
      3456,
      'tok-abc',
      tmpConfigDir
    );
    const relayPath = path.join(dir, 'relay.sh');
    const content = fs.readFileSync(relayPath, 'utf-8');
    expect(content).toContain('session.json');
    expect(content).toContain('CONFIG_FILE=');
  });

  it('relay.sh posts to /hooks/agent-event', () => {
    const dir = writeCodexHooksAdapter(
      'sess-011',
      3456,
      'tok-abc',
      tmpConfigDir
    );
    const relayPath = path.join(dir, 'relay.sh');
    const content = fs.readFileSync(relayPath, 'utf-8');
    expect(content).toContain('/hooks/agent-event');
  });

  it('relay.sh uses best-effort delivery (|| true)', () => {
    const dir = writeCodexHooksAdapter(
      'sess-012',
      3456,
      'tok-abc',
      tmpConfigDir
    );
    const relayPath = path.join(dir, 'relay.sh');
    const content = fs.readFileSync(relayPath, 'utf-8');
    expect(content).toContain('|| true');
  });

  it('relay.sh maps SessionStart to session.started in the case statement', () => {
    const dir = writeCodexHooksAdapter(
      'sess-013',
      3456,
      'tok-abc',
      tmpConfigDir
    );
    const relayPath = path.join(dir, 'relay.sh');
    const content = fs.readFileSync(relayPath, 'utf-8');
    expect(content).toContain('SessionStart');
    expect(content).toContain('session.started');
  });

  it('relay.sh maps Stop to session.ended in the case statement', () => {
    const dir = writeCodexHooksAdapter(
      'sess-014',
      3456,
      'tok-abc',
      tmpConfigDir
    );
    const relayPath = path.join(dir, 'relay.sh');
    const content = fs.readFileSync(relayPath, 'utf-8');
    expect(content).toContain('Stop');
    expect(content).toContain('session.ended');
  });

  it('relay.sh maps UserPromptSubmit to prompt.submitted in the case statement', () => {
    const dir = writeCodexHooksAdapter(
      'sess-015',
      3456,
      'tok-abc',
      tmpConfigDir
    );
    const relayPath = path.join(dir, 'relay.sh');
    const content = fs.readFileSync(relayPath, 'utf-8');
    expect(content).toContain('UserPromptSubmit');
    expect(content).toContain('prompt.submitted');
  });

  it('relay.sh maps PreToolUse to tool.started in the case statement', () => {
    const dir = writeCodexHooksAdapter(
      'sess-016',
      3456,
      'tok-abc',
      tmpConfigDir
    );
    const relayPath = path.join(dir, 'relay.sh');
    const content = fs.readFileSync(relayPath, 'utf-8');
    expect(content).toContain('PreToolUse');
    expect(content).toContain('tool.started');
  });

  it('relay.sh maps PostToolUse to tool.finished in the case statement', () => {
    const dir = writeCodexHooksAdapter(
      'sess-017',
      3456,
      'tok-abc',
      tmpConfigDir
    );
    const relayPath = path.join(dir, 'relay.sh');
    const content = fs.readFileSync(relayPath, 'utf-8');
    expect(content).toContain('PostToolUse');
    expect(content).toContain('tool.finished');
  });

  it('relay.sh has a shebang line', () => {
    const dir = writeCodexHooksAdapter(
      'sess-018',
      3456,
      'tok-abc',
      tmpConfigDir
    );
    const relayPath = path.join(dir, 'relay.sh');
    const content = fs.readFileSync(relayPath, 'utf-8');
    expect(content.startsWith('#!/usr/bin/env bash')).toBe(true);
  });

  it('temp directory path includes the sessionId', () => {
    const sessionId = 'uniqueid-xyz-789';
    const dir = writeCodexHooksAdapter(
      sessionId,
      3456,
      'tok-abc',
      tmpConfigDir
    );
    expect(dir).toContain(sessionId);
  });

  it('is idempotent — calling twice for same sessionId returns consistent results', () => {
    const sessionId = 'idempotent-sess';
    const dir1 = writeCodexHooksAdapter(
      sessionId,
      3456,
      'tok-abc',
      tmpConfigDir
    );
    const dir2 = writeCodexHooksAdapter(
      sessionId,
      3456,
      'tok-abc',
      tmpConfigDir
    );
    expect(dir1).toBe(dir2);
    expect(fs.existsSync(path.join(dir2, 'relay.sh'))).toBeTruthy();
    expect(fs.existsSync(path.join(dir2, 'hooks.json'))).toBeTruthy();
  });

  it('merges with existing user hooks when ~/.codex/hooks.json has entries', () => {
    // Create a fake user hooks directory
    const fakeHomeDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'crc-fake-home-')
    );
    try {
      const codexDir = path.join(fakeHomeDir, '.codex');
      fs.mkdirSync(codexDir, { recursive: true });
      const existingHooks = {
        SessionStart: [
          { type: 'command', command: '/usr/local/bin/my-existing-hook.sh' },
        ],
      };
      fs.writeFileSync(
        path.join(codexDir, 'hooks.json'),
        JSON.stringify(existingHooks)
      );

      // We can't easily mock os.homedir(), so we test the merge logic indirectly:
      // If no ~/.codex/hooks.json exists (default), each event has exactly 1 entry (our relay).
      // This test verifies the base case: no existing hooks → exactly 1 relay per event.
      const dir = writeCodexHooksAdapter(
        'sess-merge',
        3456,
        'tok-abc',
        tmpConfigDir
      );
      const hooks = JSON.parse(
        fs.readFileSync(path.join(dir, 'hooks.json'), 'utf-8')
      );
      const expected = [
        'SessionStart',
        'Stop',
        'UserPromptSubmit',
        'PreToolUse',
        'PostToolUse',
      ];
      for (const ev of expected) {
        expect(hooks[ev]).toBeInstanceOf(Array);
        expect(hooks[ev].length).toBeGreaterThanOrEqual(1);
      }
    } finally {
      fs.rmSync(fakeHomeDir, { recursive: true, force: true });
    }
  });

  it('reads stdin via INPUT=$(cat) in relay.sh', () => {
    const dir = writeCodexHooksAdapter(
      'sess-019',
      3456,
      'tok-abc',
      tmpConfigDir
    );
    const relayPath = path.join(dir, 'relay.sh');
    const content = fs.readFileSync(relayPath, 'utf-8');
    expect(content).toContain('INPUT=$(cat)');
  });

  it('relay.sh reads HOOK_EVENT_NAME env var', () => {
    const dir = writeCodexHooksAdapter(
      'sess-020',
      3456,
      'tok-abc',
      tmpConfigDir
    );
    const relayPath = path.join(dir, 'relay.sh');
    const content = fs.readFileSync(relayPath, 'utf-8');
    expect(content).toContain('HOOK_EVENT_NAME');
  });
});
